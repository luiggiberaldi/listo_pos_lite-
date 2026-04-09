import { useEffect, useRef } from 'react';
import localforage from 'localforage';
import { supabaseCloud } from '../config/supabaseCloud';
import { storageService } from '../utils/storageService';
import { useAuthStore } from './store/useAuthStore';

// Exportado para que SettingsView pueda enviar el broadcast antes de hacer signOut
export const broadcastFactoryReset = async (userId) => {
    try {
        const ch = supabaseCloud.channel(`factory-reset-${userId}`);
        await ch.subscribe();
        await ch.send({ type: 'broadcast', event: 'factory_reset', payload: {} });
        // Pequeña pausa para que el mensaje llegue antes de continuar
        await new Promise(r => setTimeout(r, 800));
        supabaseCloud.removeChannel(ch);
    } catch (e) {
        console.warn('[CloudSync] No se pudo broadcast factory_reset:', e.message);
    }
};

const SYNC_KEYS = [
    // ── IndexedDB (store) ──────────────────────────────────────────────────
    'bodega_products_v1',
    'bodega_customers_v1',
    'bodega_sales_v1',
    'bodega_payment_methods_v1',
    'bodega_accounts_v2',
    'abasto_audit_log_v1',
    'my_categories_v1',           // Categorías de productos
    'bodega_suppliers_v1',        // Proveedores
    'bodega_supplier_invoices_v1',// Facturas de proveedores
    // ── localStorage (local) ──────────────────────────────────────────────
    'abasto-auth-storage',        // Usuarios, PINs, roles
    'monitor_rates_v12',
    'bodega_custom_rate',
    'bodega_use_auto_rate',
    'tasa_cop',
    'cop_enabled',
    'auto_cop_enabled',
    // ── Configuración del negocio (localStorage) ──────────────────────────
    'cashea_enabled',
    'business_address',
    'business_phone',
    'business_instagram',
    'admin_auto_lock_minutes',
    'theme',
    'catalog_show_cash_price',
    'catalog_custom_usdt_price',
    'catalog_use_auto_usdt',
    'street_rate_bs',
    'printer_paper_width',
];

// Llaves que van a colección 'local' (localStorage); el resto va a 'store' (IndexedDB)
const LOCAL_KEYS = [
    'abasto-auth-storage',
    'monitor_rates_v12',
    'bodega_custom_rate',
    'bodega_use_auto_rate',
    'tasa_cop',
    'cop_enabled',
    'auto_cop_enabled',
    'cashea_enabled',
    'business_address',
    'business_phone',
    'business_instagram',
    'admin_auto_lock_minutes',
    'theme',
    'catalog_show_cash_price',
    'catalog_custom_usdt_price',
    'catalog_use_auto_usdt',
    'street_rate_bs',
    'printer_paper_width',
];

// ─── Realtime selectivo ────────────────────────────────────────────────────
// Solo llaves pequeñas (<1KB) van por Realtime para multi-dispositivo instantáneo.
// Datos pesados (productos, ventas, clientes) siguen con polling cada 5 min.
const REALTIME_KEYS = [
    'monitor_rates_v12',
    'bodega_custom_rate',
    'bodega_use_auto_rate',
    'tasa_cop',
    'cop_enabled',
    'auto_cop_enabled',
    'cashea_enabled',
    'business_address',
    'business_phone',
    'business_instagram',
    'admin_auto_lock_minutes',
    'theme',
    'catalog_show_cash_price',
    'catalog_custom_usdt_price',
    'catalog_use_auto_usdt',
    'street_rate_bs',
    'printer_paper_width',
];

// Llaves pesadas — solo polling (evita egreso masivo por Realtime)
const POLLING_ONLY_KEYS = SYNC_KEYS.filter(k => !REALTIME_KEYS.includes(k));

// ─── Estado Global del Motor ───────────────────────────────────────────────
let pollIntervalId = null;
let realtimeChannel = null;     // Canal Realtime para tasas/config (payloads pequeños)
// Intentional module-level singletons: shared across all hook instances to
// coordinate cloud-sync echo prevention and debounce timers.
let isSyncingFromCloud = false; // true mientras aplicamos cambios de la nube → evita eco
let pendingPush = {};           // Debounce: { [key]: timeoutId }
let lastSyncTime = null;        // Timestamp del último pull exitoso

// Keep a reference to the native setItem for _applyFromCloud to bypass any interceptor
const _nativeSetItem = localStorage.setItem.bind(localStorage);

// Cache de hashes para evitar resubir datos idénticos (reduce egreso ~60%)
const _lastPushHash = {};

function _debouncePush(key, value) {
    if (pendingPush[key]) clearTimeout(pendingPush[key]);
    pendingPush[key] = setTimeout(() => {
        delete pendingPush[key];
        pushCloudSync(key, value).catch(() => {});
    }, 2000); // 2s debounce — agrupa cambios rápidos antes de enviar a la nube
}

/**
 * Empuja una llave al sincronizador de Supabase.
 * Llamado desde storageService (colección 'store') y el interceptor localStorage (colección 'local').
 */
export const pushCloudSync = async (key, value) => {
    if (isSyncingFromCloud) return;          // Nunca re-emitir lo que llegó de la nube
    if (!SYNC_KEYS.includes(key)) return;

    try {
        // Seguridad: eliminar adminPassword antes de sincronizar auth-storage a la nube
        let sanitizedValue = value;
        if (key === 'abasto-auth-storage') {
            try {
                const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                if (parsed?.state?.adminPassword) {
                    sanitizedValue = JSON.parse(JSON.stringify(parsed));
                    delete sanitizedValue.state.adminPassword;
                }
            } catch { }
        }

        // Deduplicación: generar hash rápido del payload para no resubir datos idénticos.
        const serialized = typeof sanitizedValue === 'string' ? sanitizedValue : JSON.stringify(sanitizedValue);
        const hash = serialized.length + ':' + serialized.slice(0, 100) + serialized.slice(-100);
        if (_lastPushHash[key] === hash) return; // Sin cambios reales → skip
        // NOTA: hash se actualiza DESPUÉS del push exitoso para garantizar reintentos si falla

        const { data: { session } } = await supabaseCloud.auth.getSession();
        if (!session?.user?.id) return;

        const collectionType = LOCAL_KEYS.includes(key) ? 'local' : 'store';

        await supabaseCloud.from('sync_documents').upsert({
            user_id: session.user.id,
            collection: collectionType,
            doc_id: key,
            data: { payload: sanitizedValue },
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,collection,doc_id' });

        // Solo marcar como enviado si el push fue exitoso
        _lastPushHash[key] = hash;

    } catch (e) {
        console.warn('[CloudSync] Error al enviar a la nube:', e.message ?? e);
    }
};

/**
 * Aplica un documento recibido de la nube al almacenamiento local.
 * Garantiza que isSyncingFromCloud esté activo durante toda la operación.
 * Si cloudUpdatedAt se provee, verifica que sea más reciente que el timestamp local
 * para evitar sobreescribir cambios locales con datos desactualizados de la nube.
 */
async function _applyFromCloud(docId, collection, payload, cloudUpdatedAt) {
    // Protección contra sobreescritura: no aplicar si local es más reciente que la nube
    if (cloudUpdatedAt) {
        try {
            const localTs = localStorage.getItem('_sync_local_ts_' + docId);
            if (localTs && localTs > cloudUpdatedAt) {
                console.log(`[CloudSync] Skip ${docId}: local (${localTs}) más reciente que nube (${cloudUpdatedAt}). Resubiendo...`);
                // Re-subir los datos locales a la nube ya que son más nuevos
                const { default: lf } = await import('localforage');
                lf.config({ name: 'BodegaApp', storeName: 'bodega_app_data' });
                const localData = await lf.getItem(docId);
                if (localData !== null) {
                    // Forzar push limpiando el hash para que no sea filtrado por deduplicación
                    delete _lastPushHash[docId];
                    pushCloudSync(docId, localData).catch(() => {});
                }
                return;
            }
        } catch(e) { /* Si falla la comparación, aplicar de todas formas */ }
    }

    isSyncingFromCloud = true;
    try {
        if (collection === 'local') {
            let finalPayload = payload;

            // abasto-auth-storage: the cloud copy has adminPassword stripped for security.
            // Preserve the local credentials so isCloudConfigured stays true.
            if (docId === 'abasto-auth-storage') {
                try {
                    const incoming = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(JSON.stringify(payload));
                    const existingRaw = localStorage.getItem('abasto-auth-storage');
                    if (existingRaw) {
                        const existing = JSON.parse(existingRaw);
                        if (existing?.state?.adminPassword && !incoming?.state?.adminPassword) {
                            incoming.state.adminPassword = existing.state.adminPassword;
                        }
                        if (existing?.state?.adminEmail && !incoming?.state?.adminEmail) {
                            incoming.state.adminEmail = existing.state.adminEmail;
                        }
                    }
                    finalPayload = incoming;
                } catch { /* keep original payload on parse error */ }
            }

            const stringPayload = typeof finalPayload === 'string' ? finalPayload : JSON.stringify(finalPayload);
            _nativeSetItem(docId, stringPayload);   // Escribe sin pasar por el interceptor
            window.dispatchEvent(new StorageEvent('storage', {
                key: docId,
                newValue: stringPayload,
                storageArea: localStorage
            }));
            if (docId === 'abasto-auth-storage') {
                useAuthStore.persist.rehydrate();
            }
        } else {
            // Colección 'store' → IndexedDB directo, sin pasar por storageService.setItem
            const { default: localforage } = await import('localforage');
            localforage.config({ name: 'BodegaApp', storeName: 'bodega_app_data' });
            await localforage.setItem(docId, payload);

            // Notificar a los componentes React que lean este store
            window.dispatchEvent(new CustomEvent('app_storage_update', { detail: { key: docId } }));
        }
    } finally {
        isSyncingFromCloud = false;
    }
}

// ─── Hook de React ─────────────────────────────────────────────────────────
export function useCloudSync() {
    const adminEmail = useAuthStore(s => s.adminEmail);
    const adminPassword = useAuthStore(s => s.adminPassword);
    const isCloudConfigured = Boolean(adminEmail);
    const isInitialized = useRef(false);

    useEffect(() => {
        // Interceptor de localStorage — solo para llaves 'local'
        const originalSetItem = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
            originalSetItem(key, value);
            if (!isSyncingFromCloud && LOCAL_KEYS.includes(key)) {
                _debouncePush(key, value);
            }
        };

        if (!isCloudConfigured) {
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
                isInitialized.current = false;
                lastSyncTime = null;
            }
            if (realtimeChannel) {
                supabaseCloud.removeChannel(realtimeChannel);
                realtimeChannel = null;
            }
            return () => { localStorage.setItem = originalSetItem; };
        }

        if (isInitialized.current) return () => { localStorage.setItem = originalSetItem; };

        const initSync = async () => {
            try {
                let session = (await supabaseCloud.auth.getSession()).data.session;

                if (!session?.user?.id) return;

                isInitialized.current = true;
                const userId = session.user.id;

                // ── Pull Inicial: descarga todos los documentos ──────────────
                // Saltarse si acaba de hacerse una importación local (el flag evita que
                // Supabase sobreescriba los datos recién importados).
                const skipPull = sessionStorage.getItem('skip_cloud_pull');
                if (skipPull) {
                    sessionStorage.removeItem('skip_cloud_pull');
                    console.log('[CloudSync] Pull inicial omitido (importación reciente).');
                } else {
                    const { data: docs } = await supabaseCloud
                        .from('sync_documents')
                        .select('collection, doc_id, data, updated_at')
                        .in('collection', ['store', 'local']);

                    if (docs?.length > 0) {
                        for (const doc of docs) {
                            await _applyFromCloud(doc.doc_id, doc.collection, doc.data.payload, doc.updated_at);
                        }
                        console.log(`[CloudSync] Pull inicial: ${docs.length} documentos procesados.`);
                    }
                }

                lastSyncTime = new Date().toISOString();

                // ── Catch-up push: subir datos locales que la nube no tiene ──
                // Asegura que claves recién agregadas al sync (ej. categorías, proveedores,
                // config) queden en Supabase aunque nunca hayan sido modificadas en este
                // dispositivo desde que se activó el sync.
                // El hash deduplication evita resubir lo que ya está igual en la nube.
                (async () => {
                    const { default: lf } = await import('localforage');
                    lf.config({ name: 'BodegaApp', storeName: 'bodega_app_data' });
                    for (const key of SYNC_KEYS) {
                        if (LOCAL_KEYS.includes(key)) {
                            const val = localStorage.getItem(key);
                            if (val != null) pushCloudSync(key, val).catch(() => {});
                        } else {
                            const val = await lf.getItem(key);
                            if (val != null) pushCloudSync(key, val).catch(() => {});
                        }
                        // Pausa entre keys para no saturar Supabase con burst
                        await new Promise(r => setTimeout(r, 120));
                    }
                })().catch(() => {});

                // ── Listener de Factory Reset remoto ─────────────────────────
                // Si otro dispositivo con la misma cuenta hace factory reset,
                // este equipo también limpia y recarga.
                supabaseCloud.channel(`factory-reset-${userId}`)
                    .on('broadcast', { event: 'factory_reset' }, async () => {
                        console.log('[CloudSync] Factory reset remoto recibido — limpiando...');
                        await localforage.clear();
                        try {
                            const oldStore = localforage.createInstance({ name: 'TasasAlDiaApp', storeName: 'app_data' });
                            await oldStore.clear();
                        } catch (e) { /* ignorar */ }
                        localStorage.clear();
                        try {
                            if ('caches' in window) {
                                const cacheKeys = await caches.keys();
                                await Promise.all(cacheKeys.map(k => caches.delete(k)));
                            }
                            if ('serviceWorker' in navigator) {
                                const regs = await navigator.serviceWorker.getRegistrations();
                                await Promise.all(regs.map(r => r.unregister()));
                            }
                        } catch (e) { /* ignorar */ }
                        window.location.reload();
                    })
                    .subscribe();

                // ── Realtime: solo tasas y config (payloads <1KB) ─────────────
                // Esto permite que 2 dispositivos con la misma cuenta vean
                // cambios de tasa instantáneamente sin egreso significativo.
                if (!realtimeChannel) {
                    realtimeChannel = supabaseCloud
                        .channel('sync-rates')
                        .on(
                            'postgres_changes',
                            {
                                event: 'UPDATE',
                                schema: 'public',
                                table: 'sync_documents',
                                filter: `user_id=eq.${userId}`
                            },
                            async (payload) => {
                                if (isSyncingFromCloud) return;
                                const { doc_id, collection, data } = payload.new;
                                // Solo procesar llaves de Realtime (tasas/config)
                                if (!REALTIME_KEYS.includes(doc_id)) return;
                                console.log(`[CloudSync] Realtime: ${doc_id} actualizado`);
                                await _applyFromCloud(doc_id, collection, data.payload);
                            }
                        )
                        .subscribe((status) => {
                            console.log(`[CloudSync] Realtime canal: ${status}`);
                        });
                }

                // ── Polling cada 10 min: solo datos pesados ──────────────────
                // Productos, ventas, clientes, cuentas — payloads grandes que
                // no necesitan ser instantáneos. 10 min es suficiente para
                // multi-dispositivo en datos de catálogo.
                if (!pollIntervalId) {
                    const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutos (incremental: solo docs cambiados)

                    const pollForChanges = async () => {
                        if (isSyncingFromCloud) return;
                        try {
                            const currentSession = (await supabaseCloud.auth.getSession()).data.session;
                            if (!currentSession?.user?.id) return;

                            // Solo pedir docs pesados modificados después del último sync
                            // Filtro explícito por user_id como defensa en profundidad (RLS ya filtra)
                            let query = supabaseCloud
                                .from('sync_documents')
                                .select('collection, doc_id, data, updated_at')
                                .eq('user_id', currentSession.user.id)
                                .in('doc_id', POLLING_ONLY_KEYS);

                            if (lastSyncTime) {
                                query = query.gt('updated_at', lastSyncTime);
                            }

                            const { data: changed } = await query;

                            if (changed?.length > 0) {
                                for (const doc of changed) {
                                    console.log(`[CloudSync] Polling: ${doc.doc_id} actualizado`);
                                    await _applyFromCloud(doc.doc_id, doc.collection, doc.data.payload, doc.updated_at);
                                }
                            }

                            lastSyncTime = new Date().toISOString();
                        } catch (err) {
                            console.warn('[CloudSync] Error en polling:', err.message ?? err);
                        }
                    };

                    pollIntervalId = setInterval(pollForChanges, POLL_INTERVAL);
                    console.log('[CloudSync] Híbrido iniciado: Realtime (config) + Polling 5min (datos)');

                    // ── Sync al recuperar visibilidad ─────────────────────────
                    // Cuando el usuario vuelve al tab o desbloquea el teléfono,
                    // disparar un pull inmediato sin esperar el próximo intervalo.
                    const onVisible = () => {
                        if (document.visibilityState === 'visible') {
                            pollForChanges().catch(() => {});
                        }
                    };
                    document.addEventListener('visibilitychange', onVisible);
                    // Guardar referencia para cleanup
                    window.__cloudSyncVisibilityListener = onVisible;
                }

            } catch (err) {
                console.error('[CloudSync] Fallo en inicialización P2P:', err);
                isInitialized.current = false; // Permitir reintento
            }
        };

        initSync();

        return () => {
            localStorage.setItem = originalSetItem;
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            if (realtimeChannel) {
                supabaseCloud.removeChannel(realtimeChannel);
                realtimeChannel = null;
            }
            if (window.__cloudSyncVisibilityListener) {
                document.removeEventListener('visibilitychange', window.__cloudSyncVisibilityListener);
                delete window.__cloudSyncVisibilityListener;
            }
        };
    }, [isCloudConfigured, adminEmail, adminPassword]);
}

import { useEffect, useState } from 'react';
import localforage from 'localforage';
import { supabaseCloud } from '../config/supabaseCloud';
import { storageService } from '../utils/storageService';
import { useAuthStore } from './store/useAuthStore';
import { APP_STORAGE_DB_NAME, APP_STORAGE_STORE_NAME, getScopedStorageKey, setActiveAccountId } from '../config/storageScope';
import { hashPayload } from '../sync/syncHash';

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

// Exportado para forzar la recarga remota de todos los dispositivos
export const broadcastForceReload = async (userId) => {
    try {
        const ch = supabaseCloud.channel(`factory-reset-${userId}`);
        await ch.subscribe();
        await ch.send({ type: 'broadcast', event: 'force_reload', payload: {} });
        await new Promise(r => setTimeout(r, 800));
        supabaseCloud.removeChannel(ch);
    } catch (e) {
        console.warn('[CloudSync] No se pudo broadcast force_reload:', e.message);
    }
};

const SYNC_KEYS = [
    // ── IndexedDB (store) ──────────────────────────────────────────────────
    'bodega_products_v1',
    'bodega_customers_v1',
    'bodega_sales_v1',
    'bodega_cierres_v1',
    'bodega_payment_methods_v1',
    'bodega_accounts_v2',
    // 'abasto_audit_log_v1' eliminado: el audit va incremental a la tabla
    // audit_log (auditService.syncAuditToCloud). Subir el array completo
    // (~2-4 MB) en cada logEvent agotaba el Disk IO Budget de Supabase.
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

// ─── Llaves que contienen arrays con campo `id` y requieren merge inteligente ──
// Cuando llegan datos de la nube, en vez de sobreescribir el array completo,
// se hace merge por ID: se combinan items locales + nube, y si ambos tienen
// el mismo ID, gana el que tenga updatedAt/createdAt más reciente.
const MERGEABLE_KEYS = [
    // El inventario no se mezcla: la cuenta/nube activa es la fuente de verdad.
    'bodega_customers_v1',
    'bodega_sales_v1',
    'bodega_cierres_v1',
    'bodega_payment_methods_v1',
    'bodega_accounts_v2',
    'my_categories_v1',
    'bodega_suppliers_v1',
    'bodega_supplier_invoices_v1',
];

// Llaves legadas que dispositivos con versiones viejas aún pueden subir a
// sync_documents; se ignoran al recibir para no pisar el estado local.
const PULL_IGNORE_KEYS = ['abasto_audit_log_v1'];

/**
 * Merge inteligente de arrays por ID.
 * Combina localArr + cloudArr sin perder items de ninguno.
 * Si un item existe en ambos, gana el más reciente (por updatedAt o createdAt).
 */
function _mergeArraysById(localArr, cloudArr) {
    if (!Array.isArray(localArr) || !Array.isArray(cloudArr)) return cloudArr;

    const map = new Map();

    // Primero agregar todos los locales
    for (const item of localArr) {
        const id = item?.id ?? item?.cierreId;
        if (id !== null && id !== undefined) map.set(String(id), item);
    }

    // Luego agregar/sobreescribir con los de la nube si son más recientes
    for (const item of cloudArr) {
        const id = item?.id ?? item?.cierreId;
        if (id === null || id === undefined) {
            // Items sin id: agregar directamente
            map.set(Symbol(), item);
            continue;
        }

        const existing = map.get(String(id));
        if (!existing) {
            map.set(String(id), item);
        } else {
            // Comparar timestamps — gana el más reciente
            const localTime = existing.updatedAt || existing.createdAt || '';
            const cloudTime = item.updatedAt || item.createdAt || '';
            if (cloudTime >= localTime) {
                map.set(String(id), item);
            }
            // Si local es más reciente, se queda el local (ya está en el map)
        }
    }

    return Array.from(map.values());
}

// ─── Sanitización previa al push ───────────────────────────────────────────
// Ventana de sync para ventas. El historial completo se conserva en el
// dispositivo, en el backup de login/logout (cloud_backups) y fila por fila
// en la tabla sales; solo la réplica en sync_documents se recorta.
const SALES_SYNC_WINDOW_DAYS = 30;

function _trimSalesForSync(arr) {
    if (!Array.isArray(arr)) return arr;
    const cutoff = Date.now() - SALES_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return arr.filter(s => {
        const t = Date.parse(s?.timestamp || s?.updatedAt || s?.createdAt || '');
        return isNaN(t) ? true : t >= cutoff; // sin fecha parseable → conservar
    });
}

/**
 * Única fuente de verdad de las transformaciones previas al upsert.
 * La usa performUpsert y también uploadLocalBackup (useCloudAuthLogic), que
 * espeja el backup de login a sync_documents.
 */
export function sanitizeForPush(key, value) {
    let sanitizedValue = value;

    // Seguridad: eliminar adminPassword antes de sincronizar auth-storage a la nube
    if (key === 'abasto-auth-storage') {
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            if (parsed?.state?.adminPassword) {
                sanitizedValue = JSON.parse(JSON.stringify(parsed));
                delete sanitizedValue.state.adminPassword;
            }
        } catch { }
    }

    // Egress: eliminar imágenes base64 de productos antes de subir a la nube.
    // Las imágenes (204 KB de 218 KB por usuario) son el mayor driver de egreso.
    // Se conservan solo en local (IndexedDB); el otro dispositivo verá el producto sin imagen.
    if (key === 'bodega_products_v1') {
        try {
            const arr = Array.isArray(sanitizedValue) ? sanitizedValue
                : (typeof sanitizedValue === 'string' ? JSON.parse(sanitizedValue) : sanitizedValue);
            if (Array.isArray(arr)) {
                sanitizedValue = arr.map(({ image, ...rest }) => rest);
            }
        } catch { }
    }

    // Disk I/O: subir solo las ventas recientes; el documento completo crecía
    // sin límite y cada venta reescribía megabytes de JSONB (TOAST + WAL).
    if (key === 'bodega_sales_v1') {
        try {
            const arr = typeof sanitizedValue === 'string' ? JSON.parse(sanitizedValue) : sanitizedValue;
            sanitizedValue = _trimSalesForSync(arr);
        } catch { /* payload ilegible → subir tal cual */ }
    }

    return sanitizedValue;
}

// Huella sobre el payload COMPLETO y canónica (ver src/sync/syncHash.js). La versión
// previa solo miraba longitud + 300 caracteres y dejaba sin subir la mayoría de ediciones.

// ─── Estado Global del Motor ───────────────────────────────────────────────
let pollIntervalId = null;
let realtimeChannel = null;     // Canal Realtime para tasas/config (payloads pequeños)
let factoryResetChannel = null; // Canal broadcast factory-reset / force_reload
// Cada re-ejecución del efecto invalida el initSync anterior (aún en vuelo
// tras un await), evitando que dos inits compitan por el estado global y
// dejen el canal Realtime CLOSED (doble SIGNED_IN al iniciar sesión).
let syncGeneration = 0;
// Intentional module-level singletons: shared across all hook instances to
// coordinate cloud-sync echo prevention and debounce timers.
let isSyncingFromCloud = false; // true mientras aplicamos cambios de la nube → evita eco
// Cursor del polling: el MAYOR updated_at recibido del servidor (nunca la hora
// local). Con relojes desfasados entre equipos la hora local descartaba cambios.
let syncCursor = null;
let lastSyncTime = null;        // Hora local del último pull exitoso (solo informativa/UI)
const CURSOR_MARGIN_MS = 5000;  // Cubre transacciones que confirman fuera de orden
const _ownUpdatedAt = {};       // doc_id → updated_at que el servidor asignó a NUESTRO push
const _seenUpdatedAt = {};      // doc_id → último updated_at ya aplicado localmente

function _shiftIso(iso, deltaMs) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : new Date(t + deltaMs).toISOString();
}
function _maxIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return b > a ? b : a;
}

/** Estado legible para la UI (SyncStatus): último sync y si el motor está listo. */
export function getSyncDiagnostics() {
    return { ready: initialSyncReady, lastSyncTime, cursor: syncCursor, userId: activeSyncUserId };
}
let initialSyncReady = false;   // Bloquea pushes hasta hidratar la cuenta activa
let activeSyncUserId = null;    // Evita reutilizar el estado de otra cuenta

// Keep a reference to the native setItem for _applyFromCloud to bypass any interceptor
const _nativeSetItem = localStorage.setItem.bind(localStorage);

// Cache de hashes y temporizadores para evitar saturación y envíos redundantes
const _lastPushHash = {};
const _pushDebounceTimers = {};
const _pendingPushValues = {}; // último valor pendiente por llave, para flush al ocultar
const _failedPushValues = {};  // llaves cuyo push falló (red/RLS) → se reintentan en el siguiente ciclo

/** Reintenta los pushes que fallaron (se llama en cada ciclo de polling y al volver online). */
export const retryFailedPushes = () => {
    for (const key of Object.keys(_failedPushValues)) {
        const value = _failedPushValues[key];
        delete _failedPushValues[key];
        pushCloudSync(key, value, true).catch(() => {});
    }
};

// Llaves con payloads grandes: debounce largo para agrupar ráfagas (ej. hora
// pico de ventas) en un solo upsert y reducir el Disk I/O de Supabase.
const HEAVY_KEYS = [
    'bodega_sales_v1',
    'bodega_products_v1',
    'bodega_accounts_v2',
    'bodega_customers_v1',
    'bodega_supplier_invoices_v1',
];
const DEBOUNCE_MS = 3000;
const DEBOUNCE_MS_HEAVY = 30000;

/**
 * Empuja una llave al sincronizador de Supabase.
 * Llamado desde storageService (colección 'store') y el interceptor localStorage (colección 'local').
 * Soporta un parámetro bypassDebounce para subidas iniciales o forzadas inmediatas.
 */
export const pushCloudSync = async (key, value, bypassDebounce = false) => {
    if (isSyncingFromCloud) return;          // Nunca re-emitir lo que llegó de la nube
    if (!SYNC_KEYS.includes(key)) return;
    // Nunca enviar datos locales antes de terminar el pull inicial de la cuenta.
    // Esto evita que otro sistema o la cuenta anterior contamine la nube activa.
    if (!initialSyncReady) return;

    const performUpsert = async () => {
        try {
            const sanitizedValue = sanitizeForPush(key, value);

            // Deduplicación: generar hash rápido del payload para no resubir datos idénticos.
            const hash = hashPayload(sanitizedValue);
            if (_lastPushHash[key] === hash) return; // Sin cambios reales → skip
            // NOTA: hash se actualiza DESPUÉS del push exitoso para garantizar reintentos si falla

            const { data: { session } } = await supabaseCloud.auth.getSession();
            if (!session?.user?.id) return;

            const collectionType = LOCAL_KEYS.includes(key) ? 'local' : 'store';

            // updated_at lo fija el servidor (trigger de la migración 009): el reloj
            // de este dispositivo no interviene en el orden de los cambios.
            const { data: upserted, error: upsertError } = await supabaseCloud
                .from('sync_documents')
                .upsert({
                    user_id: session.user.id,
                    collection: collectionType,
                    doc_id: key,
                    data: { payload: sanitizedValue },
                }, { onConflict: 'user_id,collection,doc_id' })
                .select('updated_at');
            // supabase-js NO lanza en errores de RLS/red: devuelve { error }. Antes se
            // ignoraba y el hash se marcaba como enviado aunque el push hubiera fallado,
            // con lo que el cambio no se reintentaba nunca.
            if (upsertError) throw upsertError;

            // Solo marcar como enviado si el push fue exitoso
            _lastPushHash[key] = hash;
            delete _failedPushValues[key];
            // Recordar el updated_at que asignó el servidor a NUESTRO push, para que el
            // polling no vuelva a descargar lo que este mismo dispositivo acaba de subir.
            if (upserted?.[0]?.updated_at) _ownUpdatedAt[key] = upserted[0].updated_at;

            // Broadcast ligero para llaves de Realtime (tasas/config < 1KB)
            // Usa canal Broadcast en vez de postgres_changes para NO activar
            // la decodificación lógica de WAL en la base de datos.
            if (REALTIME_KEYS.includes(key) && realtimeChannel) {
                try {
                    await realtimeChannel.send({
                        type: 'broadcast',
                        event: 'sync_update',
                        payload: { doc_id: key, collection: collectionType, data: sanitizedValue }
                    });
                } catch (bcastErr) {
                    // No crítico: el otro dispositivo lo verá en el próximo pull
                    console.warn('[CloudSync] Broadcast falló (no crítico):', bcastErr?.message);
                }
            }

        } catch (e) {
            console.warn('[CloudSync] Error al enviar a la nube:', e.message ?? e);
            // Conservar el valor para reintentarlo (antes se perdía hasta el próximo cambio).
            _failedPushValues[key] = value;
        }
    };

    if (bypassDebounce) {
        if (_pushDebounceTimers[key]) {
            clearTimeout(_pushDebounceTimers[key]);
            delete _pushDebounceTimers[key];
        }
        delete _pendingPushValues[key];
        await performUpsert();
    } else {
        _pendingPushValues[key] = value;
        if (_pushDebounceTimers[key]) clearTimeout(_pushDebounceTimers[key]);
        const delay = HEAVY_KEYS.includes(key) ? DEBOUNCE_MS_HEAVY : DEBOUNCE_MS;
        _pushDebounceTimers[key] = setTimeout(() => {
            delete _pushDebounceTimers[key];
            delete _pendingPushValues[key];
            performUpsert().catch(() => {});
        }, delay);
    }
};

/**
 * Dispara inmediatamente todos los pushes pendientes de debounce.
 * Best-effort: se llama al ocultar/cerrar la pestaña; si el fetch se cancela,
 * el catch-up push del próximo arranque y la cola offline de ventas cubren el hueco.
 */
export const flushPendingPushes = () => {
    for (const key of Object.keys(_pushDebounceTimers)) {
        clearTimeout(_pushDebounceTimers[key]);
        delete _pushDebounceTimers[key];
        const pending = _pendingPushValues[key];
        delete _pendingPushValues[key];
        if (pending !== undefined) pushCloudSync(key, pending, true).catch(() => {});
    }
};

/**
 * Aplica un documento recibido de la nube al almacenamiento local.
 * Garantiza que isSyncingFromCloud esté activo durante toda la operación.
 * Si cloudUpdatedAt se provee, verifica que sea más reciente que el timestamp local
 * para evitar sobreescribir cambios locales con datos desactualizados de la nube.
 */
async function _applyFromCloud(docId, collection, payload, cloudUpdatedAt) {
    // Llaves legadas subidas por versiones viejas de la app: ignorar para no
    // pisar el estado local (ej. el audit log, que ahora vive en la tabla audit_log)
    if (PULL_IGNORE_KEYS.includes(docId)) return;

    // Deduplicación de pull: si la nube tiene exactamente lo que ya sabemos que tiene
    // (p. ej. el eco de nuestro propio push), no hay nada que aplicar.
    let incomingHash = null;
    try { incomingHash = payload === undefined ? null : hashPayload(payload); } catch { /* sin hash → aplicar */ }
    if (incomingHash && _lastPushHash[docId] === incomingHash) return;

    // El inventario de la cuenta activa es autoritativo: no se mezcla ni se
    // bloquea por timestamps locales heredados de otro sistema.
    const isInventory = docId === 'bodega_products_v1' && collection === 'store';
    // Para llaves mergeables (excepto inventario), se conserva el merge por ID.
    const isMergeable = MERGEABLE_KEYS.includes(docId) && collection === 'store';

    // Protección contra sobreescritura para llaves NO mergeables/no inventario.
    if (!isMergeable && !isInventory && cloudUpdatedAt) {
        try {
            const localTs = localStorage.getItem(getScopedStorageKey('_sync_local_ts_' + docId));
            if (localTs && localTs > cloudUpdatedAt) {
                console.log(`[CloudSync] Skip ${docId}: local (${localTs}) más reciente que nube (${cloudUpdatedAt}). Resubiendo...`);
                const { default: lf } = await import('localforage');
                lf.config({ name: APP_STORAGE_DB_NAME, storeName: APP_STORAGE_STORE_NAME });
                const localData = await lf.getItem(getScopedStorageKey(docId));
                if (localData !== null) {
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
            // Colección 'store' → IndexedDB
            const { default: localforage } = await import('localforage');
            localforage.config({ name: APP_STORAGE_DB_NAME, storeName: APP_STORAGE_STORE_NAME });

            let finalData = payload;

            // Merge inteligente para arrays con ID (ventas, productos, clientes, etc.)
            if (isMergeable && Array.isArray(payload)) {
                try {
                    const localData = await localforage.getItem(getScopedStorageKey(docId));
                    if (Array.isArray(localData)) {
                        finalData = _mergeArraysById(localData, payload);
                        console.log(`[CloudSync] Merge ${docId}: local=${localData.length}, nube=${payload.length}, resultado=${finalData.length}`);

                        // Si el merge produjo más items que la nube, re-subir el resultado.
                        // Para ventas se compara la versión recortada: el local siempre
                        // tiene más historial que la nube (ventana de N días) y comparar
                        // el array completo causaría re-push infinito en cada poll.
                        const pushable = docId === 'bodega_sales_v1' ? _trimSalesForSync(finalData) : finalData;
                        if (pushable.length > payload.length) {
                            setTimeout(() => {
                                delete _lastPushHash[docId];
                                pushCloudSync(docId, finalData).catch(() => {});
                            }, 500);
                        }
                    }
                } catch (e) {
                    console.warn(`[CloudSync] Merge falló para ${docId}, usando datos de nube:`, e.message);
                }
            }

            await localforage.setItem(getScopedStorageKey(docId), finalData);

            // Notificar a los componentes React que lean este store
            window.dispatchEvent(new CustomEvent('app_storage_update', { detail: { key: docId, source: 'cloud' } }));
        }
        // Lo que la nube tiene ya es conocido: evita re-subirlo o re-aplicarlo.
        if (incomingHash) _lastPushHash[docId] = incomingHash;
    } finally {
        isSyncingFromCloud = false;
    }
}

// ─── Hook de React ─────────────────────────────────────────────────────────
export function useCloudSync() {
    const [authEpoch, setAuthEpoch] = useState(0);
    // El sincronizador debe reaccionar al cambio real de sesión, aunque el
    // auth-storage local todavía no tenga adminEmail.
    useEffect(() => {
        const { data: { subscription } } = supabaseCloud.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
                setAuthEpoch(value => value + 1);
            }
        });
        return () => subscription.unsubscribe();
    }, []);

    // La sesión de Supabase es la fuente de verdad; no bloquear el pull por
    // depender de una preferencia local que puede estar vacía o ser antigua.
    const isCloudConfigured = true;

    useEffect(() => {
        // Esta ejecución del efecto es la autoridad actual: cualquier initSync
        // de una ejecución anterior (todavía en vuelo tras un await) se aborta.
        const myGen = ++syncGeneration;
        const isCurrent = () => syncGeneration === myGen;

        // Interceptor de localStorage — solo para llaves 'local'
        const originalSetItem = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
            originalSetItem(key, value);
            if (!isSyncingFromCloud && LOCAL_KEYS.includes(key)) {
                pushCloudSync(key, value).catch(() => {});
            }
        };

        // Flush best-effort de pushes pendientes al ocultar/cerrar la pestaña.
        // Con el debounce largo de HEAVY_KEYS, sin esto un cierre rápido dejaría
        // el último cambio sin subir hasta el próximo arranque.
        const onHiddenFlush = () => {
            if (document.visibilityState === 'hidden') flushPendingPushes();
        };
        const onPageHideFlush = () => flushPendingPushes();
        document.addEventListener('visibilitychange', onHiddenFlush);
        window.addEventListener('pagehide', onPageHideFlush);
        const removeFlushListeners = () => {
            document.removeEventListener('visibilitychange', onHiddenFlush);
            window.removeEventListener('pagehide', onPageHideFlush);
        };

        if (!isCloudConfigured) {
            initialSyncReady = false;
            activeSyncUserId = null;
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
                lastSyncTime = null;
            }
            if (realtimeChannel) {
                supabaseCloud.removeChannel(realtimeChannel);
                realtimeChannel = null;
            }
            if (factoryResetChannel) {
                supabaseCloud.removeChannel(factoryResetChannel);
                factoryResetChannel = null;
            }
            return () => { localStorage.setItem = originalSetItem; removeFlushListeners(); };
        }

        // ── Reintento de inicialización + polling (nivel de efecto) ───────────
        let retryTimer = null;
        let retryAttempt = 0;
        let visibilityListener = null;
        let lastVisibilityPoll = 0;
        const POLL_INTERVAL_MS = 60 * 1000;
        const VISIBILITY_COOLDOWN_MS = 5 * 1000; // anti-rebote al volver a la pestaña
        let pollInFlight = false;

        const scheduleInitRetry = () => {
            if (retryTimer) return;
            const delay = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(retryAttempt, 6)));
            retryAttempt++;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (isCurrent() && !initialSyncReady) initSync();
            }, delay);
        };

        const pollForChanges = async () => {
            if (pollInFlight || !initialSyncReady || isSyncingFromCloud) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            pollInFlight = true;
            try {
                retryFailedPushes();
                const currentSession = (await supabaseCloud.auth.getSession()).data.session;
                const uid = currentSession?.user?.id;
                if (!uid || uid !== activeSyncUserId) return;

                // ── Fase 1: solo metadatos (doc_id + updated_at) ──────────────
                let metaQuery = supabaseCloud
                    .from('sync_documents')
                    .select('doc_id, collection, updated_at')
                    .eq('user_id', uid)
                    .in('doc_id', SYNC_KEYS);
                if (syncCursor) {
                    metaQuery = metaQuery.gte('updated_at', _shiftIso(syncCursor, -CURSOR_MARGIN_MS));
                }
                const { data: changedMeta, error: metaError } = await metaQuery;
                if (metaError) throw metaError;

                let newCursor = syncCursor;
                const foreignIds = [];
                for (const meta of changedMeta || []) {
                    newCursor = _maxIso(newCursor, meta.updated_at);
                    if (_ownUpdatedAt[meta.doc_id] === meta.updated_at) {
                        _seenUpdatedAt[meta.doc_id] = meta.updated_at; // lo subimos nosotros
                        continue;
                    }
                    if (_seenUpdatedAt[meta.doc_id] === meta.updated_at) continue; // ya aplicado
                    foreignIds.push(meta.doc_id);
                }

                // ── Fase 2: bajar solo los docs que otro dispositivo cambió ───
                if (foreignIds.length > 0) {
                    const { data: changed, error: dataError } = await supabaseCloud
                        .from('sync_documents')
                        .select('collection, doc_id, data, updated_at')
                        .eq('user_id', uid)
                        .in('doc_id', foreignIds);
                    if (dataError) throw dataError;
                    for (const doc of changed || []) {
                        console.log(`[CloudSync] Polling: ${doc.doc_id} actualizado`);
                        await _applyFromCloud(doc.doc_id, doc.collection, doc.data.payload, doc.updated_at);
                        _seenUpdatedAt[doc.doc_id] = doc.updated_at;
                        newCursor = _maxIso(newCursor, doc.updated_at);
                    }
                }

                // El cursor solo avanza si TODO se aplicó (un fallo se reintenta en el
                // siguiente ciclo; la deduplicación evita reaplicar lo ya aplicado).
                syncCursor = newCursor;
                lastSyncTime = new Date().toISOString();
            } catch (err) {
                console.warn('[CloudSync] Error en polling:', err?.message ?? err);
            } finally {
                pollInFlight = false;
            }
        };

        const onBackOnline = () => {
            if (!initialSyncReady) {
                retryAttempt = 0;
                if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
                if (isCurrent()) initSync();
            } else {
                pollForChanges().catch(() => {});
            }
        };
        window.addEventListener('online', onBackOnline);

        const initSync = async () => {
            try {
                let session = (await supabaseCloud.auth.getSession()).data.session;
                if (!isCurrent()) return;

                if (!session?.user?.id) {
                    initialSyncReady = false;
                    activeSyncUserId = null;
                    setActiveAccountId(null);
                    return;
                }

                const userId = session.user.id;
                // Asegurar el namespace correcto antes de leer o escribir IndexedDB.
                setActiveAccountId(userId);

                // Misma cuenta ya sincronizada (doble SIGNED_IN del login,
                // remounts): no repetir el pull ni el catch-up. Solo re-crear
                // los canales que el cleanup de la ejecución anterior cerró.
                const alreadySynced = initialSyncReady && activeSyncUserId === userId;
                if (!alreadySynced) {
                    if (activeSyncUserId !== userId) {
                        activeSyncUserId = userId;
                        for (const key of Object.keys(_lastPushHash)) delete _lastPushHash[key];
                    }
                    initialSyncReady = false;

                // ── Pull Inicial: descarga todos los documentos ──────────────
                // Saltarse si acaba de hacerse una importación local (el flag evita que
                // Supabase sobreescriba los datos recién importados).
                let docs = null;
                const skipPull = sessionStorage.getItem('skip_cloud_pull');
                if (skipPull) {
                    sessionStorage.removeItem('skip_cloud_pull');
                    console.log('[CloudSync] Pull inicial omitido (importación reciente).');
                    // Caso raro: sin pull no hay cursor de servidor; usar la hora local para
                    // que el primer poll no sobrescriba los datos recién importados.
                    syncCursor = new Date().toISOString();
                } else {
                    const { data, error } = await supabaseCloud
                        .from('sync_documents')
                        .select('collection, doc_id, data, updated_at')
                        .eq('user_id', userId)
                        .in('collection', ['store', 'local']);
                    if (error) throw error;
                    docs = data;

                    syncCursor = null;
                    if (docs?.length > 0) {
                        for (const doc of docs) {
                            await _applyFromCloud(doc.doc_id, doc.collection, doc.data.payload, doc.updated_at);
                            // Seed del hash-cache con lo que la nube ya tiene: el catch-up
                            // push de abajo salta las llaves idénticas en vez de re-subir
                            // los ~26 documentos completos en cada arranque. El hash es
                            // canónico, así que el reordenamiento de llaves de jsonb no lo rompe.
                            try {
                                _lastPushHash[doc.doc_id] = hashPayload(doc.data.payload);
                            } catch { /* sin seed → push normal, como antes */ }
                            _seenUpdatedAt[doc.doc_id] = doc.updated_at;
                            syncCursor = _maxIso(syncCursor, doc.updated_at);
                        }
                        console.log(`[CloudSync] Pull inicial: ${docs.length} documentos procesados.`);
                    }
                }
                if (!isCurrent()) return;

                lastSyncTime = new Date().toISOString();
                // Desde este punto los cambios nuevos de esta cuenta sí pueden subir.
                initialSyncReady = true;

                // ── Catch-up push: subir datos locales que la nube no tiene ──
                // Asegura que claves recién agregadas al sync (ej. categorías, proveedores,
                // config) queden en Supabase aunque nunca hayan sido modificadas en este
                // dispositivo desde que se activó el sync.
                // El hash deduplication evita resubir lo que ya está igual en la nube.
                // Set de doc_ids que la nube ya tiene (del pull inicial)
                const cloudDocIds = new Set(docs?.map(d => d.doc_id) || []);

                (async () => {
                    const { default: lf } = await import('localforage');
                    lf.config({ name: APP_STORAGE_DB_NAME, storeName: APP_STORAGE_STORE_NAME });
                    for (const key of SYNC_KEYS) {
                        if (LOCAL_KEYS.includes(key)) {
                            const val = localStorage.getItem(key);
                            if (val != null) pushCloudSync(key, val, true).catch(() => {});
                        } else {
                            const val = await lf.getItem(getScopedStorageKey(key));
                            // No subir arrays vacíos si la nube ya tiene datos para esta llave.
                            // Esto previene que un dispositivo nuevo borre el inventario de la nube.
                            if (val != null) {
                                // El inventario ya fue hidratado desde la nube; no volver a
                                // subir el arreglo local ni mezclarlo con otra fuente.
                                if (key === 'bodega_products_v1' && cloudDocIds.has(key)) continue;
                                if (Array.isArray(val) && val.length === 0 && cloudDocIds.has(key)) {
                                    console.log(`[CloudSync] Skip push ${key}: local vacío, nube ya tiene datos`);
                                    continue;
                                }
                                pushCloudSync(key, val, true).catch(() => {});
                            }
                        }
                        // Pausa entre keys para no saturar Supabase con burst
                        await new Promise(r => setTimeout(r, 120));
                    }
                })().catch(() => {});
                }

                if (!isCurrent()) return;

                // ── Listener de Factory Reset remoto ─────────────────────────
                // Si otro dispositivo con la misma cuenta hace factory reset,
                // este equipo también limpia y recarga.
                if (!factoryResetChannel) {
                    factoryResetChannel = supabaseCloud.channel(`factory-reset-${userId}`)
                        .on('broadcast', { event: 'factory_reset' }, async () => {
                        console.log('[CloudSync] Factory reset remoto recibido — limpiando...');
                        try {
                            await localforage.clear();
                            localStorage.clear();
                            if ('caches' in window) {
                                const cacheKeys = await caches.keys();
                                await Promise.all(cacheKeys.map(k => caches.delete(k)));
                            }
                            if ('serviceWorker' in navigator) {
                                const regs = await navigator.serviceWorker.getRegistrations();
                                await Promise.all(regs.map(r => r.unregister()));
                            }
                        } catch (e) {
                            console.warn('[CloudSync] Error parcial en factory reset:', e);
                        }
                        window.location.reload();
                    })
                    .on('broadcast', { event: 'force_reload' }, () => {
                        console.log('[CloudSync] Recarga remota recibida — actualizando...');
                        window.location.reload();
                    })
                        .subscribe();
                }

                // ── Realtime: solo tasas y config (payloads <1KB) ─────────────
                // Esto permite que 2 dispositivos con la misma cuenta vean
                // cambios de tasa instantáneamente sin egreso significativo.
                if (!realtimeChannel) {
                    // Canal Broadcast privado por usuario.
                    // NO usa postgres_changes → no activa decodificación lógica de WAL.
                    // Los mensajes viajan cliente→cliente a través de los servidores de
                    // Supabase Realtime sin pasar por la base de datos.
                    realtimeChannel = supabaseCloud
                        .channel(`sync-rates-${userId}`, {
                            config: { broadcast: { self: false } }
                        })
                        .on(
                            'broadcast',
                            { event: 'sync_update' },
                            async ({ payload }) => {
                                if (isSyncingFromCloud) return;
                                const { doc_id, collection, data } = payload;
                                // Solo procesar llaves ligeras (tasas/config)
                                if (!REALTIME_KEYS.includes(doc_id)) return;
                                console.log(`[CloudSync] Realtime Broadcast: ${doc_id} actualizado`);
                                await _applyFromCloud(doc_id, collection, data);
                            }
                        )
                        .subscribe((status) => {
                            console.log(`[CloudSync] Realtime Broadcast canal: ${status}`);
                        });
                }

                // ── Polling de METADATOS cada 60 s (todas las llaves) ────────
                // Solo se consulta doc_id + updated_at (~1 KB). La data pesada se baja
                // únicamente de los documentos que OTRO dispositivo modificó. Antes el
                // polling era cada 60 min y excluía las llaves de Realtime, de modo que un
                // broadcast perdido (equipo dormido/offline) no se recuperaba jamás.
                if (!pollIntervalId && document.visibilityState !== 'hidden') {
                    pollIntervalId = setInterval(pollForChanges, POLL_INTERVAL_MS);
                    console.log('[CloudSync] Híbrido iniciado: Realtime (config) + Polling 60 s (metadatos)');
                }
                if (!visibilityListener) {
                    visibilityListener = () => {
                        if (document.visibilityState === 'visible') {
                            if (!pollIntervalId) pollIntervalId = setInterval(pollForChanges, POLL_INTERVAL_MS);
                            const now = Date.now();
                            if (now - lastVisibilityPoll >= VISIBILITY_COOLDOWN_MS) {
                                lastVisibilityPoll = now;
                                pollForChanges().catch(() => {});
                            }
                        } else if (pollIntervalId) {
                            // Pestaña oculta — pausar polling para ahorrar egress
                            clearInterval(pollIntervalId);
                            pollIntervalId = null;
                        }
                    };
                    document.addEventListener('visibilitychange', visibilityListener);
                }

            } catch (err) {
                console.error('[CloudSync] Fallo en inicialización P2P:', err);
                initialSyncReady = false;
                // Reintentar con backoff (y de inmediato al volver la conexión). Antes
                // no había reintento: abrir la app sin internet dejaba el sync apagado
                // toda la sesión y todo lo que se guardaba se quedaba solo en este equipo.
                if (isCurrent()) scheduleInitRetry();
            }
        };

        initSync();

        return () => {
            // Invalidar cualquier initSync de esta ejecución que siga en vuelo
            // (ej. un pull no terminado cuando el efecto re-ejecute).
            syncGeneration++;
            // NOTA: no se resetean initialSyncReady/activeSyncUserId aquí.
            // Si el efecto se re-ejecuta con la misma cuenta (doble SIGNED_IN
            // al login), initSync lo detecta y omite el pull duplicado.
            // El reset ocurre dentro de initSync cuando cambia de cuenta o
            // la sesión desaparece.
            localStorage.setItem = originalSetItem;
            removeFlushListeners();
            window.removeEventListener('online', onBackOnline);
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            if (visibilityListener) {
                document.removeEventListener('visibilitychange', visibilityListener);
                visibilityListener = null;
            }
            // Empujar (no descartar) los cambios pendientes antes de desmontar
            flushPendingPushes();
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            if (realtimeChannel) {
                supabaseCloud.removeChannel(realtimeChannel);
                realtimeChannel = null;
            }
            if (factoryResetChannel) {
                supabaseCloud.removeChannel(factoryResetChannel);
                factoryResetChannel = null;
            }
        };
    // La sesión de Supabase, no las credenciales persistidas localmente, controla
    // el ciclo de vida del sincronizador. Evita repetir el pull cuando solo cambia
    // el estado local de autenticación.
    }, [authEpoch, isCloudConfigured]);
}

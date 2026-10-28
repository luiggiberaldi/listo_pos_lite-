import localforage from 'localforage';
import { pushCloudSync } from '../hooks/useCloudSync';
import { APP_STORAGE_DB_NAME, APP_STORAGE_STORE_NAME, getScopedStorageKey } from '../config/storageScope';
import { ENTITY_KEYS, alive, getDeviceId, stampChanges } from '../sync/entityMeta';

// Fase B: las listas sincronizadas guardan lápidas (registros borrados) que las
// pantallas no deben ver. getItem devuelve solo los vivos.
const visible = (key, value) => (ENTITY_KEYS.includes(key) ? alive(value) : value);

// Escrituras de una misma llave en orden: cada una se marca contra la anterior.
const _writeChains = {};

localforage.config({
    name: APP_STORAGE_DB_NAME,
    storeName: APP_STORAGE_STORE_NAME,
    description: 'Almacenamiento local aislado de Listo POS Lite'
});

/**
 * Servicio de almacenamiento que previene el límite de 5MB de localStorage
 * Migrando los datos pesados a IndexedDB a través de localforage.
 */
export const storageService = {
    /**
     * Obtiene un item de IndexedDB.
     * Si no existe, intenta leerlo de localStorage (Retrocompatibilidad),
     * lo guarda en IndexedDB y lo borra de localStorage.
     */
    async getItem(key, defaultValue = null) {
        try {
            // 1. Intentar leer de IndexedDB
            const scopedKey = getScopedStorageKey(key);
            const value = await localforage.getItem(scopedKey);

            if (value !== null) {
                return visible(key, value);
            }

            // No importar automáticamente bases de otras aplicaciones.
            // Los datos de versiones anteriores deben entrar por backup explícito.

            // Si no existe en IndexedDB, revisar únicamente el fallback de esta cuenta.
            const fallbackValue = localStorage.getItem(scopedKey);
            if (fallbackValue !== null) {
                // Migración silenciosa de localStorage a IndexedDB

                let parsedValue;
                try {
                    parsedValue = JSON.parse(fallbackValue);
                } catch (e) {
                    parsedValue = fallbackValue; // Intentional: some keys store plain strings (e.g. business_name)
                }

                // Guardar en la nueva base de datos
                await localforage.setItem(scopedKey, parsedValue);

                // Borrar el viejo para liberar el preciado espacio de 5MB
                localStorage.removeItem(scopedKey);

                return visible(key, parsedValue);
            }

            // 3. No existe en ningún lado
            return defaultValue;

        } catch (error) {
            console.error(`[Storage Error] Leyendo ${key}:`, error);
            // Fallback drástico en caso de que el navegador bloquee IndexedDB por privacidad extrema
            const backup = localStorage.getItem(getScopedStorageKey(key));
            if (backup) {
                try { return visible(key, JSON.parse(backup)); } catch (e) { return backup; }
            }
            return defaultValue;
        }
    },

    /**
     * Guarda un item directamente en IndexedDB
     */
    /**
     * Guarda en IndexedDB. Para las listas sincronizadas (ENTITY_KEYS) marca cada
     * registro cambiado con fecha/versión/dispositivo y convierte los borrados en
     * lápidas (Fase B: B1/B2). `allowMassDelete` permite vaciar a propósito una
     * lista grande (p. ej. "Borrar todo" del inventario).
     */
    async setItem(key, value, options = {}) {
        if (ENTITY_KEYS.includes(key) && Array.isArray(value)) {
            return storageService.runExclusive(key, () => storageService._setEntityList(key, value, options));
        }
        return storageService._setRaw(key, value);
    },

    /**
     * Ejecuta `fn` en la fila de escrituras de `key`: espera a los guardados
     * anteriores y los siguientes esperan a que termine (B5: lo usa el
     * sincronizador para aplicar lo que baja de la nube sin intercalarse).
     */
    runExclusive(key, fn) {
        const run = (_writeChains[key] || Promise.resolve()).then(fn);
        _writeChains[key] = run.catch(() => {});
        return run;
    },

    async _setEntityList(key, value, { allowMassDelete = false } = {}) {
        const scopedKey = getScopedStorageKey(key);
        let prev = null;
        try { prev = await localforage.getItem(scopedKey); } catch { /* sin lectura → todo cuenta como nuevo */ }
        const result = stampChanges(prev, value, { deviceId: getDeviceId(), allowMassDelete });
        if (result.blocked) {
            console.warn(`[Storage] Se evitó vaciar ${key}: la lista tenía ${alive(prev).length} registros y llegó vacía.`);
            return;
        }
        if (!result.changed && Array.isArray(prev)) return; // nada que guardar ni subir
        return storageService._setRaw(key, result.list);
    },

    async _setRaw(key, value) {
        const scopedKey = getScopedStorageKey(key);
        try {
            await localforage.setItem(scopedKey, value);
            try { localStorage.removeItem(scopedKey); } catch(e) {} // Evitar residuos de fallback de esta cuenta
            // Registrar timestamp de modificación local para resolución de conflictos con nube
            try { localStorage.setItem(getScopedStorageKey('_sync_local_ts_' + key), new Date().toISOString()); } catch(e) {}
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("app_storage_update", { detail: { key } }));
            }
            // Emitir a la nube silenciosamente de fondo
            pushCloudSync(key, value).catch(() => {});
        } catch (error) {
            console.error(`[Storage Error] Guardando ${key}:`, error);
            // Fallback de emergencia a localStorage si falla algo catastrófico
            try {
                localStorage.setItem(scopedKey, typeof value === 'string' ? value : JSON.stringify(value));
                try { localStorage.setItem(getScopedStorageKey('_sync_local_ts_' + key), new Date().toISOString()); } catch(e) {}
                if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("app_storage_update", { detail: { key } }));
                }
                pushCloudSync(key, value).catch(() => {});
            } catch (e) {
                console.error(`[Storage Error CRÍTICO] Ni IndexedDB ni LocalStorage funcionan para ${key}`, e);
            }
        }
    },

    /**
     * Elimina un item
     */
    async removeItem(key) {
        try {
            const scopedKey = getScopedStorageKey(key);
            await localforage.removeItem(scopedKey);
            localStorage.removeItem(scopedKey); // Por si acaso quedó algún residuo
            // Notificar a componentes React del borrado
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("app_storage_update", { detail: { key } }));
            }
            // H-17: borrar una llave local NO vacía la nube. Antes se subía [] y un
            // borrado local (o de una colección que solo vive en este equipo) dejaba
            // sin datos a todos los dispositivos. El borrado intencional de una
            // colección en la nube lo hace quien lo pide (p. ej. "BORRAR" ventas en
            // Dashboard) o el factory reset.
        } catch (error) {
            console.error(`[Storage Error] Borrando ${key}:`, error);
        }
    }
};

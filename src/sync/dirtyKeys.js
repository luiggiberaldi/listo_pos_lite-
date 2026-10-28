import { compareIso } from './syncCursor.js';

/**
 * Llaves sucias (A4): cambios locales que la nube todavía no confirmó.
 *
 * Antes, todo lo que se guardaba antes de terminar el pull inicial (app abierta
 * sin internet) se descartaba, y el pull podía pisarlo con la copia de la nube.
 * Ahora cada cambio marca su llave con la hora del cambio, en localStorage y por
 * cuenta (sobrevive a cerrar la app). La marca se borra solo cuando la nube
 * confirma ese mismo contenido.
 *
 * Funciones puras sobre un `storage` con getItem/setItem/removeItem; `scopedKey`
 * ya trae el prefijo de la cuenta activa.
 */
export const DIRTY_KEYS_STORAGE_KEY = '_sync_dirty_keys';
// Huella del último contenido que se sabe igual en la nube (push confirmado o
// documento aplicado), por llave. Distingue un cambio real de un re-guardado
// idéntico (p. ej. el auto-guardado del inventario al abrir la app).
export const CLEAN_HASH_STORAGE_KEY = '_sync_clean_hash';

function readMap(storage, scopedKey) {
    try {
        const parsed = JSON.parse(storage.getItem(scopedKey) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeMap(storage, scopedKey, map) {
    if (Object.keys(map).length === 0) storage.removeItem(scopedKey);
    else storage.setItem(scopedKey, JSON.stringify(map));
}

export const readDirty = readMap;
const writeDirty = writeMap;

export const readCleanHashes = readMap;

export function setCleanHash(storage, scopedKey, key, hash) {
    if (!hash) return;
    const map = readMap(storage, scopedKey);
    if (map[key] === hash) return;
    map[key] = hash;
    writeMap(storage, scopedKey, map);
}

/**
 * ¿Este guardado es un cambio pendiente de subir?
 * - Igual a lo que la nube ya tiene → no (re-guardado idéntico).
 * - Antes del pull inicial y sin huella previa no se puede distinguir un cambio
 *   real de un re-guardado al abrir: no se marca (comportamiento anterior), para
 *   que datos locales viejos nunca le ganen a la nube.
 * - En cualquier otro caso → sí.
 */
export function isRealChange({ hash, cleanHash, ready }) {
    if (cleanHash && hash === cleanHash) return false;
    if (!ready && !cleanHash) return false;
    return true;
}

/** Marca la llave como cambiada localmente; devuelve la marca guardada. */
export function markDirty(storage, scopedKey, key, nowIso = new Date().toISOString()) {
    const map = readDirty(storage, scopedKey);
    map[key] = nowIso;
    writeDirty(storage, scopedKey, map);
    return nowIso;
}

/**
 * Quita la marca. Con `expectedTs`, solo si nadie volvió a cambiar la llave
 * mientras se subía (un cambio posterior debe seguir pendiente).
 */
export function clearDirty(storage, scopedKey, key, expectedTs) {
    const map = readDirty(storage, scopedKey);
    if (!(key in map)) return false;
    if (expectedTs !== undefined && map[key] !== expectedTs) return false;
    delete map[key];
    writeDirty(storage, scopedKey, map);
    return true;
}

/**
 * ¿El cambio local pendiente es posterior a la versión de la nube?
 * Compara la hora local del cambio con el updated_at del servidor: es la misma
 * regla que ya usaba la protección por `_sync_local_ts_` (Fase A; en la Fase C
 * el orden lo da `rev`/`seq`).
 */
export function localIsNewer(localTs, cloudUpdatedAt) {
    if (!localTs) return false;
    if (!cloudUpdatedAt) return true;
    return compareIso(localTs, cloudUpdatedAt) > 0;
}

// Opción por dispositivo: bloquear con PIN al cambiar de pestaña / minimizar la app.
// Se guarda solo en este equipo (no se sincroniza): cada caja decide según su uso físico.
export const LOCK_ON_TAB_CHANGE_KEY = 'lock_on_tab_change';

// Por defecto activado (comportamiento histórico). Solo 'false' lo desactiva.
export function parseLockOnTabChange(raw) {
    return raw !== 'false';
}

export function getLockOnTabChange(storage = globalThis.localStorage) {
    try {
        return parseLockOnTabChange(storage?.getItem(LOCK_ON_TAB_CHANGE_KEY));
    } catch {
        return true;
    }
}

export function setLockOnTabChange(enabled, storage = globalThis.localStorage) {
    storage?.setItem(LOCK_ON_TAB_CHANGE_KEY, enabled ? 'true' : 'false');
}

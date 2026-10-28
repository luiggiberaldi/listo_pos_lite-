import { ACCOUNT_LOCAL_KEYS, ACCOUNT_LOCAL_SWITCHED_EVENT, switchLocalAccount } from './accountLocalSwap.js';

// Namespace exclusivo de Listo POS Lite.
// No reutilizar BodegaApp/TasasAlDiaApp: otras aplicaciones pueden usar esos nombres.
export const APP_STORAGE_DB_NAME = 'ListoPOSLiteApp_v1';
export const APP_STORAGE_STORE_NAME = 'listo_pos_data';
export const ACTIVE_ACCOUNT_STORAGE_KEY = 'listo_pos_active_account_id';

export function getActiveAccountId() {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) || '';
}

export function setActiveAccountId(accountId) {
    if (typeof localStorage === 'undefined') return;
    if (accountId) {
        // B8: la configuración del navegador pasa a ser la de esta cuenta.
        // Al cerrar sesión (null) no se toca: la cuenta dueña sigue siendo la misma.
        let switched = false;
        try { switched = switchLocalAccount(accountId); } catch { /* sin acceso */ }
        localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, accountId);
        if (switched && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(ACCOUNT_LOCAL_SWITCHED_EVENT, { detail: { accountId } }));
            // Las pantallas que escuchan 'storage' (tasa, negocio…) se actualizan.
            for (const key of ACCOUNT_LOCAL_KEYS) {
                try { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); } catch { /* navegador sin StorageEvent */ }
            }
        }
    } else {
        localStorage.removeItem(ACTIVE_ACCOUNT_STORAGE_KEY);
    }
}

export function getScopedStoragePrefix() {
    const accountId = getActiveAccountId();
    return accountId ? `account:${accountId}:` : 'unscoped:';
}

export function getScopedStorageKey(key) {
    return `${getScopedStoragePrefix()}${key}`;
}

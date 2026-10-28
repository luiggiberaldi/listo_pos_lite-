/**
 * B8: configuración del navegador (localStorage) separada por cuenta.
 *
 * Unas 150 partes de la app leen llaves como 'business_name' o la tasa
 * directamente de localStorage. En vez de cambiar cada una, aquí se hace el
 * cambio en UN punto: las llaves "normales" siempre contienen los datos de la
 * cuenta dueña (OWNER_KEY). Al entrar con otra cuenta en el mismo equipo, los
 * valores de la anterior se guardan aparte ("account:<id>:ls:<llave>") y se
 * cargan los de la nueva (o nada, y la nube los rellena). Así la cuenta B no
 * ve ni sube a su nube los datos de la cuenta A.
 */

// Llaves de configuración que se sincronizan con la nube (colección 'local').
export const LOCAL_SYNC_KEYS = [
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
    'business_name',
    'business_rif',
    'allow_negative_stock',
    'bodega_rate_mode',
    'cajero_puede_abrir_caja',
    'cajero_puede_cerrar_caja',
    'cajero_max_descuento',
    'cashea_min_amount',
];

// Además de las sincronizadas: la sesión del cajero no debe pasar de una
// cuenta a otra.
export const ACCOUNT_LOCAL_KEYS = [...LOCAL_SYNC_KEYS, 'abasto-device-session'];

export const LOCAL_OWNER_KEY = 'listo_pos_local_owner';
export const ACCOUNT_LOCAL_SWITCHED_EVENT = 'account_local_switched';

export const stashKey = (accountId, key) => `account:${accountId}:ls:${key}`;

// Escribe sin pasar por el interceptor de sincronización (useCloudSync
// reemplaza localStorage.setItem): lo que se restaura NO es un cambio nuevo
// y no debe subirse ni "ganarle" a la nube.
function rawSet(storage, key, value) {
    if (typeof Storage !== 'undefined' && storage instanceof Storage) {
        Storage.prototype.setItem.call(storage, key, value);
    } else {
        storage.setItem(key, value);
    }
}

/**
 * Deja en las llaves normales los datos de `accountId`.
 * Devuelve true si cambió de dueño (hubo intercambio).
 */
export function switchLocalAccount(accountId, { storage = globalThis.localStorage, keys = ACCOUNT_LOCAL_KEYS } = {}) {
    if (!accountId || !storage) return false;
    const owner = storage.getItem(LOCAL_OWNER_KEY);
    if (owner === accountId) return false;
    if (!owner) {
        // Equipo de antes de la Fase B: los valores actuales pasan a ser de esta cuenta.
        rawSet(storage, LOCAL_OWNER_KEY, accountId);
        return false;
    }
    for (const key of keys) {
        const value = storage.getItem(key);
        if (value === null) storage.removeItem(stashKey(owner, key));
        else rawSet(storage, stashKey(owner, key), value);
    }
    for (const key of keys) {
        const saved = storage.getItem(stashKey(accountId, key));
        if (saved === null) storage.removeItem(key);
        else rawSet(storage, key, saved);
        storage.removeItem(stashKey(accountId, key));
    }
    rawSet(storage, LOCAL_OWNER_KEY, accountId);
    return true;
}

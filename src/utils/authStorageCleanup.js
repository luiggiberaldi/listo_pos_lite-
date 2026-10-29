// Versiones anteriores guardaban la contraseña de la cuenta en texto plano
// (adminPassword) sin usarla para nada. Se borra de este equipo al cargar.
const AUTH_STORAGE_KEY = 'abasto-auth-storage';
export function stripStoredPassword(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(AUTH_STORAGE_KEY);
        if (!raw || !raw.includes('adminPassword')) return false;
        const parsed = JSON.parse(raw);
        if (!parsed?.state || !('adminPassword' in parsed.state)) return false;
        delete parsed.state.adminPassword;
        storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed));
        return true;
    } catch { return false; }
}

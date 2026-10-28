import { supabaseCloud } from '../config/supabaseCloud';
import { getScopedStorageKey } from '../config/storageScope';
import { REGISTER_CODE_KEY, isValidRegisterCode } from '../utils/saleNumbering';

/**
 * B6: trae la letra de esta caja (A, B, C…) que el servidor asignó en
 * account_devices.register_code y la guarda para esta cuenta. Sin internet o
 * sin la migración 014 no hace nada: el cobro usa el código provisional.
 */
export async function refreshRegisterCode(email, deviceId) {
    if (!email || !deviceId) return null;
    try {
        const { data, error } = await supabaseCloud
            .from('account_devices')
            .select('register_code')
            .eq('email', email.toLowerCase())
            .eq('device_id', deviceId)
            .maybeSingle();
        const code = data?.register_code;
        if (error || !isValidRegisterCode(code)) return null;
        localStorage.setItem(getScopedStorageKey(REGISTER_CODE_KEY), code);
        return code;
    } catch {
        return null;
    }
}

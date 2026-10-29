/**
 * Mensajes de Supabase Auth en español sencillo.
 *
 * Supabase responde en inglés ("Invalid login credentials"…). Se traduce por
 * código cuando existe y, si no, por el texto. Lo desconocido se muestra tal
 * cual con un prefijo, para no esconder el error real.
 */

const BY_CODE = {
    invalid_credentials: 'Correo o contraseña incorrectos.',
    email_not_confirmed: 'Todavía no confirmas tu correo. Revisa tu bandeja de entrada (y la carpeta de spam).',
    user_already_exists: 'Ese correo ya tiene una cuenta. Usa "Entrar".',
    email_exists: 'Ese correo ya tiene una cuenta. Usa "Entrar".',
    weak_password: 'La contraseña es muy débil. Usa al menos 8 caracteres, con letras y números.',
    same_password: 'La nueva contraseña debe ser distinta a la anterior.',
    over_email_send_rate_limit: 'Se enviaron demasiados correos. Espera unos minutos e inténtalo de nuevo.',
    over_request_rate_limit: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    email_address_invalid: 'Ese correo no es válido.',
    otp_expired: 'El enlace venció o ya se usó. Pide uno nuevo.',
    session_not_found: 'Tu sesión venció. Vuelve a iniciar sesión.',
    signup_disabled: 'El registro de cuentas nuevas está desactivado.',
};

const BY_TEXT = [
    [/invalid login credentials/i, BY_CODE.invalid_credentials],
    [/email not confirmed/i, BY_CODE.email_not_confirmed],
    [/already registered|already been registered|already exists/i, BY_CODE.user_already_exists],
    [/password should be at least|password is too weak|weak password/i, BY_CODE.weak_password],
    [/should be different from the old password/i, BY_CODE.same_password],
    [/rate limit|too many requests|security purposes.*after/i, BY_CODE.over_request_rate_limit],
    [/unable to validate email|invalid email|email address .* is invalid/i, BY_CODE.email_address_invalid],
    [/expired|invalid.*(token|link)/i, BY_CODE.otp_expired],
    [/auth session missing|session.*not found/i, BY_CODE.session_not_found],
    [/failed to fetch|network ?error|load failed/i, 'Sin conexión a internet. Revisa tu red e inténtalo de nuevo.'],
];

export function translateAuthError(error, fallback = 'Ocurrió un error. Inténtalo de nuevo.') {
    if (!error) return fallback;
    const code = typeof error === 'object' ? error.code || error.error_code : null;
    if (code && BY_CODE[code]) return BY_CODE[code];
    const text = typeof error === 'string' ? error : error.message || error.error_description || '';
    for (const [pattern, message] of BY_TEXT) {
        if (pattern.test(text)) return message;
    }
    return text ? `${fallback} (${text})` : fallback;
}

/**
 * Lee el error que Supabase deja en la URL cuando un enlace de correo falla
 * (#error=access_denied&error_code=otp_expired&error_description=…).
 */
export function readAuthLinkError(location = globalThis.location) {
    if (!location) return null;
    const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const query = new URLSearchParams(String(location.search || ''));
    const code = hash.get('error_code') || query.get('error_code');
    const error = hash.get('error') || query.get('error');
    if (!code && !error) return null;
    const description = hash.get('error_description') || query.get('error_description') || '';
    return { code: code || error, description, message: translateAuthError({ code, message: description }) };
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Cabecera Authorization con el access token de Supabase de la sesión activa.
 *
 * /api/checkout y /api/inventory-operation escriben con la service key del
 * servidor, así que exigen un usuario autenticado y toman la cuenta del token.
 *
 * El import de supabaseCloud es dinámico y tolerante a fallos para que los
 * módulos que lo usan (contrato de inventario, cola offline) sigan siendo
 * importables y testeables desde Node, donde no existe import.meta.env.
 */
// Tiempo máximo para leer la sesión: si el cliente de auth se queda
// esperando (bloqueo entre pestañas, red), las colas no deben colgarse; sin
// token el servidor responde 401 y la venta sigue pendiente.
const SESSION_TIMEOUT_MS = 5000;

export async function getAuthHeaders() {
    try {
        const { supabaseCloud } = await import('../config/supabaseCloud');
        const { data } = await Promise.race([
            supabaseCloud.auth.getSession(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout de sesión')), SESSION_TIMEOUT_MS)),
        ]);
        const token = data?.session?.access_token;
        return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
        return {};
    }
}

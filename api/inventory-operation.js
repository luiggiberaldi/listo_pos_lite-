// Vercel Serverless Function — Operación de inventario (contrato único).
// Aplica una operación de inventario idempotente vía apply_inventory_operation.
// La unicidad de operation_id la garantiza inventory_operations dentro de la
// transacción de la RPC; este proxy solo valida y delega.

// La URL de producción debe venir de Vercel; el fallback conserva compatibilidad
// con despliegues antiguos, pero no debe ser la fuente principal.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fgzwmwrugerptfqfrsjd.supabase.co';

const CORS_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:4173',
    'https://listo-pos-lite.vercel.app',
    'https://listo-pos-lite.camelai.app',
    'https://listo-pos-lite.apps.camelai.dev',
];

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': CORS_ORIGINS.includes(origin) ? origin : '',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

// Autentica con el access token de Supabase del usuario (Authorization: Bearer).
// Estos endpoints escriben con la service key: no pueden confiar en el payload.
async function authenticateRequest(req, serviceKey) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user?.id ? user : null;
    } catch {
        return null;
    }
}

export default async function handler(req, res) {
    const origin = req.headers['origin'] || '';
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
    }

    const user = await authenticateRequest(req, SERVICE_KEY);
    if (!user) {
        return res.status(401).json({ error: 'No autorizado: inicia sesión para operar inventario.' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    // La cuenta sale del token, nunca del payload.
    payload.account_id = user.id;
    if (!payload.operation_id) {
        return res.status(400).json({ status: 'invalid', message: 'operation_id es obligatorio' });
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_inventory_operation`, {
        method: 'POST',
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload }),
    });
    const result = await rpcRes.json();
    return res.status(rpcRes.ok ? 200 : rpcRes.status).json(result);
}

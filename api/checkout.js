// Vercel Serverless Function — Checkout proxy
// Calls process_checkout RPC using service_role key. Fase 2 (fin): SIN upsert
// de productos desconocidos — el ID del carrito debe estar vinculado al
// catálogo canónico; la RPC responde 'unknown_product' explícito si no lo está.

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
    const headers = corsHeaders(origin);

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

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
        return res.status(401).json({ error: 'No autorizado: inicia sesión para registrar ventas.' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    // La cuenta sale del token, nunca del payload.
    payload.account_id = user.id;

    const { cart = [] } = payload;

    // Idempotencia persistente: si el servidor ya confirmó este operation_id
    // (queue_id), devolver la venta canónica ya procesada y su resultado de
    // inventario en lugar de ejecutar el checkout de nuevo. Este check es solo
    // un atajo: la unicidad la garantiza sales.queue_id dentro de la RPC.
    if (payload.queue_id) {
        const safeQueueId = encodeURIComponent(payload.queue_id);
        const duplicateResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/sales?queue_id=eq.${safeQueueId}&select=id,total,sync_origin,sale_items(quantity,product_id,products(stock))&limit=1`,
            { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
        );
        if (duplicateResponse.ok) {
            const existing = await duplicateResponse.json();
            const row = existing?.[0];
            if (row) {
                return res.status(200).json({
                    success: true,
                    duplicate: true,
                    sale_id: row.id,
                    total: row.total,
                    sync_origin: row.sync_origin,
                    inventory: (row.sale_items || []).map(si => ({
                        product_id: si.product_id,
                        quantity: si.quantity,
                        stock: si.products?.stock ?? null,
                    })),
                });
            }
        }
    }

    // Compatibilidad de transición (expand/contract): un cliente ANTERIOR no envía
    // stock_qty y sigue convirtiendo IDs legacy a UUID aleatorios; sin este paso,
    // process_checkout respondería 'unknown_product' y esa app vieja marcaría la
    // venta como sincronizada sin estar en el servidor. Para esos clientes se
    // conserva el upsert anterior (ON CONFLICT DO NOTHING, stock 0). Los clientes
    // nuevos (con stock_qty) registran su catálogo por /api/catalog-sync.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const legacyClient = cart.length > 0 && cart.every(item => item.stock_qty === undefined);
    const productsToUpsert = legacyClient
        ? cart
            .filter(item => item.id && UUID_RE.test(item.id))
            .map(item => ({
                id: item.id,
                name: item.name || `Producto ${item.id.slice(0, 8)}`,
                price: item.priceUsd || 0,
                stock: 0,
                cost_price: 0,
            }))
        : [];

    if (productsToUpsert.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/products`, {
            method: 'POST',
            headers: {
                apikey: SERVICE_KEY,
                Authorization: `Bearer ${SERVICE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=ignore-duplicates,return=minimal',
            },
            body: JSON.stringify(productsToUpsert),
        });
    }

    // Call process_checkout RPC (strip name from cart items)
    const payments = Array.isArray(payload.payments) ? payload.payments : [];
    const fiadoUsd = payload.fiadoUsd || 0;
    const paymentsSum = payments.reduce((s, p) => s + (p.amountUsd || 0), 0);
    const expectedSum = (payload.total || 0) - fiadoUsd;

    // RPC requires sum(payments) + fiadoUsd == total (double-entry balance).
    // In change scenarios the gross cash payment exceeds the sale total.
    // Scale all payments proportionally to the expected sum so they balance.
    const normalizedPayments = paymentsSum > expectedSum + 0.005
        ? payments.map(p => ({ ...p, amountUsd: Math.round(p.amountUsd / paymentsSum * expectedSum * 100) / 100 }))
        : payments;

    const rpcPayload = {
        ...payload,
        cart: cart.map(({ id, qty, stock_qty, priceUsd }) => ({ id, qty, stock_qty, priceUsd })),
        payments: normalizedPayments,
    };

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/process_checkout`, {
        method: 'POST',
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: rpcPayload }),
    });

    const result = await rpcRes.json();

    // La RPC guardó queue_id dentro de su misma transacción (migración 001 +
    // 006/007): la venta queda protegida contra duplicados ANTES de responder,
    // sin depender de un PATCH posterior.
    return res.status(rpcRes.ok ? 200 : rpcRes.status).json(result);
}

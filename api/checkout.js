// Vercel Serverless Function — Checkout proxy
// Upserts unknown products then calls process_checkout RPC using service_role key.

const SUPABASE_URL = 'https://fgzwmwrugerptfqfrsjd.supabase.co';

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
        'Access-Control-Allow-Headers': 'Content-Type',
    };
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

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { cart = [] } = payload;

    // Upsert unknown products (ON CONFLICT DO NOTHING)
    const productsToUpsert = cart
        .filter(item => item.id && item.name)
        .map(item => ({
            id: item.id,
            name: item.name,
            price: item.priceUsd || 0,
            stock: 0,
            cost_price: 0,
        }));

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
    const rpcPayload = {
        ...payload,
        cart: cart.map(({ id, qty, priceUsd }) => ({ id, qty, priceUsd })),
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
    return res.status(rpcRes.ok ? 200 : rpcRes.status).json(result);
}

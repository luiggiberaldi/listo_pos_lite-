/**
 * Cloudflare Worker — listo-pos-lite
 *
 * /api/share  — Upstash Redis relay for inventory share codes.
 * /api/checkout — Proxy seguro para process_checkout: upsertea productos
 *                 usando SUPABASE_SERVICE_KEY (secreto del worker, nunca expuesto
 *                 al cliente) y luego llama al RPC de Supabase.
 * Todo lo demás cae al SPA estático.
 */

const SUPABASE_URL = 'https://fgzwmwrugerptfqfrsjd.supabase.co';
const TTL_SECONDS = 86400; // 24 horas
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Upstash Redis REST helper ──────────────────────────────────────────────
async function redis(upstashUrl, upstashToken, command, ...args) {
    const res = await fetch(upstashUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${upstashToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify([command, ...args]),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
}

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const ALLOWED = [
        'http://localhost:5173',
        'http://localhost:4173',
        'https://listo-pos-lite.camelai.app',
        'https://listo-pos-lite.apps.camelai.dev',
        'https://tasasaldia.com',
        'https://www.tasasaldia.com',
    ];
    return {
        'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

// ── Checkout proxy handler ─────────────────────────────────────────────────
async function handleCheckout(request, env) {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

    const SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return Response.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
    }

    const { cart = [] } = payload;

    // Normaliza IDs de carrito: si un item tiene un ID legacy (no-UUID como "p-snack-4"),
    // le asigna un UUID nuevo para que PostgreSQL no rechace la inserción.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const normalizedCart = cart.map(item => ({
        ...item,
        id: item.id && UUID_RE.test(item.id) ? item.id : crypto.randomUUID(),
    }));

    // ── Paso 1: upsertear productos desconocidos (ON CONFLICT DO NOTHING) ──
    // name puede estar ausente en entradas de la cola offline guardadas antes del fix.
    const productsToUpsert = normalizedCart
        .filter(item => item.id)
        .map(item => ({
            id: item.id,
            name: item.name || `Producto ${item.id.slice(0, 8)}`,
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

    // ── Paso 2: llamar a process_checkout con el payload limpio ──
    // El RPC sólo necesita {id, qty, priceUsd} por item; quitamos "name".
    // El RPC requiere sum(payments) + fiadoUsd == total (doble entrada).
    // En ventas con cambio, el pago bruto supera el total. Se escalan
    // proporcionalmente los pagos al monto esperado antes de enviar al RPC.
    const paymentsList = Array.isArray(payload.payments) ? payload.payments : [];
    const fiadoUsd = payload.fiadoUsd || 0;
    const paymentsSum = paymentsList.reduce((s, p) => s + (p.amountUsd || 0), 0);
    const expectedSum = (payload.total || 0) - fiadoUsd;

    const normalizedPayments = paymentsSum > expectedSum + 0.005
        ? paymentsList.map(p => ({ ...p, amountUsd: Math.round(p.amountUsd / paymentsSum * expectedSum * 100) / 100 }))
        : paymentsList;

    const rpcPayload = {
        ...payload,
        cart: normalizedCart.map(({ id, qty, priceUsd }) => ({ id, qty, priceUsd })),
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
    return Response.json(result, { status: rpcRes.ok ? 200 : rpcRes.status, headers });
}

// ── Share API handler ──────────────────────────────────────────────────────
async function handleShare(request, env) {
    const headers = corsHeaders(request);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
    }

    const UPSTASH_URL = env.INT_OTHER_UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = env.INT_OTHER_UPSTASH_REDIS_REST_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        return Response.json(
            { error: 'Upstash Redis no configurado en el Worker.' },
            { status: 500, headers }
        );
    }

    const db = (cmd, ...args) => redis(UPSTASH_URL, UPSTASH_TOKEN, cmd, ...args);

    try {
        // ── POST: guardar datos y devolver código ──────────────────────────
        if (request.method === 'POST') {
            const body = await request.json();
            const { idb, ls, groups } = body;

            if (!idb || typeof idb !== 'object' || Object.keys(idb).length === 0) {
                return Response.json(
                    { error: 'No hay datos seleccionados para compartir.' },
                    { status: 400, headers }
                );
            }

            const payloadStr = JSON.stringify({ idb, ls: ls || {}, groups: groups || [] });
            if (payloadStr.length > MAX_PAYLOAD_BYTES) {
                return Response.json(
                    { error: `Payload demasiado grande (${(payloadStr.length / 1024 / 1024).toFixed(1)} MB). Máximo: 5 MB.` },
                    { status: 413, headers }
                );
            }

            // Generar código único
            let code;
            for (let i = 0; i < 5; i++) {
                code = generateCode();
                const exists = await db('EXISTS', `inv:${code}`);
                if (!exists) break;
            }

            await db('SET', `inv:${code}`, payloadStr, 'EX', TTL_SECONDS);

            const productCount = Array.isArray(idb['bodega_products_v1']) ? idb['bodega_products_v1'].length : 0;

            return Response.json(
                {
                    code: `${code.slice(0, 3)}-${code.slice(3)}`,
                    expiresIn: '24 horas',
                    productCount,
                },
                { status: 200, headers }
            );
        }

        // ── GET: recuperar datos por código ───────────────────────────────
        if (request.method === 'GET') {
            const code = url.searchParams.get('code');
            if (!code) {
                return Response.json({ error: 'Código requerido.' }, { status: 400, headers });
            }

            const cleanCode = code.replace(/[-\s]/g, '');
            if (cleanCode.length !== 6 || !/^\d+$/.test(cleanCode)) {
                return Response.json(
                    { error: 'Código inválido. Usa el formato XXX-XXX.' },
                    { status: 400, headers }
                );
            }

            const data = await db('GET', `inv:${cleanCode}`);
            if (!data) {
                return Response.json(
                    { error: 'Código no encontrado o expirado.' },
                    { status: 404, headers }
                );
            }

            return Response.json(JSON.parse(data), { status: 200, headers });
        }

        return Response.json({ error: 'Método no permitido.' }, { status: 405, headers });

    } catch (err) {
        console.error('[share] error:', err);
        return Response.json({ error: 'Error interno del servidor.' }, { status: 500, headers });
    }
}

// ── Main fetch handler ─────────────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api/share')) {
            return handleShare(request, env);
        }

        if (url.pathname.startsWith('/api/checkout')) {
            return handleCheckout(request, env);
        }

        // Static SPA assets for everything else
        return env.ASSETS.fetch(request);
    },
};

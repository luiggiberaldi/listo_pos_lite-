/**
 * Cloudflare Worker — listo-pos-lite
 *
 * Handles /api/share (Upstash Redis relay for inventory share codes).
 * All other requests fall through to the static SPA assets.
 */

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
            const { products, categories, customers, sales } = body;

            const hasProducts  = Array.isArray(products)  && products.length  > 0;
            const hasCustomers = Array.isArray(customers) && customers.length > 0;
            const hasSales     = Array.isArray(sales)     && sales.length     > 0;

            if (!hasProducts && !hasCustomers && !hasSales) {
                return Response.json(
                    { error: 'No hay datos seleccionados para compartir.' },
                    { status: 400, headers }
                );
            }

            const payloadStr = JSON.stringify({ products, categories, customers, sales });
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

            const payload = JSON.stringify({
                products: hasProducts ? products : null,
                categories: categories || null,
                customers: hasCustomers ? customers : null,
                sales: hasSales ? sales : null,
                createdAt: new Date().toISOString(),
                count: (products?.length || 0) + (customers?.length || 0) + (sales?.length || 0),
            });

            await db('SET', `inv:${code}`, payload, 'EX', TTL_SECONDS);

            return Response.json(
                {
                    code: `${code.slice(0, 3)}-${code.slice(3)}`,
                    expiresIn: '24 horas',
                    productCount: products?.length || 0,
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

        // Static SPA assets for everything else
        return env.ASSETS.fetch(request);
    },
};

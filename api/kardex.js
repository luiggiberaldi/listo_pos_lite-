// Vercel Serverless Function — Kardex (Fase 5): libreta de movimientos.
// GET  /api/kardex                   → estado de la apertura de la cuenta
// GET  /api/kardex?product_id=<uuid>  → apertura + movimientos del producto
// GET  /api/kardex?list=1&from&to&types&product_ids&before_id → pantalla Movimientos
// POST /api/kardex {products,actor}   → open_kardex (una sola vez por cuenta)
// Todo filtrado por la cuenta del token; nunca por un dato del cliente.

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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KARDEX_FIELDS = 'id,operation_id,product_id,operation_type,mode,quantity,unit_mode,delta,stock_before,stock_after,reason,origin_ref,actor,device_id,created_at';
const KARDEX_TYPES = ['VENTA', 'AJUSTE_DIRECTO', 'CONTEO', 'VACIADO', 'ANULACION', 'APERTURA'];

// Pantalla Movimientos: filtros validados → consulta REST (página por id
// descendente) + parámetros del resumen. Nunca se pasa texto libre a la URL.
// El Kardex empieza en la apertura: nada anterior a openedAt se muestra.
function parseMovementFilters(get, openedAt) {
    const iso = v => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
    const requested = iso(get('from'));
    const start = iso(openedAt);
    const from = requested && start ? (requested > start ? requested : start) : (requested || start);
    const to = iso(get('to'));
    const types = (get('types') || '').split(',').filter(t => KARDEX_TYPES.includes(t));
    const productIds = (get('product_ids') || '').split(',').filter(id => UUID_RE.test(id)).slice(0, 100);
    const beforeId = Number.parseInt(get('before_id') || '', 10);
    const limit = Math.min(Math.max(Number.parseInt(get('limit') || '50', 10) || 50, 1), 100);
    let query = `select=${KARDEX_FIELDS}&order=id.desc&limit=${limit}`;
    if (from) query += `&created_at=gte.${encodeURIComponent(from)}`;
    if (to) query += `&created_at=lt.${encodeURIComponent(to)}`;
    if (types.length) query += `&operation_type=in.(${types.join(',')})`;
    if (productIds.length) query += `&product_id=in.(${productIds.join(',')})`;
    if (Number.isFinite(beforeId) && beforeId > 0) query += `&id=lt.${beforeId}`;
    return {
        query,
        firstPage: !(Number.isFinite(beforeId) && beforeId > 0),
        limit,
        summary: { from, to, types: types.length ? types : null, product_ids: productIds.length ? productIds : null },
    };
}

export default async function handler(req, res) {
    const origin = req.headers['origin'] || '';
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
    }

    const user = await authenticateRequest(req, SERVICE_KEY);
    if (!user) {
        return res.status(401).json({ error: 'No autorizado: inicia sesión para ver el Kardex.' });
    }
    const dbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
    const account = encodeURIComponent(user.id);

    if (req.method === 'POST') {
        const body = req.body;
        const products = Array.isArray(body?.products) ? body.products : null;
        if (!products) {
            return res.status(400).json({ status: 'invalid', message: 'products debe ser una lista' });
        }
        const payload = {
            account_id: user.id,
            actor: typeof body.actor === 'string' ? body.actor.slice(0, 120) : null,
            device_id: typeof body.device_id === 'string' ? body.device_id.slice(0, 120) : null,
            products: products.map(p => ({ id: p?.id, stock: p?.stock })),
        };
        const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/open_kardex`, {
            method: 'POST', headers: dbHeaders, body: JSON.stringify({ payload }),
        });
        const result = await rpcRes.json();
        return res.status(rpcRes.ok ? 200 : rpcRes.status).json(result);
    }

    if (req.query?.list !== undefined) {
        const openRes = await fetch(`${SUPABASE_URL}/rest/v1/kardex_openings?account_id=eq.${account}&select=opened_at&limit=1`, { headers: dbHeaders });
        if (!openRes.ok) return res.status(502).json({ error: 'No se pudo leer el Kardex' });
        const openedAt = (await openRes.json())[0]?.opened_at;
        if (!openedAt) return res.status(200).json({ movements: [], summary: { count: 0, entradas: 0, salidas: 0 }, hasMore: false });
        const f = parseMovementFilters(k => (typeof req.query?.[k] === 'string' ? req.query[k] : null), openedAt);
        const listRes = await fetch(`${SUPABASE_URL}/rest/v1/inventory_operations?account_id=eq.${account}&${f.query}`, { headers: dbHeaders });
        if (!listRes.ok) return res.status(502).json({ error: 'No se pudo leer el Kardex' });
        const movements = await listRes.json();
        let summary = null;
        if (f.firstPage) {
            const sumRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kardex_summary`, {
                method: 'POST', headers: dbHeaders, body: JSON.stringify({ payload: { account_id: user.id, ...f.summary } }),
            });
            summary = sumRes.ok ? await sumRes.json() : null;
        }
        return res.status(200).json({ movements, summary, hasMore: movements.length === f.limit });
    }

    const productId = typeof req.query?.product_id === 'string' ? req.query.product_id : null;
    if (productId && !UUID_RE.test(productId)) {
        return res.status(400).json({ status: 'invalid', message: 'product_id inválido' });
    }

    const openingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/kardex_openings?account_id=eq.${account}&select=opened_at,actor,product_count&limit=1`,
        { headers: dbHeaders },
    );
    if (!openingRes.ok) {
        return res.status(502).json({ error: 'No se pudo leer el Kardex' });
    }
    const opening = (await openingRes.json())[0] || null;
    if (!productId) return res.status(200).json({ opening });

    const movRes = await fetch(
        `${SUPABASE_URL}/rest/v1/inventory_operations?account_id=eq.${account}&product_id=eq.${productId}&select=${KARDEX_FIELDS}&order=id.asc&limit=2000`,
        { headers: dbHeaders },
    );
    if (!movRes.ok) {
        return res.status(502).json({ error: 'No se pudo leer el Kardex' });
    }
    return res.status(200).json({ opening, movements: await movRes.json() });
}

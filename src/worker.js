/**
 * Cloudflare Worker — listo-pos-lite
 *
 * /api/share  — Upstash Redis relay for inventory share codes.
 * /api/checkout — Proxy seguro para process_checkout usando SUPABASE_SERVICE_KEY
 *                 (secreto del worker, nunca expuesto al cliente). SIN upsert de
 *                 productos: el ID del carrito debe estar vinculado al catálogo.
 * /api/inventory-operation — Contrato único de operación de inventario:
 *                 aplica apply_inventory_operation (idempotente por operation_id).
 * /api/catalog-sync — Catálogo solo-metadatos (sync_product_catalog).
 * Todo lo demás cae al SPA estático.
 */

const SUPABASE_URL = 'https://fgzwmwrugerptfqfrsjd.supabase.co';
const TTL_SECONDS = 86400; // 24 horas
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// Resultados ya emitidos por queue_id en esta instancia del worker (atajo en
// memoria). La garantía de unicidad vive en sales.queue_id dentro de la RPC;
// esto solo evita egress en reintentos inmediatos.
const _processedResults = new Map();

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
        'https://listo-pos-lite.vercel.app',
        'https://tasasaldia.com',
        'https://www.tasasaldia.com',
    ];
    return {
        'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

/**
 * Autentica la petición con el access token de Supabase del usuario
 * (Authorization: Bearer <token>). Devuelve el usuario o null.
 * Los endpoints que escriben con SUPABASE_SERVICE_KEY (checkout, inventario) NO
 * pueden confiar en el payload: sin esto cualquiera que conozca la URL podía
 * registrar ventas o mover stock de cualquier cuenta.
 */
async function authenticateRequest(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !env.SUPABASE_SERVICE_KEY) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user?.id ? user : null;
    } catch {
        return null;
    }
}

// ── Update Profile handler (Admin API — service key never exposed al cliente) ─
async function handleUpdateProfile(request, env) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

    const SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) return Response.json({ error: 'Not configured' }, { status: 500, headers });

    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers }); }

    const { accessToken, businessName, phone } = body;
    if (!accessToken) return Response.json({ error: 'accessToken required' }, { status: 400, headers });

    // 1. Verificar el access token y obtener el UID del usuario
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) return Response.json({ error: 'Token inválido' }, { status: 401, headers });
    const user = await userRes.json();
    if (!user?.id) return Response.json({ error: 'Usuario no encontrado' }, { status: 404, headers });

    // 2. Actualizar vía Admin API (servicio — nunca expuesto al frontend)
    const updateBody = { user_metadata: { ...user.user_metadata } };
    if (businessName) updateBody.user_metadata.full_name = businessName;
    if (phone) updateBody.phone = phone;

    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: 'PUT',
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateBody),
    });

    if (!updateRes.ok) {
        const err = await updateRes.text();
        return Response.json({ error: err }, { status: updateRes.status, headers });
    }

    return Response.json({ ok: true }, { headers });
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

    const user = await authenticateRequest(request, env);
    if (!user) {
        return Response.json({ error: 'No autorizado: inicia sesión para registrar ventas.' }, { status: 401, headers });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
    }
    // La cuenta sale del token, nunca del payload.
    payload.account_id = user.id;

    const { cart = [] } = payload;

    // ── Idempotencia: un reintento del mismo operation_id devuelve la venta
    // canónica ya procesada (sale_id + resultado de inventario), sin repetir
    // descuentos. Estos checks son SOLO atajos: la unicidad la garantiza el
    // índice sales.queue_id dentro de la transacción de la RPC.
    if (payload.queue_id) {
        // 1. Atajo en memoria (rápido, sin egress)
        const cached = _processedResults.get(payload.queue_id);
        if (cached) {
            return Response.json({ success: true, duplicate: true, ...cached }, { headers });
        }
        // 2. Atajo persistente en DB (sobrevive reinicios del worker)
        const safeQueueId = encodeURIComponent(payload.queue_id);
        const dupCheck = await fetch(
            `${SUPABASE_URL}/rest/v1/sales?queue_id=eq.${safeQueueId}&select=id,total,sync_origin,sale_items(quantity,product_id,products(stock))&limit=1`,
            { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
        );
        if (dupCheck.ok) {
            const existing = await dupCheck.json();
            const row = existing?.[0];
            if (row) {
                const duplicateResult = {
                    sale_id: row.id,
                    total: row.total,
                    sync_origin: row.sync_origin,
                    inventory: (row.sale_items || []).map(si => ({
                        product_id: si.product_id,
                        quantity: si.quantity,
                        stock: si.products?.stock ?? null,
                    })),
                };
                _processedResults.set(payload.queue_id, duplicateResult);
                return Response.json({ success: true, duplicate: true, ...duplicateResult }, { headers });
            }
        }
    }

    // Fase 2 (fin): SIN upsert de productos desconocidos ni renominación de
    // IDs legacy. Todo item del carrito debe estar vinculado al catálogo
    // canónico (mismo UUID del catálogo local); process_checkout responde
    // 'unknown_product' explícito y resoluble para los IDs no vinculados,
    // sin aplicar nada y sin crear productos fantasma.

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

    // ── Llamar a process_checkout con el payload limpio ──
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

    // La RPC ya guardó queue_id dentro de su MISMA transacción (migración
    // 001 + 006/007): el PATCH posterior es innecesario y queda retirado.
    // Solo se cachea el resultado para reintentos inmediatos de esta instancia.
    if (rpcRes.ok && payload.queue_id && result?.sale_id) {
        _processedResults.set(payload.queue_id, {
            sale_id: result.sale_id,
            total: result.total,
            sync_origin: result.sync_origin,
            inventory: result.inventory || [],
        });
        if (_processedResults.size > 500) _processedResults.clear();
    }

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

// ── BCV rates proxy ─────────────────────────────────────────────────────────
async function handleRates(request) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

    try {
        const response = await fetch('https://bcv.today/api/v1/rate.json', {
            headers: { Accept: 'application/json' },
            cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (!response.ok) throw new Error(`BCV respondió ${response.status}`);

        const data = await response.json();
        const usd = Number(data?.USD ?? data?.usd);
        const eur = Number(data?.EUR ?? data?.eur);
        if ((!Number.isFinite(usd) || usd <= 0) && (!Number.isFinite(eur) || eur <= 0)) {
            throw new Error('El feed BCV no contiene tasas válidas');
        }

        const validDate = data?.effective_date || data?.effectiveDate || data?.date || null;
        const observedAt = data?.updated_at || data?.updatedAt || null;
        return Response.json({
            bcv: { price: usd > 0 ? usd : 0, validDate, observedAt, source: 'BCV (datos bcv.org.ve)' },
            euro: { price: eur > 0 ? eur : 0, validDate, observedAt, source: 'BCV (datos bcv.org.ve)' },
            lastUpdate: new Date().toISOString(),
        }, { status: 200, headers });
    } catch (error) {
        console.error('[rates] Error consultando BCV:', error);
        return Response.json({ error: 'No se pudo consultar la tasa BCV' }, { status: 502, headers });
    }
}

// ── Inventory operation handler (contrato único de inventario) ──
async function handleInventoryOperation(request, env) {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

    const SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return Response.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers });
    }

    const user = await authenticateRequest(request, env);
    if (!user) {
        return Response.json({ error: 'No autorizado: inicia sesión para operar inventario.' }, { status: 401, headers });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
    }
    // La cuenta sale del token, nunca del payload.
    if (payload && typeof payload === 'object') payload.account_id = user.id;

    if (!payload?.operation_id) {
        return Response.json({ status: 'invalid', message: 'operation_id es obligatorio' }, { status: 400, headers });
    }

    // La unicidad de operation_id la garantiza idx_inventory_operations_operation_id
    // dentro de la transacción de la RPC (apply_inventory_operation). Este proxy
    // solo valida y delega: un reintento con el mismo ID devuelve already_processed
    // con el resultado canónico, sin aplicar el delta dos veces.
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
    return Response.json(result, { status: rpcRes.ok ? 200 : rpcRes.status, headers });
}

// ── Catalog sync handler (catálogo solo-metadatos, Fase 2) ──
async function handleCatalogSync(request, env) {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

    const SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return Response.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers });
    }

    const user = await authenticateRequest(request, env);
    if (!user) {
        return Response.json({ error: 'No autorizado: inicia sesión para sincronizar el catálogo.' }, { status: 401, headers });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
    }

    const products = Array.isArray(payload?.products) ? payload.products : null;
    if (!products || products.length === 0) {
        return Response.json({ status: 'invalid', message: 'products vacío' }, { status: 400, headers });
    }

    // sync_product_catalog separa metadatos de existencias: el stock de la
    // lista solo fija el saldo inicial al crear la fila y se ignora en updates.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_product_catalog`, {
        method: 'POST',
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        // account_id del token: el alta de un producto queda en la libreta de la cuenta.
        body: JSON.stringify({ payload: { products, account_id: user.id } }),
    });
    const result = await rpcRes.json();
    return Response.json(result, { status: rpcRes.ok ? 200 : rpcRes.status, headers });
}

// ── Kardex (Fase 5): leer la libreta de un producto y corte de apertura ──
// GET  /api/kardex                  → estado de la apertura de la cuenta
// GET  /api/kardex?product_id=<uuid> → apertura + movimientos del producto
// GET  /api/kardex?list=1&from&to&types&product_ids&before_id → pantalla Movimientos
// POST /api/kardex {products,actor}  → open_kardex (una sola vez por cuenta)
// Todo filtrado por la cuenta del token; nunca por un dato del cliente.
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

async function handleKardex(request, env) {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET' && request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
    }

    const SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
    if (!SERVICE_KEY) {
        return Response.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers });
    }

    const user = await authenticateRequest(request, env);
    if (!user) {
        return Response.json({ error: 'No autorizado: inicia sesión para ver el Kardex.' }, { status: 401, headers });
    }
    const dbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
    const account = encodeURIComponent(user.id);

    if (request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch {
            return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
        }
        const products = Array.isArray(body?.products) ? body.products : null;
        if (!products) {
            return Response.json({ status: 'invalid', message: 'products debe ser una lista' }, { status: 400, headers });
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
        return Response.json(result, { status: rpcRes.ok ? 200 : rpcRes.status, headers });
    }

    const url = new URL(request.url);
    if (url.searchParams.has('list')) {
        const openRes = await fetch(`${SUPABASE_URL}/rest/v1/kardex_openings?account_id=eq.${account}&select=opened_at&limit=1`, { headers: dbHeaders });
        if (!openRes.ok) return Response.json({ error: 'No se pudo leer el Kardex' }, { status: 502, headers });
        const openedAt = (await openRes.json())[0]?.opened_at;
        if (!openedAt) return Response.json({ movements: [], summary: { count: 0, entradas: 0, salidas: 0 }, hasMore: false }, { status: 200, headers });
        const f = parseMovementFilters(k => url.searchParams.get(k), openedAt);
        const listRes = await fetch(`${SUPABASE_URL}/rest/v1/inventory_operations?account_id=eq.${account}&${f.query}`, { headers: dbHeaders });
        if (!listRes.ok) return Response.json({ error: 'No se pudo leer el Kardex' }, { status: 502, headers });
        const movements = await listRes.json();
        let summary = null;
        if (f.firstPage) {
            const sumRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kardex_summary`, {
                method: 'POST', headers: dbHeaders, body: JSON.stringify({ payload: { account_id: user.id, ...f.summary } }),
            });
            summary = sumRes.ok ? await sumRes.json() : null;
        }
        return Response.json({ movements, summary, hasMore: movements.length === f.limit }, { status: 200, headers });
    }
    const productId = url.searchParams.get('product_id');
    if (productId && !UUID_RE.test(productId)) {
        return Response.json({ status: 'invalid', message: 'product_id inválido' }, { status: 400, headers });
    }

    const openingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/kardex_openings?account_id=eq.${account}&select=opened_at,actor,product_count&limit=1`,
        { headers: dbHeaders },
    );
    if (!openingRes.ok) {
        return Response.json({ error: 'No se pudo leer el Kardex' }, { status: 502, headers });
    }
    const opening = (await openingRes.json())[0] || null;
    if (!productId) return Response.json({ opening }, { status: 200, headers });

    const movRes = await fetch(
        `${SUPABASE_URL}/rest/v1/inventory_operations?account_id=eq.${account}&product_id=eq.${productId}&select=${KARDEX_FIELDS}&order=id.asc&limit=2000`,
        { headers: dbHeaders },
    );
    if (!movRes.ok) {
        return Response.json({ error: 'No se pudo leer el Kardex' }, { status: 502, headers });
    }
    return Response.json({ opening, movements: await movRes.json() }, { status: 200, headers });
}

// ── Main fetch handler ─────────────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api/update-profile')) {
            return handleUpdateProfile(request, env);
        }

        if (url.pathname.startsWith('/api/share')) {
            return handleShare(request, env);
        }

        if (url.pathname.startsWith('/api/rates')) {
            return handleRates(request);
        }

        if (url.pathname.startsWith('/api/checkout')) {
            return handleCheckout(request, env);
        }

        if (url.pathname.startsWith('/api/inventory-operation')) {
            return handleInventoryOperation(request, env);
        }

        if (url.pathname.startsWith('/api/catalog-sync')) {
            return handleCatalogSync(request, env);
        }

        if (url.pathname.startsWith('/api/kardex')) {
            return handleKardex(request, env);
        }

        // Static SPA assets for everything else
        return env.ASSETS.fetch(request);
    },
};

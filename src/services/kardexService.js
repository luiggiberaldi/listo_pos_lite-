/**
 * Kardex (Fase 5) — cliente de /api/kardex.
 *
 *   fetchKardexStatus()        → { opening } de la cuenta (null si no se inició)
 *   fetchProductKardex(id)     → { opening, movements } del producto
 *   openKardex({ products })   → sube el catálogo y hace el corte de apertura
 *
 * La cuenta la decide el servidor a partir del token, nunca este cliente.
 */

import { getAuthHeaders } from './authHeaders.js';
import { pushCatalogSync } from './catalogSyncService.js';
import { buildOpeningPayload } from '../utils/kardexLedger.js';

function timeoutSignal(ms) {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(ms)
        : undefined;
}

async function readJson(res) {
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        const message = body?.error || body?.message || `HTTP ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        throw err;
    }
    return body;
}

export async function fetchKardexStatus({ fetchImpl, authHeaders } = {}) {
    const doFetch = fetchImpl || fetch;
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    const res = await doFetch('/api/kardex', { headers: { ...auth }, signal: timeoutSignal(10000) });
    return readJson(res);
}

export async function fetchProductKardex(productId, { fetchImpl, authHeaders } = {}) {
    const doFetch = fetchImpl || fetch;
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    const res = await doFetch(`/api/kardex?product_id=${encodeURIComponent(productId)}`, {
        headers: { ...auth },
        signal: timeoutSignal(10000),
    });
    return readJson(res);
}

/**
 * Pantalla Movimientos: una página (más recientes primero) con filtros.
 * Devuelve { movements, summary (solo 1.ª página), hasMore }.
 */
export async function fetchMovements({ from = null, to = null, types = [], productIds = [], beforeId = null, limit = 50 } = {}, { fetchImpl, authHeaders } = {}) {
    const doFetch = fetchImpl || fetch;
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    const params = new URLSearchParams({ list: '1', limit: String(limit) });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (types.length) params.set('types', types.join(','));
    if (productIds.length) params.set('product_ids', productIds.slice(0, 100).join(','));
    if (beforeId) params.set('before_id', String(beforeId));
    const res = await doFetch(`/api/kardex?${params.toString()}`, { headers: { ...auth }, signal: timeoutSignal(15000) });
    return readJson(res);
}

/**
 * Corte de apertura. Primero registra el catálogo (para que el servidor
 * conozca todos los productos) y luego envía el stock que ve el usuario.
 * El servidor lo hace una sola vez por cuenta (already_opened si se repite).
 */
export async function openKardex({ products, actor = null, deviceId = null, fetchImpl, authHeaders, pushCatalog = pushCatalogSync } = {}) {
    const doFetch = fetchImpl || fetch;
    const rows = buildOpeningPayload(products);
    if (rows.length === 0) {
        return { status: 'invalid', message: 'No hay productos para abrir el Kardex.' };
    }
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());

    const catalog = await pushCatalog(products, fetchImpl ? { fetchImpl, authHeaders: auth } : undefined);
    if (catalog?.status !== 'ok') {
        return { status: 'catalog_failed', message: catalog?.message || catalog?.error || 'No se pudo registrar el catálogo.' };
    }

    const res = await doFetch('/api/kardex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ products: rows, actor, device_id: deviceId }),
        // Con miles de productos la transacción tarda más que una venta.
        signal: timeoutSignal(60000),
    });
    const result = await readJson(res);
    return { ...result, sent: rows.length, skippedLocal: (Array.isArray(products) ? products.length : 0) - rows.length };
}

/**
 * Catálogo solo-metadatos (Fase 2 pre-Kardex).
 *
 * La lista local de productos se registra/actualiza en el catálogo canónico
 * (tabla products) SEPARADA de las mutaciones de stock:
 *   - buildCatalogSyncPayload selecciona solo campos de catálogo (id, nombre,
 *     precios, código de barras, categoría) y envía el stock únicamente como
 *     SALDO INICIAL — el servidor lo ignora por completo en actualizaciones,
 *     de modo que una lista desactualizada jamás sobrescribe existencias.
 *   - pushCatalogSync la envía a /api/catalog-sync (RPC sync_product_catalog).
 *
 * Este contrato NUNCA renombra identidades: el id debe ser el UUID canónico
 * del catálogo local; los IDs no-UUID se reportan como rechazados.
 */

import { getAuthHeaders } from './authHeaders.js';
import { canonicalStringify, computePushHash } from '../sync/syncHash.js';

// Tamaño de cada tanda: con miles de productos un solo envío tardaba más que
// el límite del servidor y fallaba entero.
export const CATALOG_BATCH_SIZE = 300;
// Huella por producto de lo que el servidor ya confirmó (por cuenta).
export const CATALOG_HASHES_KEY = '_catalog_sync_hashes';

export function buildCatalogSyncPayload(products = []) {
    if (!Array.isArray(products)) return [];
    const rows = [];
    for (const p of products) {
        if (!p || !p.id) continue;
        const row = { id: p.id };
        const name = p.name != null ? String(p.name).trim() : '';
        if (name) row.name = name;

        const price = Number(p.priceUsdt ?? p.priceUsd);
        if (Number.isFinite(price)) row.price = price;

        const cost = Number(p.costUsd);
        if (Number.isFinite(cost)) row.cost_price = cost;

        const barcode = p.barcode != null ? String(p.barcode).trim() : '';
        if (barcode) row.barcode = barcode;

        const category = p.category != null ? String(p.category).trim() : '';
        if (category) row.category = category;

        // Saldo inicial (solo al CREAR la fila). En actualizaciones el servidor
        // ignora este campo: los metadatos de catálogo no mutan existencias.
        const stock = Number(p.stock);
        if (Number.isFinite(stock)) row.stock = stock;

        rows.push(row);
    }
    return rows;
}

export async function pushCatalogSync(products, opts = {}) {
    return sendCatalogRows(buildCatalogSyncPayload(products), opts);
}

/** Envía filas ya armadas en tandas; 'ok' solo si todas las tandas lo fueron. */
async function sendCatalogRows(rows, { fetchImpl, authHeaders, batchSize = CATALOG_BATCH_SIZE } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch no está disponible');
    const total = { status: 'ok', created: [], updated: [], rejected: [], warnings: [] };
    if (rows.length === 0) return total;

    // /api/catalog-sync escribe con la service key: exige la sesión del usuario.
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    for (let i = 0; i < rows.length; i += batchSize) {
        const res = await doFetch('/api/catalog-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ products: rows.slice(i, i + batchSize) }),
            // Sin respuesta en 10 s se aborta: la cola de ventas no debe quedar
            // esperando al catálogo indefinidamente.
            signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(10000)
                : undefined,
        });
        const result = await res.json().catch(() => ({ status: 'error', httpStatus: res.status }));
        if (result?.status !== 'ok') return result;
        for (const k of ['created', 'updated', 'rejected', 'warnings']) {
            if (Array.isArray(result[k])) total[k].push(...result[k]);
        }
    }
    return total;
}

// La huella no incluye el stock: el servidor solo lo usa al crear el producto,
// así que un cambio de existencias no obliga a reenviar el producto.
function catalogRowHash(row) {
    const { stock: _stock, ...meta } = row;
    return computePushHash(canonicalStringify(meta));
}

function readCatalogHashes(storage, key) {
    try { return JSON.parse(storage?.getItem(key) || '{}') || {}; } catch { return {}; }
}

/**
 * Sube SOLO los productos nuevos o con nombre/precio/código/categoría
 * distintos a lo último que el servidor confirmó. Antes cada cambio de
 * inventario mandaba los ~2000 productos y el servidor los reescribía todos,
 * lo que agotaba el presupuesto de disco de Supabase.
 */
export async function pushChangedCatalog(products, { storage = globalThis.localStorage, storageKey, ...opts } = {}) {
    const key = storageKey || CATALOG_HASHES_KEY;
    const known = readCatalogHashes(storage, key);
    const rows = buildCatalogSyncPayload(products);
    const pending = [];
    const hashes = {};
    for (const row of rows) {
        const h = catalogRowHash(row);
        hashes[row.id] = h;
        if (known[row.id] !== h) pending.push(row);
    }
    if (pending.length === 0) return { status: 'ok', created: [], updated: [], rejected: [], warnings: [], sent: 0 };

    const result = await sendCatalogRows(pending, opts);
    if (result?.status === 'ok') {
        // Los rechazados se vuelven a intentar la próxima vez.
        const rejected = new Set((result.rejected || []).map(r => String(r?.id)));
        const next = {};
        for (const row of rows) {
            if (!rejected.has(String(row.id))) next[row.id] = hashes[row.id];
        }
        try { storage?.setItem(key, JSON.stringify(next)); } catch { /* sin cuota: se reenvía la próxima vez */ }
    }
    return { ...result, sent: pending.length };
}

/**
 * Salida automática para 'unknown_product' (riesgo de transición): antes el
 * proxy de checkout creaba en el servidor los productos que no conocía; ahora
 * el catálogo se registra por /api/catalog-sync. Si una venta llega antes de
 * que su producto se haya subido, se registra el catálogo local completo (sin
 * tocar existencias de filas ya existentes) para reintentar la MISMA venta.
 * Devuelve true solo si el servidor confirmó el registro.
 */
export async function resyncLocalCatalog({ loadProducts, push = pushCatalogSync } = {}) {
    try {
        const products = loadProducts
            ? await loadProducts()
            : await (await import('../utils/storageService.js')).storageService.getItem('bodega_products_v1', []);
        if (!Array.isArray(products) || products.length === 0) return false;
        const result = await push(products);
        return result?.status === 'ok';
    } catch {
        return false;
    }
}

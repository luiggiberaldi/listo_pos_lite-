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

export async function pushCatalogSync(products, { fetchImpl, authHeaders } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch no está disponible');
    const rows = buildCatalogSyncPayload(products);
    if (rows.length === 0) return { status: 'ok', created: [], updated: [], rejected: [] };

    // /api/catalog-sync escribe con la service key: exige la sesión del usuario.
    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    const res = await doFetch('/api/catalog-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ products: rows }),
    });
    return res.json().catch(() => ({ status: 'error', httpStatus: res.status }));
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

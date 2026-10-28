import test from 'node:test';
import assert from 'node:assert/strict';

import {
    conflictSaleStatus,
    isResolvableConflictStatus,
    toConflictedState,
} from '../src/services/offlineQueuePolicy.js';
import {
    buildCatalogSyncPayload,
    pushCatalogSync,
} from '../src/services/catalogSyncService.js';

test('conflictos funcionales del servidor: stock_conflict y unknown_product', () => {
    assert.equal(isResolvableConflictStatus('stock_conflict'), true);
    assert.equal(isResolvableConflictStatus('unknown_product'), true);
    assert.equal(isResolvableConflictStatus('error'), false);
    assert.equal(isResolvableConflictStatus(undefined), false);
});

test('el estado local distingue conflicto de stock y de catálogo', () => {
    assert.equal(conflictSaleStatus({ status: 'stock_conflict' }), 'CONFLICTO_STOCK');
    assert.equal(conflictSaleStatus({ status: 'unknown_product' }), 'CONFLICTO_CATALOGO');
    assert.equal(conflictSaleStatus(null), 'CONFLICTO_STOCK');
});

test('unknown_product preserva la venta como conflicto resoluble con su detalle', () => {
    const item = { id: 1, queue_id: 'op-1', sync_status: 'pending' };
    const conflict = {
        status: 'unknown_product',
        message: 'El carrito referencia productos no vinculados al catálogo',
        unknown_products: [{ id: 'p-snack-4', reason: 'id no-UUID' }],
    };
    const conflicted = toConflictedState(item, conflict);
    assert.equal(conflicted.sync_status, 'conflicted');
    assert.equal(conflicted.conflict.status, 'unknown_product');
    assert.deepEqual(conflicted.conflict.unknown_products, conflict.unknown_products);
});

test('buildCatalogSyncPayload: solo metadatos + stock como saldo inicial', () => {
    const rows = buildCatalogSyncPayload([
        {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Harina PAN 1kg',
            priceUsdt: 1.1,
            priceUsd: 999, // legacy: manda priceUsdt
            costUsd: 0.75,
            barcode: '7591234567890',
            category: 'abarrotes',
            stock: 12,
            image: 'data:image/png;base64,AAAA',
            stockInLotes: 4,
            unitsPerPackage: 6,
        },
        { id: null, name: 'sin id: se omite' },
        { id: '00000000-0000-4000-8000-000000000002', name: 'Sin precio', stock: 0 },
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Harina PAN 1kg',
        price: 1.1,
        cost_price: 0.75,
        barcode: '7591234567890',
        category: 'abarrotes',
        stock: 12,
    });
    assert.equal('image' in rows[0], false);
    assert.equal('stockInLotes' in rows[0], false);
    assert.equal('unitsPerPackage' in rows[0], false);
    assert.deepEqual(rows[1], {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Sin precio',
        stock: 0,
    });
});

test('pushCatalogSync envía la lista a /api/catalog-sync sin renombrar identidades', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return { json: async () => ({ status: 'ok', created: [], updated: [], rejected: [] }) };
    };
    await pushCatalogSync([{ id: 'p-snack-4', name: 'X', stock: 1 }], { fetchImpl });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/catalog-sync');
    assert.equal(seen[0].body.products[0].id, 'p-snack-4');
});

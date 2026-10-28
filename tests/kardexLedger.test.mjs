import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKardexView, pendingKardexEntries, buildOpeningPayload } from '../src/utils/kardexLedger.js';
import { openKardex, fetchProductKardex } from '../src/services/kardexService.js';

const P = '11111111-1111-4111-8111-111111111111';
const row = (id, type, delta, before, after, extra = {}) => ({
    id, operation_type: type, delta, stock_before: before, stock_after: after,
    created_at: `2026-10-28T10:00:0${id}Z`, ...extra,
});

test('Kardex: sin APERTURA no se atribuye nada', () => {
    const view = buildKardexView([row(1, 'AJUSTE_DIRECTO', 3, 0, 3)]);
    assert.equal(view.started, false);
    assert.deepEqual(view.rows, []);
});

test('Kardex: recorta desde la última apertura y cuadra apertura + movimientos = saldo', () => {
    const view = buildKardexView([
        row(4, 'ANULACION', 12, 26, 38, { origin_ref: 'v1' }),
        row(1, 'AJUSTE_DIRECTO', 5, 0, 5),                       // antes del corte: fuera
        row(2, 'APERTURA', 45, 5, 50, { reason: 'Corte de apertura' }),
        row(3, 'VENTA', -24, 50, 26, { origin_ref: 'v1' }),
        row(5, 'CONTEO', -2, 38, 36),
    ]);
    assert.equal(view.started, true);
    assert.equal(view.opening.saldo, 50);
    assert.deepEqual(view.rows.map(r => r.label), ['Apertura', 'Venta', 'Anulación', 'Conteo']);
    assert.equal(view.rows[0].entra, null, 'la apertura no cuenta como entrada');
    assert.equal(view.totalIn, 12);
    assert.equal(view.totalOut, 26);
    assert.equal(view.balance, 36);
    assert.equal(view.consistent, true);
});

test('Kardex: un cambio de stock sin movimiento se marca como hueco', () => {
    const view = buildKardexView([
        row(1, 'APERTURA', 10, 0, 10, { reason: 'Alta de producto' }),
        row(2, 'VENTA', -1, 7, 6), // alguien dejó el stock en 7 sin anotarlo
    ]);
    assert.equal(view.rows[0].label, 'Alta');
    assert.equal(view.consistent, false);
    assert.deepEqual(view.gaps, [{ id: 2, expected: 10, found: 7 }]);
});

test('Kardex: fracciones no producen falsos descuadres', () => {
    const view = buildKardexView([
        row(1, 'APERTURA', 0, 1, 1),
        row(2, 'VENTA', -0.3333, 1, 0.6667),
        row(3, 'VENTA', -0.3333, 0.6667, 0.3334),
    ]);
    assert.equal(view.consistent, true);
    assert.equal(view.balance, 0.3334);
});

test('Kardex: pendientes del dispositivo van aparte y nunca los ya sincronizados', () => {
    const pending = pendingKardexEntries(P, {
        inventoryQueue: [
            { operation_id: 'a', created_at: '2026-10-28T10:02:00Z', sync_status: 'pending', operation: { product_id: P, operation_type: 'AJUSTE_DIRECTO', mode: 'delta', quantity: -2 } },
            { operation_id: 'b', created_at: '2026-10-28T10:03:00Z', sync_status: 'conflicted', operation: { product_id: P, operation_type: 'CONTEO', mode: 'count', quantity: 40 } },
            { operation_id: 'c', created_at: '2026-10-28T10:04:00Z', sync_status: 'synced', operation: { product_id: P, operation_type: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 1 } },
            { operation_id: 'd', created_at: '2026-10-28T10:05:00Z', sync_status: 'pending', operation: { product_id: 'otro', operation_type: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 1 } },
        ],
        salesQueue: [
            { queue_id: 'q1', created_at: '2026-10-28T10:01:00Z', sync_status: 'pending', payload: { cart: [{ id: P, qty: 1, stock_qty: 12 }, { id: 'custom_1', qty: 1 }] } },
            { queue_id: 'q2', created_at: '2026-10-28T10:06:00Z', sync_status: 'failed', payload: { cart: [{ id: P, qty: 3 }] } },
            { queue_id: 'q3', created_at: '2026-10-28T10:07:00Z', sync_status: 'synced', payload: { cart: [{ id: P, qty: 9 }] } },
        ],
    });
    assert.deepEqual(pending.map(p => [p.label, p.status, p.entra, p.sale, p.countTo]), [
        ['Venta', 'pending', null, 12, null],
        ['Ajuste', 'pending', null, 2, null],
        ['Conteo', 'conflicted', null, null, 40],
        ['Venta', 'failed', null, 3, null],
    ]);
});

test('Kardex: la apertura solo envía ids canónicos con su stock', () => {
    assert.deepEqual(buildOpeningPayload([
        { id: P, stock: 59.41666666 },
        { id: 'custom_1', stock: 3 },
        { id: '22222222-2222-4222-8222-222222222222', stock: 'x' },
        null,
    ]), [
        { id: P, stock: 59.4167 },
        { id: '22222222-2222-4222-8222-222222222222', stock: 0 },
    ]);
});

test('Kardex: abrir registra primero el catálogo y luego envía el stock', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ status: 'opened', product_count: 1 }) };
    };
    const pushCatalog = async (products) => { calls.push({ url: 'catalog', count: products.length }); return { status: 'ok' }; };
    const res = await openKardex({ products: [{ id: P, stock: 5, name: 'A' }, { id: 'custom', stock: 1 }], actor: 'Dueño', fetchImpl, authHeaders: {}, pushCatalog });
    assert.equal(calls[0].url, 'catalog');
    assert.equal(calls[1].url, '/api/kardex');
    assert.deepEqual(calls[1].body.products, [{ id: P, stock: 5 }]);
    assert.equal(calls[1].body.actor, 'Dueño');
    assert.equal(res.status, 'opened');
    assert.equal(res.skippedLocal, 1);
});

test('Kardex: si el catálogo falla no se hace la apertura', async () => {
    let posted = false;
    const fetchImpl = async () => { posted = true; return { ok: true, json: async () => ({}) }; };
    const res = await openKardex({ products: [{ id: P, stock: 5 }], fetchImpl, authHeaders: {}, pushCatalog: async () => ({ status: 'error' }) });
    assert.equal(res.status, 'catalog_failed');
    assert.equal(posted, false);
});

test('Kardex: un error HTTP al leer se informa, no se presenta como libreta vacía', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'No autorizado' }) });
    await assert.rejects(fetchProductKardex(P, { fetchImpl, authHeaders: {} }), /No autorizado/);
});

// ── Pantalla Movimientos ──
import {
    dateRangeFor, buildSaleNumberIndex, describeMovement, formatUnits, groupByDay, movementsToCsv,
} from '../src/utils/kardexLedger.js';
import { fetchMovements } from '../src/services/kardexService.js';

test('Movimientos: rangos de fecha en hora local [desde, hasta)', () => {
    const now = new Date(2026, 9, 28, 15, 30); // 28-oct-2026 15:30 local
    const iso = (y, m, d) => new Date(y, m, d).toISOString();
    assert.deepEqual(dateRangeFor('hoy', now), { from: iso(2026, 9, 28), to: iso(2026, 9, 29) });
    assert.deepEqual(dateRangeFor('ayer', now), { from: iso(2026, 9, 27), to: iso(2026, 9, 28) });
    assert.deepEqual(dateRangeFor('7dias', now), { from: iso(2026, 9, 22), to: iso(2026, 9, 29) });
    assert.deepEqual(dateRangeFor('mes', now), { from: iso(2026, 9, 1), to: iso(2026, 9, 29) });
    assert.deepEqual(dateRangeFor('custom', now, { from: '2026-10-01', to: '2026-10-03' }), { from: iso(2026, 9, 1), to: iso(2026, 9, 4) });
    assert.deepEqual(dateRangeFor('todo', now), { from: null, to: null });
});

test('Movimientos: número de venta local por id del servidor o id de operación', () => {
    const idx = buildSaleNumberIndex([{ id: 'srv-1', syncQueueId: 'q-1', saleNumber: 1023 }, { id: 'q-2', syncQueueId: 'q-2', saleNumber: 1024 }, { id: 'x' }]);
    assert.equal(describeMovement({ operation_type: 'VENTA', origin_ref: 'q-1' }, { saleNumbers: idx }), 'Venta #0001023');
    assert.equal(describeMovement({ operation_type: 'ANULACION', origin_ref: 'srv-1' }, { saleNumbers: idx }), 'Anulación de venta #0001023');
    assert.equal(describeMovement({ operation_type: 'VENTA', origin_ref: 'otra' }, { saleNumbers: idx }), 'Venta');
    assert.equal(describeMovement({ operation_type: 'CONTEO', reason: 'CONTEO' }), 'Conteo');
    assert.equal(describeMovement({ operation_type: 'CONTEO', reason: 'Conteo físico' }), 'Conteo · Conteo físico');
    assert.equal(describeMovement({ operation_type: 'APERTURA', reason: 'Alta de producto' }), 'Saldo inicial (producto nuevo)');
    assert.equal(describeMovement({ operation_type: 'APERTURA', reason: 'Corte de apertura' }), 'Saldo inicial (inicio del Kardex)');
});

test('Movimientos: cajas y kilos legibles', () => {
    assert.equal(formatUnits(36, { packagingType: 'lote', unitsPerPackage: 12 }), '36 uds (3 cajas)');
    assert.equal(formatUnits(12, { unit: 'paquete', unitsPerPackage: 12 }), '12 uds (1 caja)');
    assert.equal(formatUnits(37.25, { unit: 'kg' }), '37,25 kg');
    assert.equal(formatUnits(5, { unit: 'unidad' }), '5');
});

test('Movimientos: agrupa por día local conservando el orden', () => {
    const d = (day, h) => new Date(2026, 9, day, h).toISOString();
    const groups = groupByDay([{ id: 3, created_at: d(28, 10) }, { id: 2, created_at: d(28, 9) }, { id: 1, created_at: d(27, 18) }]);
    assert.deepEqual(groups.map(g => [g.day, g.rows.map(r => r.id)]), [['2026-10-28', [3, 2]], ['2026-10-27', [1]]]);
});

test('Movimientos: CSV para Excel con BOM, ; y comas decimales', () => {
    const csv = movementsToCsv([
        { product_id: P, operation_type: 'VENTA', delta: -1.5, stock_after: 10.25, origin_ref: 'q', actor: 'Ana; caja 1', created_at: new Date(2026, 9, 28, 9, 5).toISOString() },
        { product_id: 'x', operation_type: 'APERTURA', delta: 4, stock_after: 4, created_at: new Date(2026, 9, 28, 8, 0).toISOString() },
    ], { productsById: new Map([[P, { name: 'Queso "llanero"' }]]), saleNumbers: new Map([['q', '0000007']]) });
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'Fecha;Hora;Producto;Movimiento;Entra;Sale;Saldo;Usuario');
    assert.ok(lines[1].endsWith(';"Queso ""llanero""";Venta #0000007;;1,5;10,25;"Ana; caja 1"'), lines[1]);
    assert.ok(lines[2].includes(';Producto eliminado;Saldo inicial (inicio del Kardex);;;4;'), lines[2]);
});

test('Movimientos: la consulta envía solo filtros válidos', async () => {
    let url = null;
    const fetchImpl = async u => { url = u; return { ok: true, status: 200, json: async () => ({ movements: [], summary: null, hasMore: false }) }; };
    await fetchMovements({ from: '2026-10-28T04:00:00.000Z', types: ['VENTA', 'ANULACION'], productIds: [P], beforeId: 99, limit: 50 }, { fetchImpl, authHeaders: {} });
    const q = new URL(url, 'http://x').searchParams;
    assert.equal(q.get('list'), '1');
    assert.equal(q.get('from'), '2026-10-28T04:00:00.000Z');
    assert.equal(q.get('to'), null);
    assert.equal(q.get('types'), 'VENTA,ANULACION');
    assert.equal(q.get('product_ids'), P);
    assert.equal(q.get('before_id'), '99');
});

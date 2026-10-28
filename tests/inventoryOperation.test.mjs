import test from 'node:test';
import assert from 'node:assert/strict';

import {
    checkNegativePolicy,
    normalizeStockQuantity,
    resolveDelta,
    toInventoryQuantity,
} from '../src/utils/quantityRules.js';
import {
    applyInventoryOperation,
    buildInventoryOperation,
    classifyInventoryResult,
    previewOperationDelta,
    saleLineToInventoryQuantity,
} from '../src/services/inventoryOperationService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('normalización única: kg/litro con 3 decimales, unidad/paquete enteros', () => {
    assert.equal(normalizeStockQuantity(2.3456, 'kg'), 2.346);
    assert.equal(normalizeStockQuantity(2.3456, 'litro'), 2.346);
    assert.equal(normalizeStockQuantity(2.6, 'unidad'), 3);
    assert.equal(normalizeStockQuantity(2.4, 'paquete'), 2);
    assert.equal(normalizeStockQuantity('no-numérico', 'unidad'), 0);
});

test('conversión de unidad de venta a unidad de inventario', () => {
    assert.equal(toInventoryQuantity(3, { mode: 'unit', unitsPerPackage: 6 }), 0.5);
    assert.equal(toInventoryQuantity(1.25, { isWeight: true }), 1.25);
    assert.equal(toInventoryQuantity(4, {}), 4);
    assert.equal(saleLineToInventoryQuantity(3, { _mode: 'unit', unitsPerPackage: 6 }), 0.5);
    assert.equal(saleLineToInventoryQuantity(1.25, { isWeight: true }), 1.25);
});

test('delta vs conteo: la misma regla produce el mismo resultado', () => {
    assert.deepEqual(resolveDelta({ mode: 'delta', quantity: 5, currentStock: 10, unit: 'unidad' }), { delta: 5, targetStock: 15 });
    assert.deepEqual(resolveDelta({ mode: 'count', quantity: 7, currentStock: 10, unit: 'unidad' }), { delta: -3, targetStock: 7 });
    assert.deepEqual(resolveDelta({ mode: 'count', quantity: 1.2345, currentStock: 1, unit: 'kg' }), { delta: 0.235, targetStock: 1.235 });
});

test('política de negativos: conflicto explícito, jamás clamp silencioso', () => {
    assert.deepEqual(checkNegativePolicy(-2, false), { ok: false, conflict: 'stock_conflict', targetStock: -2 });
    assert.deepEqual(checkNegativePolicy(-2, true), { ok: true, conflict: null, targetStock: -2 });
    assert.equal(checkNegativePolicy(0, false).ok, true);
});

test('el operation_id se asigna antes del primer intento y sobrevive al reintento', () => {
    const op = buildInventoryOperation({ productId: '00000000-0000-4000-8000-000000000001', quantity: -2, reason: 'prueba' });
    assert.match(op.operation_id, UUID_RE);
    assert.equal(op.operation_type, 'AJUSTE_DIRECTO');
    assert.equal(op.quantity, -2);
    // Reintento = payload idéntico; resolveOperationId nunca lo reemplaza.
    const retryPayload = { ...op, sync_origin: 'offline_sync' };
    assert.equal(retryPayload.operation_id, op.operation_id);
});

test('buildInventoryOperation rechaza payloads inválidos igual que el servidor', () => {
    assert.throws(() => buildInventoryOperation({ productId: null, quantity: 1 }), /productId/);
    assert.throws(() => buildInventoryOperation({ productId: 'p', quantity: 0 }), /quantity/);
    assert.throws(() => buildInventoryOperation({ productId: 'p', quantity: 'x' }), /quantity/);
    assert.throws(
        () => buildInventoryOperation({ productId: 'p', quantity: 1, operationType: 'INEXISTENTE' }),
        /operation_type/
    );
});

test('applyInventoryOperation reenvía el MISMO operation_id y clasifica la respuesta', async () => {
    const op = buildInventoryOperation({ productId: '00000000-0000-4000-8000-000000000001', quantity: 5 });
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ status: 'already_processed', operation_id: op.operation_id, stock_after: 12 }), { status: 200 });
    };
    const result = await applyInventoryOperation(op, { fetchImpl });
    assert.equal(classifyInventoryResult(result), 'already_processed');
    await applyInventoryOperation(op, { fetchImpl });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].operation_id, op.operation_id);
    assert.equal(seen[1].operation_id, op.operation_id);
});

test('classifyInventoryResult cubre los estados del contrato y errores HTTP', () => {
    assert.equal(classifyInventoryResult({ status: 'applied' }), 'applied');
    assert.equal(classifyInventoryResult({ status: 'stock_conflict' }), 'stock_conflict');
    assert.equal(classifyInventoryResult({ status: 'invalid' }), 'invalid');
    assert.equal(classifyInventoryResult({}), 'error');
    assert.equal(classifyInventoryResult(null), 'error');
});

test('previewOperationDelta expone delta y objetivo con la regla compartida', () => {
    const preview = previewOperationDelta({ mode: 'count', quantity: 4, currentStock: 10 });
    assert.equal(preview.delta, -6);
    assert.equal(preview.targetStock, 4);
});

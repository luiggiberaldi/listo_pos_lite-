import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyStockOperation,
    buildBulkZeroOperations,
    runStockOperation,
} from '../src/services/inventoryOperationService.js';

const stubFetch = (payload) => async () => ({ ok: true, json: async () => payload });

test('applyStockOperation: applied → confirmed con el stock_after del servidor', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch({ status: 'applied', delta: 2.5, stock_after: 12.5 });
    try {
        const outcome = await applyStockOperation({
            operation_type: 'AJUSTE_DIRECTO',
            product_id: 'p1',
            quantity: 2.5,
            mode: 'delta',
            unit_mode: 'kg',
            reason: 'AJUSTE_DIRECTO',
            operation_id: 'op-test-1',
        });
        assert.equal(outcome.outcome, 'confirmed');
        assert.equal(outcome.stockAfter, 12.5);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('applyStockOperation: stock_conflict → outcome conflict, nada aplicado', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch({
        status: 'stock_conflict',
        requires_resolution: true,
        conflicts: [{ product_id: 'p1', requested_qty: -5, available_stock: 2 }],
    });
    try {
        const outcome = await applyStockOperation({
            operation_type: 'VACIADO',
            product_id: 'p1',
            quantity: -5,
            mode: 'delta',
            unit_mode: 'unidad',
            operation_id: 'op-test-2',
        });
        assert.equal(outcome.outcome, 'conflict');
        assert.equal(outcome.result.requires_resolution, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('applyStockOperation: fallo de red → pending y el operation_id se conserva tal cual', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
        const outcome = await applyStockOperation({
            operation_type: 'CONTEO',
            product_id: 'p1',
            quantity: 10,
            mode: 'count',
            unit_mode: 'unidad',
            operation_id: 'op-test-3',
        });
        assert.equal(outcome.outcome, 'pending');
        assert.equal(outcome.operation.operation_id, 'op-test-3');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('buildBulkZeroOperations: delta real por producto y los ya en 0 no se tocan', () => {
    const targets = [
        { id: 'a', stock: 5, unit: 'unidad' },
        { id: 'b', stock: 0, unit: 'unidad' },
        { id: 'c', stock: 1.2345, unit: 'kg' },
    ];
    const ops = buildBulkZeroOperations(targets);
    assert.equal(ops.length, 2, 'solo productos con stock distinto de cero');
    const byId = new Map(ops.map(o => [o.product_id, o]));
    assert.equal(byId.get('a').quantity, -5);
    assert.equal(byId.get('a').operation_type, 'VACIADO');
    assert.equal(byId.get('c').quantity, -1.235, 'kg con 3 decimales');
    assert.equal(byId.get('c').unit_mode, 'kg');
    assert.notEqual(ops[0].operation_id, ops[1].operation_id, 'operation_id único por operación');
    for (const op of ops) assert.ok(op.operation_id, 'toda operación nace con su operation_id');
});

test('runStockOperation: cantidad cero → invalid sin llamar al contrato', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
        const outcome = await runStockOperation({ productId: 'p1', quantity: 0, mode: 'delta' });
        assert.equal(outcome.outcome, 'invalid');
        assert.equal(called, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

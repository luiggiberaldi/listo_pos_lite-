import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isConflictItem,
    isQueueItemDue,
    pruneSyncedItems,
    resolveConflictForRetry,
    toConflictedState,
} from '../src/services/offlineQueuePolicy.js';

const CONFLICT = {
    success: false,
    status: 'stock_conflict',
    requires_resolution: true,
    message: 'La política de stock negativo prohíbe este checkout',
    conflicts: [{ product_id: 'prod-1', requested_qty: 5, available_stock: 2 }],
};

function makeItem(overrides = {}) {
    return {
        id: 'op-1',
        queue_id: 'op-1',
        operation_id: 'op-1',
        account_id: 'acc-1',
        payload: { queue_id: 'op-1', total: 5 },
        created_at: '2026-10-26T12:00:00.000Z',
        sync_status: 'pending',
        attempts: 2,
        next_attempt_at: '2026-10-26T12:05:00.000Z',
        last_error: null,
        ...overrides,
    };
}

test('el conflicto conserva la venta: mismo payload, mismo operation_id', () => {
    const conflicted = toConflictedState(makeItem(), CONFLICT);
    assert.equal(conflicted.sync_status, 'conflicted');
    assert.deepEqual(conflicted.payload, { queue_id: 'op-1', total: 5 });
    assert.equal(conflicted.operation_id, 'op-1');
    assert.equal(conflicted.conflict, CONFLICT);
    assert.match(conflicted.last_error, /política de stock negativo/);
});

test('una venta en conflicto NUNCA se reintenta sola ni se descarta', () => {
    const conflicted = toConflictedState(makeItem(), CONFLICT);
    const now = Date.parse('2026-10-26T13:00:00.000Z');
    // No es reintenable automáticamente (solo 'pending' lo es).
    assert.equal(isQueueItemDue(conflicted, now), false);
    // La poda de sincronizadas la retiene: jamás se descarta en silencio.
    const pruned = pruneSyncedItems([conflicted, makeItem({ id: 'op-2', sync_status: 'synced', synced_at: '2026-10-26T12:59:00.000Z' })], now);
    assert.ok(pruned.some(item => item.id === 'op-1'));
});

test('la recuperación es explícita: conflicto → pending conservando el ID', () => {
    const conflicted = toConflictedState(makeItem(), CONFLICT);
    const retriable = resolveConflictForRetry(conflicted);
    assert.equal(retriable.sync_status, 'pending');
    assert.equal(retriable.attempts, 0);
    assert.equal(retriable.operation_id, 'op-1');
    assert.equal(retriable.conflict, CONFLICT, 'el detalle del conflicto queda visible tras reactivar');
    assert.equal(isQueueItemDue(retriable, Date.parse('2026-10-26T13:00:00.000Z')), true);
});

test('resolveConflictForRetry no toca ítems que no están en conflicto', () => {
    const pending = makeItem();
    assert.equal(resolveConflictForRetry(pending), pending);
    assert.equal(isConflictItem(pending), false);
    assert.equal(isConflictItem(toConflictedState(makeItem(), CONFLICT)), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newOperationId,
  resolveOperationId,
  MAX_QUEUE_ATTEMPTS,
  retryDelayMs,
} from '../src/services/offlineQueuePolicy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('newOperationId genera IDs con forma de UUID y no se repite', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newOperationId();
    assert.match(id, UUID_RE);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('el operation_id del payload se conserva en el reintento (misma operación)', () => {
  // Simula el ciclo: primer intento online → fallback offline → reintento de la
  // cola. Todos los caminos deben ver EXACTAMENTE el mismo operation_id.
  const operationId = newOperationId();
  const payload = { total: 10, cart: [], payments: [], fiadoUsd: 0, queue_id: operationId };

  assert.equal(resolveOperationId(payload), operationId);
  // El reintento reenvía el mismo payload tal cual.
  const retryPayload = { ...payload, sync_origin: 'offline_sync' };
  assert.equal(resolveOperationId(retryPayload), operationId);
  // operation_id (alias) también se respeta.
  assert.equal(resolveOperationId({ operation_id: operationId }), operationId);
});

test('solo un payload sin identificador recibe un operation_id nuevo', () => {
  const generated = resolveOperationId({ total: 5 });
  assert.match(generated, UUID_RE);

  // Un generador inyectado permite probar sin depender de crypto.
  let calls = 0;
  const generated2 = resolveOperationId({}, () => `fixed-${++calls}`);
  assert.equal(generated2, 'fixed-1');
});

test('la política de reintentos sigue acotada (backoff con tope)', () => {
  assert.equal(retryDelayMs(0), 2000);
  assert.equal(retryDelayMs(10), 300000);
  assert.equal(MAX_QUEUE_ATTEMPTS, 10);
});

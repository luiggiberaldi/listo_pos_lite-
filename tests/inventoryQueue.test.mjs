import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInventoryQueueEntry,
  applyInventoryResultToEntry,
  reconcileStockAfter,
} from '../src/services/inventoryQueuePolicy.js';
import { buildInventoryOperation } from '../src/services/inventoryOperationService.js';
import { createInventoryQueueService } from '../src/services/inventoryQueueService.js';

const NOW = '2026-10-27T12:00:00.000Z';

function createMemoryStorage({ queue = [], products = [] } = {}) {
  const state = { queue: [...queue], products: [...products] };
  return {
    state,
    async loadQueue() { return state.queue.map(item => ({ ...item })); },
    async saveQueue(next) { state.queue = next.map(item => ({ ...item })); },
    async loadProducts() { return state.products.map(item => ({ ...item })); },
    async saveProducts(next) { state.products = next.map(item => ({ ...item })); },
  };
}

function createService({ storage, sendOperation, accountId = 'account-a', deviceId = 'pda-1' } = {}) {
  return createInventoryQueueService({
    storage: storage || createMemoryStorage(),
    sendOperation: sendOperation || (async () => ({ status: 'applied', delta: 1, stock_after: 1 })),
    getAccountId: () => accountId,
    resolveDeviceId: () => deviceId,
    now: () => NOW,
  });
}

// ---------- construcción del comando encolado ----------

test('buildInventoryQueueEntry exige operation_id y guarda el comando completo', () => {
  assert.throws(
    () => buildInventoryQueueEntry({ product_id: 'p1', mode: 'delta', quantity: 5 }, { accountId: 'a', deviceId: 'd', now: () => NOW }),
    /operation_id/
  );

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 5, reason: 'prueba',
  });
  const entry = buildInventoryQueueEntry(operation, {
    accountId: 'account-a', deviceId: 'pda-1', referenceStock: 12, now: () => NOW,
  });

  assert.equal(entry.operation_id, operation.operation_id);
  assert.deepEqual(entry.operation, operation);          // comando completo, tal cual se reenviará
  assert.equal(entry.reference_stock, 12);               // saldo local de referencia
  assert.equal(entry.origin, 'AJUSTE_DIRECTO');
  assert.equal(entry.sync_status, 'pending');
  assert.equal(entry.account_id, 'account-a');
  assert.equal(entry.device_id, 'pda-1');
  assert.equal(entry.created_at, NOW);
  assert.equal(entry.attempts, 0);
  assert.equal(entry.next_attempt_at, null);
});

test('normaliza la identidad legacy (queue_id / operation_id) sin perderla', () => {
  const fromQueueId = buildInventoryQueueEntry(
    { queue_id: 'legacy-1', product_id: 'p1', operation_type: 'AJUSTE_DIRECTO', mode: 'delta', quantity: -2 },
    { accountId: 'a', deviceId: 'd', referenceStock: 3, now: () => NOW }
  );
  assert.equal(fromQueueId.operation_id, 'legacy-1');
  assert.equal(fromQueueId.operation.operation_id, 'legacy-1', 'el ID se inyecta también al comando');
  assert.equal(fromQueueId.origin, 'AJUSTE_DIRECTO');

  const fromOperationId = buildInventoryQueueEntry(
    { operation_id: 'op-9', product_id: 'p1', operation_type: 'CONTEO', mode: 'count', quantity: 4 },
    { accountId: 'a', deviceId: 'd', now: () => NOW }
  );
  assert.equal(fromOperationId.operation_id, 'op-9');
  assert.equal(fromOperationId.origin, 'CONTEO');
});

// ---------- persistencia con operation_id ----------

test('addOperationToQueue persiste con su operation_id y es idempotente', async () => {
  const storage = createMemoryStorage();
  const service = createService({ storage });

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: -3,
  });
  const first = await service.addOperationToQueue(operation, { referenceStock: 10 });
  const again = await service.addOperationToQueue(operation, { referenceStock: 10 });

  assert.equal(again.id, first.id, 'el mismo operation_id no debe crear otra entrada');
  assert.equal(storage.state.queue.length, 1);
  assert.equal(storage.state.queue[0].operation_id, operation.operation_id);
  assert.deepEqual(storage.state.queue[0].operation, operation);
});

// ---------- reconciliación sin reaplicar ----------

test('sync reenvía el MISMO operation_id y reconcilia el saldo devuelto sin reaplicar', async () => {
  const storage = createMemoryStorage({
    // Producto con el delta +5 ya aplicado localmente en modo optimista (3 → 8).
    products: [{ id: 'p1', name: 'Café', stock: 8, stockSync: 'pending' }],
  });
  const sent = [];
  const service = createService({
    storage,
    sendOperation: async operation => {
      sent.push(operation);
      // El servidor devuelve stock_after = 7. Regla A7 (repo principal): ese
      // saldo NO sustituye al local; se guarda aparte como diagnóstico.
      return { status: 'applied', delta: 5, stock_after: 7 };
    },
  });

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 5,
  });
  await service.addOperationToQueue(operation, { referenceStock: 3 });

  await service.syncPendingOperations();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].operation_id, operation.operation_id, 'el reenvío conserva el operation_id');
  assert.deepEqual(sent[0], operation, 'el comando viaja idéntico al primer intento');

  const [entry] = storage.state.queue;
  assert.equal(entry.sync_status, 'synced');
  assert.equal(entry.remote_status, 'applied');
  assert.equal(entry.remote_delta, 5);
  assert.equal(entry.remote_stock_after, 7);
  assert.equal(entry.synced_at, NOW);

  // Sin reaplicar (ni 8+5) y sin pisar el stock local con el del servidor:
  // queda el optimista (8) marcado como sincronizado; 7 queda como diagnóstico.
  assert.equal(storage.state.products[0].stock, 8);
  assert.equal(storage.state.products[0].stockSync, 'synced');
  assert.equal(storage.state.products[0].stockServer, 7);
});

test('respuesta perdida + reintento: already_processed reconcilia sin doble delta', async () => {
  const storage = createMemoryStorage({
    products: [{ id: 'p1', name: 'Refresco', stock: 9, stockSync: 'pending' }],
  });
  const sent = [];
  let attempts = 0;
  const service = createService({
    storage,
    sendOperation: async operation => {
      sent.push(operation);
      attempts++;
      if (attempts === 1) throw new Error('Failed to fetch'); // respuesta perdida
      return { status: 'already_processed', already_processed: true, delta: 4, stock_after: 9 };
    },
  });

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'CONTEO', mode: 'count', quantity: 9,
  });
  await service.addOperationToQueue(operation, { referenceStock: 5 });

  await service.syncPendingOperations(); // primer intento: transitorio
  assert.equal(storage.state.queue[0].sync_status, 'pending');
  assert.equal(storage.state.queue[0].attempts, 1);
  assert.equal(storage.state.products[0].stock, 9, 'un intento fallido no toca el saldo local');

  // Forzar el vencimiento del backoff para el reintento.
  storage.state.queue[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
  await service.syncPendingOperations();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].operation_id, operation.operation_id, 'el reintento es la MISMA operación');
  assert.equal(storage.state.queue[0].sync_status, 'synced');
  assert.equal(storage.state.queue[0].remote_status, 'already_processed');
  assert.equal(storage.state.products[0].stock, 9, 'ya aplicada: solo se reconcilia el saldo devuelto');
});

test('la reconciliación es idempotente y no pisa el stock local (A7)', async () => {
  const storage = createMemoryStorage({ products: [{ id: 'p1', name: 'Agua', stock: 4, stockSync: 'pending' }] });
  const service = createService({ storage });

  await service.reconcileProduct('p1', 7);
  await service.reconcileProduct('p1', 7);
  assert.equal(storage.state.products[0].stock, 4);
  assert.equal(storage.state.products[0].stockSync, 'synced');
  assert.equal(storage.state.products[0].stockServer, 7);

  // Otro saldo del servidor solo actualiza el diagnóstico.
  await service.reconcileProduct('p1', 5);
  assert.equal(storage.state.products[0].stock, 4);
  assert.equal(storage.state.products[0].stockServer, 5);
});

test('producto desconocido para el servidor: queda solo local, no como conflicto sin salida', async () => {
  const storage = createMemoryStorage({ products: [{ id: 'p1', name: 'Pan', stock: 6, stockSync: 'pending' }] });
  const service = createService({
    storage,
    sendOperation: async () => ({ status: 'invalid', message: 'producto desconocido' }),
  });
  const operation = buildInventoryOperation({ productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 1 });
  await service.addOperationToQueue(operation, { referenceStock: 5 });
  await service.syncPendingOperations();

  assert.equal(storage.state.products[0].stock, 6);
  assert.equal(storage.state.products[0].stockSync, 'local_only');
  // Sincronizada (y podada) en vez de quedar como conflicto permanente.
  assert.ok(storage.state.queue.every(e => e.sync_status !== 'conflicted'));
});

// ---------- conflictos funcionales en la sincronización ----------

test('conflicto funcional en sync: conflicted, sin auto-reintento y conservado', async () => {
  const storage = createMemoryStorage({
    products: [{ id: 'p1', name: 'Galleta', stock: 2, stockSync: 'pending' }],
  });
  const sent = [];
  const service = createService({
    storage,
    sendOperation: async operation => {
      sent.push(operation);
      return { status: 'stock_conflict', stock_after: 0, message: 'Quedaría en negativo' };
    },
  });

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: -5,
  });
  await service.addOperationToQueue(operation, { referenceStock: 2 });

  await service.syncPendingOperations();
  await service.syncPendingOperations(); // no debe reintentarlo por sí solo

  assert.equal(sent.length, 1, 'un conflicto funcional no se auto-reintenta');
  const [entry] = storage.state.queue;
  assert.equal(entry.sync_status, 'conflicted');
  assert.equal(entry.conflict.status, 'stock_conflict');
  assert.equal(entry.next_attempt_at, null);
  // El saldo local NO se toca en conflicto: queda al criterio de la resolución.
  assert.equal(storage.state.products[0].stock, 2);

  // Recuperación explícita: reenvía el MISMO operation_id.
  await service.retryConflicted();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].operation_id, operation.operation_id);
});

test('los conflictos no se descartan con dismissFailed', async () => {
  const storage = createMemoryStorage({
    queue: [
      { id: 'e1', operation_id: 'op-1', sync_status: 'conflicted', operation: { product_id: 'p1' } },
      { id: 'e2', operation_id: 'op-2', sync_status: 'failed', attempts: 10, operation: { product_id: 'p2' } },
    ],
    products: [{ id: 'p1', name: 'X', stock: 1 }],
  });
  const service = createService({ storage, sendOperation: async () => ({ status: 'applied', stock_after: 1 }) });

  await service.dismissFailed();
  assert.deepEqual(storage.state.queue.map(i => i.id), ['e1'], 'solo se descartan los failed');
});

// ---------- backoff acotado y failed ----------

test('transitorios agotados terminan en failed; retryFailed reenvía el mismo ID', async () => {
  const storage = createMemoryStorage();
  const sent = [];
  const service = createService({
    storage,
    sendOperation: async operation => {
      sent.push(operation);
      return { status: 'error', message: 'timeout' };
    },
  });

  const operation = buildInventoryOperation({
    productId: 'p1', operationType: 'AJUSTE_DIRECTO', mode: 'delta', quantity: 1,
  });
  await service.addOperationToQueue(operation, { referenceStock: 0 });

  // Simula los 10 intentos fallidos con backoff ya vencido cada vez.
  for (let i = 0; i < 10; i++) {
    storage.state.queue[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await service.syncPendingOperations();
  }

  const entry = storage.state.queue[0];
  assert.equal(entry.sync_status, 'failed');
  assert.equal(entry.attempts, 10);
  assert.ok(entry.last_error.includes('timeout'));
  assert.equal(sent.length, 10);

  await service.retryFailed();
  assert.equal(sent.length, 11);
  assert.equal(sent[10].operation_id, operation.operation_id, 'retryFailed reenvía la misma operación');
});

// ---------- aislamiento por cuenta ----------

test('las operaciones de otra cuenta jamás se sincronizan ni se cruzan', async () => {
  const storage = createMemoryStorage({
    queue: [
      { id: 'mine', operation_id: 'op-mine', account_id: 'account-a', sync_status: 'pending', operation: { product_id: 'p1' } },
      { id: 'theirs', operation_id: 'op-theirs', account_id: 'account-b', sync_status: 'pending', operation: { product_id: 'p2' } },
    ],
  });
  const sent = [];
  const service = createService({
    storage,
    accountId: 'account-a',
    sendOperation: async operation => {
      sent.push(operation);
      return { status: 'applied', delta: 1, stock_after: 1 };
    },
  });

  await service.syncPendingOperations();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].operation_id, 'op-mine');
  assert.equal(storage.state.queue.find(i => i.id === 'theirs').sync_status, 'pending', 'la otra cuenta queda intacta');
});

test('sin cuenta activa no se encola ni se sincroniza nada', async () => {
  const storage = createMemoryStorage();
  const service = createService({ storage, accountId: '' });

  await assert.rejects(
    () => service.addOperationToQueue(buildInventoryOperation({ productId: 'p1', mode: 'delta', quantity: 1 })),
    /cuenta activa/
  );
  await service.syncPendingOperations();
  assert.equal(storage.state.queue.length, 0);
});

// ---------- máquina de estados de la entrada ----------

test('applyInventoryResultToEntry: applied → synced reconciliado, error → backoff, conflicto → conflicted', () => {
  const base = buildInventoryQueueEntry(
    { operation_id: 'op-x', product_id: 'p1', mode: 'delta', quantity: -5, origin_ref: 'set_stock' },
    { accountId: 'a', deviceId: 'd', referenceStock: 3, now: () => NOW }
  );

  const synced = applyInventoryResultToEntry(base, { status: 'applied', delta: -5, stock_after: 0 }, NOW);
  assert.equal(synced.sync_status, 'synced');
  assert.equal(synced.remote_stock_after, 0);
  assert.equal(synced.synced_at, NOW);

  const transient = applyInventoryResultToEntry(base, { status: 'error', message: 'red caída' }, NOW);
  assert.equal(transient.sync_status, 'pending');
  assert.equal(transient.attempts, 1);
  assert.ok(transient.next_attempt_at, 'transitorio programa reintento');
  assert.ok(transient.last_error.includes('red caída'));

  const conflicted = applyInventoryResultToEntry(base, { status: 'stock_conflict', stock_after: 1 }, NOW);
  assert.equal(conflicted.sync_status, 'conflicted');
  assert.equal(conflicted.conflict.status, 'stock_conflict');
  assert.equal(conflicted.next_attempt_at, null);

  const rejected = applyInventoryResultToEntry(base, { status: 'invalid', message: 'delta cero' }, NOW);
  assert.equal(rejected.sync_status, 'conflicted', 'rechazo funcional requiere resolución, no reintento');
});

test('reconcileStockAfter marca sincronizado y guarda el saldo del servidor aparte (A7)', () => {
  const products = [
    { id: 'p1', name: 'A', stock: 1, stockSync: 'pending', other: 'keep' },
    { id: 'p2', name: 'B', stock: 9 },
  ];
  const updated = reconcileStockAfter(products, 'p1', 7);
  assert.equal(updated[0].stock, 1, 'el stock local no se sustituye');
  assert.equal(updated[0].stockServer, 7);
  assert.equal(updated[0].stockSync, 'synced');
  assert.equal(updated[0].other, 'keep', 'conserva el resto de los campos');
  assert.deepEqual(updated[1], products[1], 'los demás productos no se tocan');

  const missing = reconcileStockAfter(products, 'nope', 5);
  assert.deepEqual(missing, products, 'producto inexistente: no cambia nada');
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { createInventoryQueueService } from '../src/services/inventoryQueueService.js';
import { applyInventoryOperation, buildInventoryOperation } from '../src/services/inventoryOperationService.js';
import { pushCatalogSync } from '../src/services/catalogSyncService.js';

function memoryStorage() {
  const state = { queue: [], products: [{ id: 'p1', stock: 5, unit: 'unidad' }] };
  return {
    state,
    async loadQueue() { return state.queue.map(i => ({ ...i })); },
    async saveQueue(next) { state.queue = next.map(i => ({ ...i })); },
    async loadProducts() { return state.products.map(i => ({ ...i })); },
    async saveProducts(next) { state.products = next.map(i => ({ ...i })); },
  };
}

test('cola de inventario: una corrida colgada no bloquea la cola para siempre', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T12:00:00Z') });
  try {
    const storage = memoryStorage();
    let calls = 0;
    const service = createInventoryQueueService({
      storage,
      // Primer envío: el servidor nunca responde. Segundo: responde normal.
      sendOperation: () => (++calls === 1
        ? new Promise(() => {})
        : Promise.resolve({ status: 'applied', delta: 1, stock_after: 6 })),
      getAccountId: () => 'acc',
      resolveDeviceId: () => 'dev',
      now: () => new Date(Date.now()).toISOString(),
    });
    await service.addOperationToQueue(buildInventoryOperation({ productId: 'p1', quantity: 1, accountId: 'acc' }));

    service.syncPendingOperations(); // queda colgada
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1);

    await service.syncPendingOperations(); // dentro de los 60 s: respeta el seguro
    assert.equal(calls, 1, 'no se envía dos veces mientras la corrida está en curso');

    mock.timers.tick(61_000);
    await service.syncPendingOperations(); // pasado el minuto: el seguro se libera
    assert.equal(calls, 2);
    assert.equal((await service.getCounts()).pending, 0);
  } finally {
    mock.timers.reset();
  }
});

test('las peticiones de inventario y catálogo llevan tiempo límite', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, signal: init.signal });
    return { ok: true, status: 200, json: async () => ({ status: 'applied' }) };
  };
  await applyInventoryOperation(buildInventoryOperation({ productId: 'p1', quantity: 1 }), { fetchImpl });
  await pushCatalogSync([{ id: '00000000-0000-4000-8000-000000000001', name: 'X', priceUsdt: 1, stock: 1 }], { fetchImpl });
  assert.equal(seen.length, 2);
  for (const { url, signal } of seen) {
    assert.ok(signal instanceof AbortSignal, `${url} debe llevar AbortSignal`);
  }
});

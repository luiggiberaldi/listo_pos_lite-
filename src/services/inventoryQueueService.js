/**
 * Cola offline de operaciones de inventario (Fase 4 pre-Kardex) — servicio.
 *
 * Persiste en IndexedDB el comando completo de inventario (con su
 * operation_id, delta/unidad, saldo local de referencia, origen, estado y
 * fecha), aislado por cuenta como la cola de ventas. El reenvío viaja con el
 * MISMO operation_id: un reintento es la MISMA operación y el servidor
 * responde 'already_processed' con el resultado canónico si ya la aplicó.
 *
 * Tras la respuesta central se RECONCILIA el estado sin volver a aplicar la
 * operación en el cliente (regla A7 del repo principal: el stock local ya
 * tiene el cambio; stock_after solo se guarda como diagnóstico). La
 * reconciliación ocurre ANTES de dar la entrada por sincronizada y se persiste
 * después de cada operación: un apagón a mitad de sincronización no pierde
 * progreso ni duplica nada (el reintento es idempotente).
 *
 * Estados: 'pending' (reintento con backoff acotado), 'synced' (reconciliado),
 * 'conflicted' (conflicto funcional de stock/identidad: requiere resolución
 * explícita, jamás auto-reintento ni descarte silencioso) y 'failed' (transitorios
 * agotados: visibles, descartables solo con acción explícita).
 */

import localforage from 'localforage';
import {
  APP_STORAGE_DB_NAME,
  APP_STORAGE_STORE_NAME,
  getActiveAccountId,
  getScopedStorageKey,
} from '../config/storageScope.js';
import {
  belongsToAccount,
  isQueueItemDue,
  pruneSyncedItems,
  resolveConflictForRetry,
} from './offlineQueuePolicy.js';
import {
  INVENTORY_QUEUE_KEY,
  applyInventoryResultToEntry,
  buildInventoryQueueEntry,
  reconcileStockAfter,
} from './inventoryQueuePolicy.js';
import { applyInventoryOperation } from './inventoryOperationService.js';

const PRODUCTS_KEY = 'bodega_products_v1';
const DEVICE_KEY = 'pda_device_id';

localforage.config({
  name: APP_STORAGE_DB_NAME,
  storeName: APP_STORAGE_STORE_NAME,
});

function getDeviceId() {
  if (typeof localStorage === 'undefined') return 'unknown-device';
  return localStorage.getItem(DEVICE_KEY) || 'unknown-device';
}

function notifyQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('inventory_queue_update'));
  }
}

/** Persistencia por defecto: IndexedDB/localforage, aislada por cuenta. */
const localforageStorage = {
  async loadQueue() {
    const accountId = getActiveAccountId();
    if (!accountId) return [];
    const queue = await localforage.getItem(getScopedStorageKey(INVENTORY_QUEUE_KEY));
    return Array.isArray(queue) ? queue : [];
  },
  async saveQueue(queue) {
    const accountId = getActiveAccountId();
    if (!accountId) {
      throw new Error('No hay una cuenta activa para guardar la cola de inventario.');
    }
    await localforage.setItem(getScopedStorageKey(INVENTORY_QUEUE_KEY), queue);
    notifyQueueChanged();
  },
  async loadProducts() {
    const accountId = getActiveAccountId();
    if (!accountId) return [];
    const products = await localforage.getItem(getScopedStorageKey(PRODUCTS_KEY));
    return Array.isArray(products) ? products : [];
  },
  async saveProducts(products) {
    const accountId = getActiveAccountId();
    if (!accountId) return;
    await localforage.setItem(getScopedStorageKey(PRODUCTS_KEY), products);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('app_storage_update', {
        detail: { key: PRODUCTS_KEY, source: 'inventory_queue' },
      }));
    }
  },
};

/**
 * Fábrica con dependencias inyectables (mismo patrón que `fetchImpl` en
 * inventoryOperationService): las pruebas usan storage/envío en memoria.
 */
export function createInventoryQueueService({
  storage = localforageStorage,
  sendOperation = operation => applyInventoryOperation(operation),
  getAccountId = getActiveAccountId,
  resolveDeviceId = getDeviceId,
  now = () => new Date().toISOString(),
} = {}) {
  // Seguro contra corridas simultáneas que se libera solo si una corrida
  // queda colgada más de 60 s (misma regla que la cola de ventas).
  const SYNC_LOCK_MAX_MS = 60000;
  let syncStartedAt = 0;
  let syncRun = 0;

  /**
   * Persiste una operación con su operation_id. Idempotente: reintentar con el
   * mismo ID devuelve la entrada existente, nunca crea una segunda.
   */
  async function addOperationToQueue(operation, { referenceStock = null } = {}) {
    const accountId = getAccountId();
    if (!accountId) {
      throw new Error('No se puede encolar una operación de inventario sin cuenta activa.');
    }
    const entry = buildInventoryQueueEntry(operation, {
      accountId,
      deviceId: resolveDeviceId(),
      referenceStock,
      now,
    });
    const queue = await storage.loadQueue();
    const existing = queue.find(item => item.operation_id === entry.operation_id);
    if (existing) return existing;

    await storage.saveQueue([...queue, entry]);
    return entry;
  }

  /** Marca el producto como sincronizado sin reaplicar el delta (regla A7: el stock local no se sustituye). */
  async function reconcileProduct(productId, stockAfter, options) {
    const products = await storage.loadProducts();
    const updated = reconcileStockAfter(products, productId, stockAfter, options);
    await storage.saveProducts(updated);
    return updated;
  }

  async function syncPendingOperations() {
    if (syncStartedAt && Date.now() - syncStartedAt < SYNC_LOCK_MAX_MS) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const accountId = getAccountId();
    if (!accountId) return;

    syncStartedAt = Date.now();
    const run = ++syncRun;
    try {
      let queue = pruneSyncedItems(await storage.loadQueue());
      const nowMs = Date.now();
      const due = queue.filter(
        item => belongsToAccount(item, accountId) && isQueueItemDue(item, nowMs)
      );

      for (const item of due) {
        let data;
        try {
          // La identidad de registro viaja siempre: aunque el comando fuera
          // legacy y careciera del campo, el reenvío es la MISMA operación.
          data = await sendOperation({ ...item.operation, operation_id: item.operation_id });
          if (!data || typeof data.status !== 'string') {
            data = { status: 'error', message: data?.message || 'Respuesta sin status del contrato' };
          }
        } catch (err) {
          data = { status: 'error', message: err?.message || String(err) };
        }

        const updated = applyInventoryResultToEntry(item, data, now());
        queue = queue.map(q => (q.id === item.id ? updated : q));

        // Reconciliar ANTES de persistir la entrada como sincronizada: si el
        // proceso muere aquí, la entrada sigue pendiente y el reintento
        // ('already_processed', mismo operation_id) reconcilia de nuevo con el
        // MISMO saldo — idempotente, sin reaplicar la operación.
        if (updated.sync_status === 'synced') {
          await reconcileProduct(item.operation.product_id, updated.remote_stock_after, {
            localOnly: updated.remote_status === 'local_only',
          });
        }

        // Persistir después de cada operación: un apagón no pierde el progreso.
        await storage.saveQueue(queue);
      }

      await storage.saveQueue(pruneSyncedItems(queue));
    } finally {
      if (run === syncRun) syncStartedAt = 0;
    }
  }

  return {
    addOperationToQueue,
    reconcileProduct,
    syncPendingOperations,

    async getQueue() {
      return storage.loadQueue();
    },

    async getCounts() {
      const queue = await storage.loadQueue();
      return {
        pending: queue.filter(item => item.sync_status === 'pending').length,
        failed: queue.filter(item => item.sync_status === 'failed').length,
        synced: queue.filter(item => item.sync_status === 'synced').length,
        conflicted: queue.filter(item => item.sync_status === 'conflicted').length,
      };
    },

    // Recuperación explícita tras resolver la causa (corregir stock/política o
    // vincular el producto): reactiva los conflictos con su MISMO operation_id.
    async retryConflicted() {
      const queue = await storage.loadQueue();
      const reset = queue.map(item =>
        item.sync_status === 'conflicted' ? resolveConflictForRetry(item) : item
      );
      await storage.saveQueue(reset);
      await syncPendingOperations();
    },

    async retryFailed() {
      const queue = await storage.loadQueue();
      const reset = queue.map(item =>
        item.sync_status === 'failed'
          ? { ...item, sync_status: 'pending', attempts: 0, next_attempt_at: null, last_error: null }
          : item
      );
      await storage.saveQueue(reset);
      await syncPendingOperations();
    },

    // Solo descarta 'failed' (transitorios agotados). Los conflictos funcionales
    // se conservan: jamás se borra en silencio una operación que requiere
    // resolución.
    async dismissFailed() {
      const queue = await storage.loadQueue();
      await storage.saveQueue(queue.filter(item => item.sync_status !== 'failed'));
    },
  };
}

export const inventoryQueueService = createInventoryQueueService();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    inventoryQueueService.syncPendingOperations().catch(error => {
      console.warn('[Inventory Sync] Reintento automático falló:', error?.message || error);
    });
  });
}

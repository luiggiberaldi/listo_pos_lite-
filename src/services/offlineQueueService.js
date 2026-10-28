import localforage from 'localforage';
import {
  APP_STORAGE_DB_NAME,
  APP_STORAGE_STORE_NAME,
  getActiveAccountId,
  getScopedStorageKey,
} from '../config/storageScope';
import {
  MAX_QUEUE_ATTEMPTS,
  isQueueItemDue,
  nextRetryAt,
  pruneSyncedItems,
  resolveOperationId,
  resolveConflictForRetry,
  toConflictedState,
  isResolvableConflictStatus,
  conflictSaleStatus,
} from './offlineQueuePolicy';
import { getAuthHeaders } from './authHeaders';
import { resyncLocalCatalog } from './catalogSyncService';

// Carga diferida: storageService arrastra React/Supabase y estos servicios
// también se usan en pruebas de Node con almacenamiento inyectado.
const loadStorageService = async () => (await import('../utils/storageService.js')).storageService;


const QUEUE_KEY = 'offline_sales_queue';
const SALES_KEY = 'bodega_sales_v1';
const DEVICE_KEY = 'pda_device_id';

localforage.config({
  name: APP_STORAGE_DB_NAME,
  storeName: APP_STORAGE_STORE_NAME,
});

// Seguro contra sincronizaciones simultáneas. Si una corrida queda colgada
// (petición sin respuesta), el seguro se libera solo tras SYNC_LOCK_MAX_MS
// para que la cola no quede bloqueada hasta recargar la app.
const SYNC_LOCK_MAX_MS = 60000;
let syncStartedAt = 0;
let syncRun = 0;

function getQueueStorageKey() {
  const accountId = getActiveAccountId();
  return accountId ? getScopedStorageKey(QUEUE_KEY) : null;
}

function getDeviceId() {
  if (typeof localStorage === 'undefined') return 'unknown-device';
  return localStorage.getItem(DEVICE_KEY) || 'unknown-device';
}

async function markLocalSaleConflict(item, conflict) {
  const key = getActiveAccountId() ? getScopedStorageKey(SALES_KEY) : null;
  if (!key) return;

  const sales = await localforage.getItem(key);
  if (!Array.isArray(sales)) return;

  const updated = sales.map(sale => {
    const matches = sale.syncQueueId === item.queue_id || sale.id === item.queue_id;
    if (!matches) return sale;
    return {
      ...sale,
      // Fase 2: venta ya cobrada en conflicto funcional (stock o catálogo).
      // Visible y pendiente de resolución: ni COMPLETADA ni descartada.
      status: conflictSaleStatus(conflict),
      stockConflict: conflict || null,
    };
  });

  if (JSON.stringify(updated) !== JSON.stringify(sales)) {
    // Por la capa de guardado: marca la venta cambiada (Fase B) y la sube a la nube.
    await (await loadStorageService()).setItem(SALES_KEY, updated);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('app_storage_update', {
        detail: { key: SALES_KEY, source: 'offline_queue_conflict' },
      }));
    }
  }
}

function notifyQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('offline_queue_update'));
  }
}

async function readQueue() {
  const key = getQueueStorageKey();
  if (!key) return [];
  const queue = await localforage.getItem(key);
  return Array.isArray(queue) ? queue : [];
}

async function writeQueue(queue) {
  const key = getQueueStorageKey();
  if (!key) throw new Error('No hay una cuenta activa para guardar la cola offline.');
  await localforage.setItem(key, queue);
  notifyQueueChanged();
}

async function markLocalSaleSynced(item, serverData) {
  const key = getActiveAccountId() ? getScopedStorageKey(SALES_KEY) : null;
  if (!key) return;

  const sales = await localforage.getItem(key);
  if (!Array.isArray(sales)) return;

  const updated = sales.map(sale => {
    const matches = sale.syncQueueId === item.queue_id || sale.id === item.queue_id;
    if (!matches) return sale;
    return {
      ...sale,
      status: 'COMPLETADA',
      syncMode: 'online_after_retry',
      // Referencia canónica remota: el servidor devuelve su sale_id también en
      // una respuesta duplicate (operación ya procesada con este mismo ID).
      remoteSaleId: serverData?.sale_id || sale.remoteSaleId || null,
      remoteDuplicate: serverData?.duplicate === true || sale.remoteDuplicate || false,
      syncedAt: new Date().toISOString(),
    };
  });

  if (JSON.stringify(updated) !== JSON.stringify(sales)) {
    // Por la capa de guardado: marca la venta cambiada (Fase B) y la sube a la nube.
    await (await loadStorageService()).setItem(SALES_KEY, updated);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('app_storage_update', {
        detail: { key: SALES_KEY, source: 'offline_queue' },
      }));
    }
  }
}

export const offlineQueueService = {
  async addSaleToQueue(salePayload) {
    const accountId = getActiveAccountId();
    if (!accountId) {
      throw new Error('No se puede encolar una venta sin cuenta activa.');
    }

    const queue = await readQueue();
    // Fase 1: el operation_id llega en el payload (asignado antes del primer
    // intento online). Reintentar encola la MISMA operación, nunca una nueva.
    const operationId = resolveOperationId(salePayload);
    const existing = queue.find(item => item.queue_id === operationId);
    if (existing) return existing;

    const entry = {
      id: operationId,
      queue_id: operationId,
      operation_id: operationId,
      account_id: accountId,
      device_id: getDeviceId(),
      payload: salePayload,
      created_at: new Date().toISOString(),
      sync_status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
    };

    await writeQueue([...queue, entry]);
    return entry;
  },

  async getQueue() {
    return readQueue();
  },

  async getCounts() {
    const queue = await readQueue();
    return {
      pending: queue.filter(item => item.sync_status === 'pending').length,
      failed: queue.filter(item => item.sync_status === 'failed').length,
      synced: queue.filter(item => item.sync_status === 'synced').length,
      conflicted: queue.filter(item => item.sync_status === 'conflicted').length,
    };
  },

  async syncPendingSales() {
    if (syncStartedAt && Date.now() - syncStartedAt < SYNC_LOCK_MAX_MS) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const accountId = getActiveAccountId();
    if (!accountId) return;

    syncStartedAt = Date.now();
    const run = ++syncRun;
    try {
      let queue = pruneSyncedItems(await readQueue());
      const now = Date.now();
      const pending = queue.filter(item => item.account_id === accountId && isQueueItemDue(item, now));

      for (const item of pending) {
        try {
          const payloadWithOrigin = {
            ...item.payload,
            sync_origin: 'offline_sync',
            original_created_at: item.created_at,
            queue_id: item.queue_id,
            account_id: item.account_id,
            device_id: item.device_id,
          };

          // El token se obtiene en CADA reintento (nunca se guarda en la cola):
          // así una venta encolada hace días usa la sesión vigente.
          const postCheckout = async () => {
            const authHeaders = await getAuthHeaders();
            const res = await fetch('/api/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify(payloadWithOrigin),
              signal: AbortSignal.timeout(10000),
            });
            return { res, data: await res.json().catch(() => ({})) };
          };
          let { res, data } = await postCheckout();

          // Producto aún no registrado en el catálogo del servidor: se sube el
          // catálogo local y se reintenta la MISMA operación (mismo queue_id).
          if (data.status === 'unknown_product' && await resyncLocalCatalog()) {
            ({ res, data } = await postCheckout());
          }

          if (res.status === 401) {
            // Sesión vencida o ausente: la venta NO está mal, solo falta iniciar
            // sesión. No consume intentos ni se marca como fallida.
            queue = queue.map(q => q.id === item.id ? {
              ...q,
              next_attempt_at: nextRetryAt(3),
              last_error: 'Sesión expirada: vuelve a iniciar sesión para sincronizar.',
            } : q);
            await writeQueue(queue);
            continue;
          }

          if (isResolvableConflictStatus(data.status)) {
            // Conflicto funcional explícito y recuperable (Fase 2): stock negativo
            // prohibido o producto no vinculado. La venta ya cobrada se conserva
            // como 'conflicted' — ni sincronizada ni descartada. Solo una
            // resolución explícita (retryConflicted) reactiva este operation_id.
            // (En staging faltaba este continue: el conflicto se sobrescribía
            // como 'synced' en las líneas siguientes.)
            queue = queue.map(q => q.id === item.id ? toConflictedState(q, data) : q);
            await markLocalSaleConflict(item, data);
            await writeQueue(queue);
            continue;
          }

          if (!res.ok || data.error || data.code) {
            throw new Error(data.message || data.error || `HTTP ${res.status}`);
          }

          queue = queue.map(q => q.id === item.id ? {
            ...q,
            sync_status: 'synced',
            synced_at: new Date().toISOString(),
            last_error: null,
          } : q);
          await markLocalSaleSynced(item, data);
        } catch (err) {
          const attempts = (item.attempts || 0) + 1;
          queue = queue.map(q => q.id === item.id ? {
            ...q,
            attempts,
            sync_status: attempts >= MAX_QUEUE_ATTEMPTS ? 'failed' : 'pending',
            next_attempt_at: attempts >= MAX_QUEUE_ATTEMPTS ? null : nextRetryAt(attempts),
            last_error: err?.message || 'Error desconocido',
          } : q);
        }

        // Persistir después de cada operación: un apagón no pierde el progreso.
        await writeQueue(queue);
      }

      await writeQueue(pruneSyncedItems(queue));
    } finally {
      if (run === syncRun) syncStartedAt = 0;
    }
  },

  // Marca como conflicto una entrada recién creada cuyo primer intento online
  // ya fue bloqueado por la política de negativos.
  async markQueueConflict(queueId, conflict) {
    const queue = await readQueue();
    const entry = queue.find(item => item.queue_id === queueId);
    if (!entry) return null;
    const updated = queue.map(item => item.queue_id === queueId ? toConflictedState(item, conflict) : item);
    await writeQueue(updated);
    await markLocalSaleConflict(entry, conflict);
    return updated.find(item => item.queue_id === queueId);
  },

  // Recuperación explícita tras resolver la causa (stock corregido o política
  // cambiada): reactiva los conflictos con su MISMO operation_id.
  async retryConflicted() {
    const queue = await readQueue();
    const reset = queue.map(item => item.sync_status === 'conflicted' ? resolveConflictForRetry(item) : item);
    await writeQueue(reset);
    await this.syncPendingSales();
  },

  async retryFailed() {
    const queue = await readQueue();
    const reset = queue.map(item => item.sync_status === 'failed'
      ? { ...item, sync_status: 'pending', attempts: 0, next_attempt_at: null, last_error: null }
      : item);
    await writeQueue(reset);
    await this.syncPendingSales();
  },

  async dismissFailed() {
    const queue = await readQueue();
    await writeQueue(queue.filter(item => item.sync_status !== 'failed'));
  },

  async getFailedCount() {
    const { failed } = await this.getCounts();
    return failed;
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    offlineQueueService.syncPendingSales().catch(error => {
      console.warn('[Offline Sync] Reintento automático falló:', error?.message || error);
    });
  });
}

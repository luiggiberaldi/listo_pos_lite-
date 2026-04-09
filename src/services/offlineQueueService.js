import localforage from 'localforage';

const QUEUE_KEY = 'offline_sales_queue';
const MAX_ATTEMPTS = 10;

export const offlineQueueService = {
  async addSaleToQueue(salePayload) {
    const queue = await localforage.getItem(QUEUE_KEY) || [];
    const newEntry = {
      id: crypto.randomUUID(),
      payload: salePayload,
      created_at: new Date().toISOString(),
      sync_status: 'pending',
      attempts: 0
    };
    await localforage.setItem(QUEUE_KEY, [...queue, newEntry]);
    return newEntry;
  },

  async syncPendingSales() {
    const queue = await localforage.getItem(QUEUE_KEY) || [];
    const pending = queue.filter(q => q.sync_status === 'pending');

    if (pending.length === 0) return;

    let updatedQueue = [...queue];

    for (const item of pending) {
      try {
        const payloadWithOrigin = {
          ...item.payload,
          sync_origin: 'offline_sync',
          original_created_at: item.created_at,
          queue_id: item.id,  // Clave de idempotencia: evita duplicar ventas en reintentos
        };

        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadWithOrigin),
          signal: AbortSignal.timeout(10000),
        });

        const data = await res.json();

        if (!res.ok || data.error || data.code) {
          throw new Error(data.message || data.error || `HTTP ${res.status}`);
        }

        updatedQueue = updatedQueue.map(q => q.id === item.id ? { ...q, sync_status: 'synced', synced_at: new Date().toISOString() } : q);
      } catch (err) {
        console.error('[Offline Sync] Fallo al sincronizar venta offline:', err);
        const newAttempts = (item.attempts || 0) + 1;
        const newStatus = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        updatedQueue = updatedQueue.map(q => q.id === item.id ? { ...q, attempts: newAttempts, sync_status: newStatus, last_error: err?.message || 'Error desconocido' } : q);
      }
    }

    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const remaining = updatedQueue.filter(q => {
      if (q.sync_status === 'pending' || q.sync_status === 'failed') return true;
      if (q.sync_status === 'synced' && q.synced_at) {
        return (now - new Date(q.synced_at).getTime()) < TWENTY_FOUR_HOURS;
      }
      return false;
    });
    await localforage.setItem(QUEUE_KEY, remaining);
  },

  async retryFailed() {
    const queue = await localforage.getItem(QUEUE_KEY) || [];
    const reset = queue.map(q => q.sync_status === 'failed' ? { ...q, sync_status: 'pending', attempts: 0, last_error: null } : q);
    await localforage.setItem(QUEUE_KEY, reset);
    await offlineQueueService.syncPendingSales();
  },

  async dismissFailed() {
    const queue = await localforage.getItem(QUEUE_KEY) || [];
    await localforage.setItem(QUEUE_KEY, queue.filter(q => q.sync_status !== 'failed'));
  },

  async getFailedCount() {
    const queue = await localforage.getItem(QUEUE_KEY) || [];
    return queue.filter(q => q.sync_status === 'failed').length;
  }
};

window.addEventListener('online', () => {
    console.log("[Offline Sync] Internet restaurado. Sincronizando ventas pendientes...");
    offlineQueueService.syncPendingSales();
});

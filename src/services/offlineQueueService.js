import localforage from 'localforage';
import { supabase } from '../core/supabaseClient';

const QUEUE_KEY = 'offline_sales_queue';

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
          original_created_at: item.created_at
        };

        const { data, error } = await supabase.rpc('process_checkout', { payload: payloadWithOrigin });
        
        if (error) throw error;

        updatedQueue = updatedQueue.map(q => q.id === item.id ? { ...q, sync_status: 'synced' } : q);
      } catch (err) {
        console.error('[Offline Sync] Fallo al sincronizar venta offline:', err);
        updatedQueue = updatedQueue.map(q => q.id === item.id ? { ...q, attempts: q.attempts + 1 } : q);
      }
    }
    
    const remainingPending = updatedQueue.filter(q => q.sync_status === 'pending');
    await localforage.setItem(QUEUE_KEY, remainingPending);
  }
};

window.addEventListener('online', () => {
    console.log("[Offline Sync] Internet restaurado. Sincronizando ventas pendientes...");
    offlineQueueService.syncPendingSales();
});

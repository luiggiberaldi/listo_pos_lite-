import React, { useState, useEffect } from 'react';
import { Cloud, CloudOff, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { supabaseCloud as supabase } from '../config/supabaseCloud';
import localforage from 'localforage';

/**
 * SyncStatus — Indicador visual de conectividad Híbrido.
 * Muestra el estado de la conexión y de la cola de transacciones Offline (ACID).
 * - Online (Verde):  Conexión activa a Supabase. Todo opera online.
 * - Syncing (Naranja): Ventas en cola esperando sincronización o en progreso.
 * - Offline (Rojo): Sin internet o Supabase inalcanzable.
 */
export default function SyncStatus() {
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    const [pendingCount, setPendingCount] = useState(0);

    const checkHealth = async () => {
        if (!navigator.onLine) {
            setIsOnline(false);
            return;
        }
        try {
            // Ping rápido con TIMEOUT (5 segundos) para no quedarse pegado si la conexión es intermitente
            const pingPromise = supabase.from('sync_documents').select('doc_id').limit(1);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
            
            const result = await Promise.race([pingPromise, timeoutPromise]);
            
            if (result.error) throw result.error;
            
            setIsOnline(true);
            
            // Auto-trigger sync if we confirm we have real internet
            import('../services/offlineQueueService').then(m => m.offlineQueueService.syncPendingSales());
        } catch (err) {
            setIsOnline(false);
        }
    };

    const checkQueue = async () => {
        try {
            const queue = await localforage.getItem('offline_sales_queue') || [];
            const pending = queue.filter(q => q.sync_status === 'pending');
            setPendingCount(pending.length);
        } catch(err) {
            console.error('[SyncStatus] Error al leer cola', err);
        }
    };

    useEffect(() => {
        let mounted = true;
        const goOnline = () => checkHealth();
        const goOffline = () => { if(mounted) setIsOnline(false); };

        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);
        
        checkHealth();
        checkQueue();

        const healthInterval = setInterval(checkHealth, 900000); // 15 min
        const queueInterval = setInterval(checkQueue, 15000); // 15s refresca UI

        return () => {
            mounted = false;
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
            clearInterval(healthInterval);
            clearInterval(queueInterval);
        };
    }, []);

    let statusType = 'online';
    if (!isOnline) statusType = 'offline';
    else if (pendingCount > 0) statusType = 'syncing';
    
    const handleForceSync = () => {
        checkHealth();
        if (isOnline) {
             import('../services/offlineQueueService').then(m => m.offlineQueueService.syncPendingSales());
        }
    };

    return (
        <button
            onClick={handleForceSync}
            className={`flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold tracking-wider transition-all duration-300 shadow-sm border focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                statusType === 'online'
                    ? 'bg-emerald-50 border-emerald-100 text-emerald-600 focus:ring-emerald-500 hover:bg-emerald-100'
                    : statusType === 'syncing'
                    ? 'bg-amber-50 border-amber-100 text-amber-600 focus:ring-amber-500 hover:bg-amber-100'
                    : 'bg-rose-50 border-rose-100 text-rose-500 animate-pulse focus:ring-rose-500'
            }`}
             title={statusType === 'online' ? 'Conectado - Clic para verificar conexión' : statusType === 'syncing' ? `Sincronizando ${pendingCount} transacciones. Clic para forzar.` : 'Sin conexión a la BD. Clic para reintentar.'}
        >
            {statusType === 'online' && (
                <>
                    <Wifi size={13} strokeWidth={2.5} />
                    <span className="hidden sm:inline">Online</span>
                </>
            )}
            {statusType === 'syncing' && (
                <>
                    <RefreshCw size={13} strokeWidth={2.5} className="animate-spin-slow" />
                    <span className="hidden sm:inline">Sync ({pendingCount})</span>
                    <span className="sm:hidden">{pendingCount}</span>
                </>
            )}
            {statusType === 'offline' && (
                <>
                    <WifiOff size={13} strokeWidth={2.5} />
                    <span>Offline</span>
                </>
            )}
        </button>
    );
}

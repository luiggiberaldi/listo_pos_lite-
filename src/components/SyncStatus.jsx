import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Wifi, WifiOff, RefreshCw, AlertTriangle, X, ChevronRight, Copy, Check, RotateCcw } from 'lucide-react';
import { supabaseCloud as supabase } from '../config/supabaseCloud';
import { offlineQueueService } from '../services/offlineQueueService';
import { inventoryQueueService } from '../services/inventoryQueueService';
import { getSyncDiagnostics } from '../hooks/useCloudSync';

// "hace 40 s" / "hace 3 min" / "hace 2 h" a partir del último pull exitoso.
function formatAgo(iso, now) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return null;
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `hace ${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    return `hace ${Math.round(m / 60)} h`;
}

// Título y sugerencia legibles para una venta o ajuste que requiere atención.
function describeProblem(kind, item) {
    if (kind === 'venta') {
        const total = item.payload?.total;
        const title = `Venta ${total != null ? `$${Number(total).toFixed(2)}` : 'offline'}`;
        if (item.sync_status !== 'conflicted') return { title, hint: null };
        const status = item.conflict?.status;
        return {
            title,
            hint: status === 'unknown_product'
                ? 'Un producto no está registrado en el servidor. Revisa el producto y pulsa Reintentar.'
                : 'El servidor no permitió dejar el stock en negativo. Corrige el stock (conteo) y pulsa Reintentar.',
        };
    }
    const op = item.operation || {};
    const qty = Number(op.quantity);
    const title = `Ajuste de inventario${Number.isFinite(qty) ? ` (${qty > 0 ? '+' : ''}${qty})` : ''}`;
    return {
        title,
        hint: item.sync_status === 'conflicted'
            ? 'El servidor bloqueó este ajuste. Corrige el stock y pulsa Reintentar.'
            : null,
    };
}

export default function SyncStatus() {
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    const [pendingCount, setPendingCount] = useState(0);
    const [failedCount, setFailedCount] = useState(0);
    const [showFailedBanner, setShowFailedBanner] = useState(false);
    const [showErrorModal, setShowErrorModal] = useState(false);
    const [failedItems, setFailedItems] = useState([]);
    const [copied, setCopied] = useState(false);
    // A8: último sync de documentos (cursor A2) y cambios locales sin confirmar (A4)
    const [syncDiag, setSyncDiag] = useState(() => ({ ...getSyncDiagnostics(), now: Date.now() }));

    // Devuelve si hay conexión. Con triggerSync, además dispara las dos colas
    // (ventas e inventario) sin esperarlas.
    const checkHealth = async (triggerSync = true) => {
        if (!navigator.onLine) {
            setIsOnline(false);
            return false;
        }
        try {
            const pingPromise = supabase.from('sync_documents').select('doc_id').limit(1);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
            const result = await Promise.race([pingPromise, timeoutPromise]);
            if (result.error) throw result.error;
            setIsOnline(true);
            if (triggerSync) {
                offlineQueueService.syncPendingSales().catch(() => {});
                inventoryQueueService.syncPendingOperations().catch(() => {});
            }
            return true;
        } catch (err) {
            setIsOnline(false);
            return false;
        }
    };

    // Lee las dos colas: pendientes (se reintentan solas) y problemas que
    // requieren atención — ventas o ajustes 'failed' (reintentos agotados) y
    // 'conflicted' (el servidor los bloqueó: stock, producto no vinculado).
    const checkQueue = async () => {
        try {
            const [salesQueue, invQueue] = await Promise.all([
                offlineQueueService.getQueue(),
                inventoryQueueService.getQueue(),
            ]);
            const salesPending = salesQueue.filter(q => q.sync_status === 'pending');
            const invPending = invQueue.filter(q => q.sync_status === 'pending');
            const problems = [
                ...salesQueue.filter(q => q.sync_status === 'conflicted' || q.sync_status === 'failed')
                    .map(item => ({ kind: 'venta', item })),
                ...invQueue.filter(q => q.sync_status === 'conflicted' || q.sync_status === 'failed')
                    .map(item => ({ kind: 'inventario', item })),
            ];
            setPendingCount(salesPending.length + invPending.length);
            setFailedCount(problems.length);
            setFailedItems(problems);
            if (problems.length > 0) setShowFailedBanner(true);

            // Reintento automático: si el navegador tiene red pero el servidor
            // estuvo caído, nadie dispara un evento 'online'. Cada cola respeta
            // su propio backoff, así que llamar seguido no satura el servidor.
            if (navigator.onLine && (salesPending.length > 0 || invPending.length > 0)) {
                offlineQueueService.syncPendingSales().catch(() => {});
                inventoryQueueService.syncPendingOperations().catch(() => {});
            }
        } catch(err) {
            console.error('[SyncStatus] Error al leer cola', err);
        }
    };

    const [isRetrying, setIsRetrying] = useState(false);
    const [isForcing, setIsForcing] = useState(false);

    // Solo descarta lo 'failed'. Los conflictos ('conflicted') son ventas ya
    // cobradas o ajustes que el servidor bloqueó: nunca se borran en silencio.
    const handleDismissFailed = async (e) => {
        e.stopPropagation();
        await offlineQueueService.dismissFailed();
        await inventoryQueueService.dismissFailed();
        await checkQueue();
        setShowErrorModal(false);
    };

    // Reintenta fallidos y conflictos de las dos colas con su MISMO
    // operation_id (el servidor no duplica nada). En orden, para que cada
    // reintento no choque con el seguro de la corrida anterior.
    const handleRetryFailed = async (e) => {
        e.stopPropagation();
        setIsRetrying(true);
        try {
            await offlineQueueService.retryFailed();
            await offlineQueueService.retryConflicted();
            await inventoryQueueService.retryFailed();
            await inventoryQueueService.retryConflicted();
            await checkQueue();
            setShowErrorModal(false);
        } finally {
            setIsRetrying(false);
        }
    };

    const handleCopyLogs = () => {
        const text = failedItems.map(({ kind, item }, i) => {
            const d = new Date(item.created_at);
            return [
                `--- ${describeProblem(kind, item).title} (${i + 1}) ---`,
                `Estado: ${item.sync_status === 'conflicted' ? 'Conflicto' : 'Fallida'}`,
                `Fecha: ${d.toLocaleString('es-VE')}`,
                `Intentos: ${item.attempts || 0}`,
                `Detalle: ${item.last_error || 'Error desconocido'}`,
            ].join('\n');
        }).join('\n\n');
        const doCopy = () => {
            if (navigator.clipboard?.writeText) {
                return navigator.clipboard.writeText(text);
            }
            // Fallback para contextos sin Clipboard API (iframes, HTTP, etc.)
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return Promise.resolve();
        };
        doCopy().then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
            setCopied(false);
        });
    };

    useEffect(() => {
        let mounted = true;
        const goOnline = () => checkHealth();
        const goOffline = () => { if(mounted) setIsOnline(false); };

        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);

        checkHealth();
        checkQueue();

        const queueInterval = setInterval(checkQueue, 15000);
        const diagInterval = setInterval(() => {
            if (mounted) setSyncDiag({ ...getSyncDiagnostics(), now: Date.now() });
        }, 5000);

        return () => {
            mounted = false;
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
            clearInterval(queueInterval);
            clearInterval(diagInterval);
        };
    }, []);

    // Revisión de salud: cada 15 min si hay conexión, cada 30 s si se marcó
    // "Offline". Antes un solo ping lento (pestaña oculta, red lenta) dejaba
    // "Offline" 15 minutos aunque la sincronización siguiera funcionando.
    useEffect(() => {
        const healthInterval = setInterval(checkHealth, isOnline ? 900000 : 30000);
        return () => clearInterval(healthInterval);
    }, [isOnline]);

    let statusType = 'online';
    if (!isOnline) statusType = 'offline';
    else if (pendingCount > 0) statusType = 'syncing';

    // El botón espera a que las dos colas terminen y refresca el contador,
    // en vez de dispararlas y olvidarlas.
    const handleForceSync = async () => {
        if (isForcing) return;
        setIsForcing(true);
        try {
            const online = await checkHealth(false);
            if (online) {
                await Promise.allSettled([
                    offlineQueueService.syncPendingSales(),
                    inventoryQueueService.syncPendingOperations(),
                ]);
            }
            await checkQueue();
        } finally {
            setIsForcing(false);
        }
    };

    const lastSyncLabel = formatAgo(syncDiag.lastSyncTime, syncDiag.now);

    return (
        <div className="flex flex-col items-start gap-1">
            <button
                onClick={handleForceSync}
                className={`flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold tracking-wider transition-all duration-300 shadow-sm border focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                    statusType === 'online'
                        ? 'bg-emerald-50 border-emerald-100 text-emerald-600 focus:ring-emerald-500 hover:bg-emerald-100'
                        : statusType === 'syncing'
                        ? 'bg-amber-50 border-amber-100 text-amber-600 focus:ring-amber-500 hover:bg-amber-100'
                        : 'bg-rose-50 border-rose-100 text-rose-500 animate-pulse focus:ring-rose-500'
                }`}
                title={[
                    isForcing ? 'Sincronizando…' : statusType === 'online' ? 'Conectado' : statusType === 'syncing' ? `${pendingCount} pendiente${pendingCount > 1 ? 's' : ''} (ventas y ajustes)` : 'Sin conexión',
                    `Último sync: ${lastSyncLabel || 'todavía no'}`,
                    syncDiag.dirtyCount > 0 ? `${syncDiag.dirtyCount} cambio${syncDiag.dirtyCount > 1 ? 's' : ''} sin subir` : null,
                ].filter(Boolean).join(' · ')}
            >
                {statusType === 'online' && <>{isForcing ? <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" /> : <Wifi size={13} strokeWidth={2.5} />}<span className="hidden sm:inline">Online</span></>}
                {statusType === 'syncing' && <><RefreshCw size={13} strokeWidth={2.5} className={isForcing ? 'animate-spin' : 'animate-spin-slow'} /><span className="hidden sm:inline">Sync ({pendingCount})</span><span className="sm:hidden">{pendingCount}</span></>}
                {statusType === 'offline' && <><WifiOff size={13} strokeWidth={2.5} /><span>Offline</span></>}
            </button>

            {/* Último sync y cambios pendientes de subir */}
            <span className="hidden sm:block text-[9px] leading-none text-slate-400 dark:text-slate-500 pl-1">
                {lastSyncLabel ? `Sync ${lastSyncLabel}` : 'Sin sincronizar'}
                {syncDiag.dirtyCount > 0 && (
                    <span className="text-amber-500"> · {syncDiag.dirtyCount} sin subir</span>
                )}
            </span>

            {/* Banner ventas fallidas */}
            {showFailedBanner && failedCount > 0 && (
                <button
                    onClick={() => setShowErrorModal(true)}
                    className="flex items-center gap-1.5 px-2 py-1 bg-red-50 border border-red-200 rounded-lg text-[10px] text-red-600 font-medium max-w-[200px] hover:bg-red-100 transition-colors text-left"
                >
                    <AlertTriangle size={11} className="shrink-0" />
                    <span className="truncate flex-1">{failedCount} por revisar</span>
                    <ChevronRight size={10} className="shrink-0" />
                </button>
            )}

            {/* Modal de errores — renderizado en body para evitar problemas de z-index */}
            {showErrorModal && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 z-[200] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
                    onClick={() => setShowErrorModal(false)}
                >
                    <div
                        className="bg-white dark:bg-slate-900 w-full sm:max-w-md sm:rounded-2xl rounded-t-[2rem] p-5 shadow-2xl max-h-[80vh] flex flex-col"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4 shrink-0">
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 bg-red-100 dark:bg-red-900/30 rounded-lg flex items-center justify-center">
                                    <AlertTriangle size={16} className="text-red-500" />
                                </div>
                                <div>
                                    <p className="text-sm font-black text-slate-800 dark:text-white">Log de Sincronización</p>
                                    <p className="text-[10px] text-slate-400">{failedCount} venta{failedCount > 1 ? 's' : ''} o ajuste{failedCount > 1 ? 's' : ''} por revisar</p>
                                </div>
                            </div>
                            <button onClick={() => setShowErrorModal(false)} className="text-slate-400 hover:text-slate-600 p-1">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="overflow-y-auto flex-1 space-y-2 mb-4">
                            {failedItems.map(({ kind, item }) => {
                                const d = new Date(item.created_at);
                                const { title, hint } = describeProblem(kind, item);
                                const isConflict = item.sync_status === 'conflicted';
                                return (
                                    <div key={`${kind}-${item.id}`} className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-xl p-3 space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-black text-slate-700 dark:text-slate-200">
                                                {title}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[9px] bg-red-100 dark:bg-red-900/40 text-red-500 px-1.5 py-0.5 rounded font-bold uppercase">
                                                    {isConflict ? 'Conflicto' : `${item.attempts || 0} intentos`}
                                                </span>
                                                <span className="text-[10px] text-slate-400">
                                                    {d.toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-red-600 dark:text-red-400 font-mono break-all leading-snug bg-red-100/50 dark:bg-red-900/20 rounded px-2 py-1.5">
                                            {item.last_error || 'Error desconocido'}
                                        </p>
                                        {hint && <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">{hint}</p>}
                                    </div>
                                );
                            })}
                        </div>

                        <div className="flex gap-2 shrink-0">
                            <button
                                onClick={handleCopyLogs}
                                className="py-2.5 px-3 text-xs font-bold rounded-xl transition-all active:scale-95 flex items-center justify-center gap-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
                            >
                                {copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /></>}
                            </button>
                            <button
                                onClick={handleRetryFailed}
                                disabled={isRetrying || !isOnline}
                                className="flex-1 py-2.5 text-xs font-bold text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-all active:scale-95 flex items-center justify-center gap-1.5"
                            >
                                <RotateCcw size={13} className={isRetrying ? 'animate-spin' : ''} />
                                {isRetrying ? 'Reintentando...' : 'Reintentar todas'}
                            </button>
                            <button
                                onClick={handleDismissFailed}
                                className="py-2.5 px-3 text-xs font-bold text-white bg-red-500 hover:bg-red-600 rounded-xl transition-all active:scale-95"
                            >
                                Descartar fallidas
                            </button>
                        </div>
                    </div>
                </div>
            , document.body)}
        </div>
    );
}

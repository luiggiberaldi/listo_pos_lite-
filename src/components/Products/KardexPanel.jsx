import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, CheckCircle, AlertTriangle, Clock, RefreshCw, WifiOff } from 'lucide-react';
import { fetchProductKardex } from '../../services/kardexService';
import { offlineQueueService } from '../../services/offlineQueueService';
import { inventoryQueueService } from '../../services/inventoryQueueService';
import { buildKardexView, pendingKardexEntries } from '../../utils/kardexLedger';

const fmtQty = (n) => (n == null ? '' : Number(n).toLocaleString('es-VE', { maximumFractionDigits: 3 }));

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

// El motivo solo se muestra si agrega algo (no "Conteo · CONTEO" ni "Venta · Venta").
const showReason = (r) => {
    if (!r.reason || r.type === 'VENTA') return false;
    const reason = r.reason.trim().toLowerCase();
    return reason !== r.label.toLowerCase() && reason !== String(r.type || '').toLowerCase();
};

const STATUS_LABEL ={ pending: 'pendiente', failed: 'falló, reintentando', conflicted: 'por revisar' };

/**
 * Libreta (Kardex) de un producto: movimientos confirmados por el servidor
 * desde la apertura, y aparte los del dispositivo que aún no se sincronizan.
 * Muestra los últimos 5; "Ver todos" abre la pantalla Movimientos.
 */
export default function KardexPanel({ productId, onViewAll }) {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState({ loading: false, error: null, opening: null, view: null, pending: [] });

    const load = useCallback(async () => {
        if (!productId) return;
        setState(s => ({ ...s, loading: true, error: null }));
        let pending = [];
        try {
            const [salesQueue, inventoryQueue] = await Promise.all([
                offlineQueueService.getQueue().catch(() => []),
                inventoryQueueService.getQueue().catch(() => []),
            ]);
            pending = pendingKardexEntries(productId, { salesQueue, inventoryQueue });
        } catch { /* sin colas: solo lo confirmado */ }

        try {
            const data = await fetchProductKardex(productId);
            setState({ loading: false, error: null, opening: data?.opening || null, view: buildKardexView(data?.movements || []), pending });
        } catch (err) {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            setState({ loading: false, error: offline ? 'offline' : (err?.message || 'error'), opening: null, view: null, pending });
        }
    }, [productId]);

    useEffect(() => { if (open) load(); }, [open, load]);

    const { loading, error, opening, view, pending } = state;
    const LAST = 5;
    const rows = view?.rows ? [...view.rows].reverse().slice(0, LAST) : [];
    const hidden = view?.rows ? Math.max(view.rows.length - LAST, 0) : 0;

    return (
        <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <button onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-50 dark:bg-slate-800/50 text-xs font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">
                <span className="flex items-center gap-1.5">
                    <BookOpen size={13} className="text-blue-500" />
                    Kardex (movimientos)
                </span>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {open && (
                <div className="bg-white dark:bg-slate-900 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
                    {loading && <p className="text-slate-400 text-center py-5">Cargando…</p>}

                    {!loading && error && (
                        <div className="flex items-center gap-2 px-3 py-3 text-slate-500">
                            <WifiOff size={14} className="shrink-0" />
                            <span className="flex-1">{error === 'offline' ? 'Sin conexión: el Kardex se lee del servidor.' : `No se pudo leer el Kardex (${error}).`}</span>
                            <button onClick={load} className="p-1 text-blue-500" title="Reintentar"><RefreshCw size={14} /></button>
                        </div>
                    )}

                    {!loading && !error && !opening && (
                        <p className="px-3 py-4 text-slate-500">
                            El Kardex de este negocio todavía no se ha iniciado. El dueño lo inicia en <b>Inventario → Iniciar Kardex</b>.
                        </p>
                    )}

                    {!loading && !error && opening && view && !view.started && (
                        <p className="px-3 py-4 text-slate-500">
                            Este producto aún no tiene saldo inicial en el Kardex (se registra cuando el producto llega al servidor).
                        </p>
                    )}

                    {!loading && !error && view?.started && (
                        <>
                            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 text-[9px] font-black uppercase tracking-wider text-slate-400">
                                <span>Movimiento</span><span className="text-right">Entra</span><span className="text-right">Sale</span><span className="text-right">Saldo</span>
                            </div>
                            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-64 overflow-y-auto">
                                {rows.map(r => (
                                    <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-center px-3 py-1.5">
                                        <div className="min-w-0">
                                            <p className="font-bold text-slate-600 dark:text-slate-300 truncate">{r.label}{showReason(r) ?<span className="font-medium text-slate-400"> · {r.reason}</span> : null}</p>
                                            <p className="text-[9px] text-slate-400">{fmtDate(r.createdAt)}{r.actor ? ` · ${r.actor}` : ''}</p>
                                        </div>
                                        <span className="text-right font-bold text-emerald-600">{r.entra != null ? `+${fmtQty(r.entra)}` : ''}</span>
                                        <span className="text-right font-bold text-rose-500">{r.sale != null ? `-${fmtQty(r.sale)}` : ''}</span>
                                        <span className="text-right font-black text-slate-700 dark:text-white">{fmtQty(r.saldo)}</span>
                                    </div>
                                ))}
                            </div>
                            <div className={`flex items-start gap-1.5 px-3 py-2 border-t border-slate-100 dark:border-slate-800 ${view.consistent ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {view.consistent ? <CheckCircle size={13} className="shrink-0 mt-px" /> : <AlertTriangle size={13} className="shrink-0 mt-px" />}
                                <span>
                                    Apertura {fmtQty(view.opening.saldo)} + entradas {fmtQty(view.totalIn)} − salidas {fmtQty(view.totalOut)} = <b>{fmtQty(view.balance)}</b>
                                    {view.consistent ? ' ✓' : ` · ${view.gaps.length} cambio(s) de stock sin movimiento anotado`}
                                </span>
                            </div>
                            {onViewAll && (
                                <button onClick={onViewAll}
                                    className="w-full px-3 py-2 border-t border-slate-100 dark:border-slate-800 text-xs font-bold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                                    {hidden > 0 ? `Ver todos los movimientos (${hidden} más)` : 'Ver en Movimientos'}
                                </button>
                            )}
                        </>
                    )}

                    {!loading && pending.length > 0 && (
                        <div className="border-t border-dashed border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
                            <p className="flex items-center gap-1.5 px-3 pt-2 text-[10px] font-black uppercase tracking-wider text-amber-600">
                                <Clock size={12} /> Sin confirmar en este dispositivo ({pending.length})
                            </p>
                            {pending.map(p => (
                                <div key={p.key} className="flex justify-between gap-2 px-3 py-1 text-amber-700 dark:text-amber-400">
                                    <span className="truncate">{p.label} · {fmtDate(p.createdAt)} · {STATUS_LABEL[p.status] || p.status}</span>
                                    <span className="font-bold shrink-0">
                                        {p.countTo != null ? `= ${fmtQty(p.countTo)}` : p.entra != null ? `+${fmtQty(p.entra)}` : `-${fmtQty(p.sale)}`}
                                    </span>
                                </div>
                            ))}
                            <p className="px-3 pb-2 text-[9px] text-amber-600/80">No cuentan en el saldo de arriba hasta que el servidor los confirme.</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

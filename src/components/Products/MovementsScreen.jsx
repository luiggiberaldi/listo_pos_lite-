import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft, ArrowRightLeft, BookOpen, CalendarDays, CheckCircle, AlertTriangle, ClipboardCheck, Clock,
    Download, Flag, Loader2, PackageX, Search, ShoppingCart, SlidersHorizontal, Undo2, WifiOff, X,
} from 'lucide-react';
import { fetchKardexStatus, fetchMovements, fetchProductKardex } from '../../services/kardexService';
import { offlineQueueService } from '../../services/offlineQueueService';
import { inventoryQueueService } from '../../services/inventoryQueueService';
import { storageService } from '../../utils/storageService';
import RoundedSelect from '../ui/RoundedSelect';
import {
    DATE_PRESETS, MOVEMENT_TYPE_FILTERS, buildKardexView, buildSaleNumberIndex, dateRangeFor,
    describeMovement, formatUnits, groupByDay, movementsToCsv, pendingKardexEntries,
} from '../../utils/kardexLedger';

const TYPE_STYLE = {
    VENTA: { Icon: ShoppingCart, color: 'text-rose-500 bg-rose-50 dark:bg-rose-900/20' },
    ANULACION: { Icon: Undo2, color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20' },
    CONTEO: { Icon: ClipboardCheck, color: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20' },
    AJUSTE_DIRECTO: { Icon: SlidersHorizontal, color: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' },
    VACIADO: { Icon: PackageX, color: 'text-slate-500 bg-slate-100 dark:bg-slate-800' },
    APERTURA: { Icon: Flag, color: 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' },
};

const fmtNum = n => Number(n).toLocaleString('es-VE', { maximumFractionDigits: 3 });
// Con signo solo si hay cantidad: "+12", "−3", "0" (nunca "+0" ni "−0").
const signed = (n, sign) => (Number(n) ? `${sign}${fmtNum(n)}` : '0');
const fmtTime = iso => new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false });

function dayTitle(day) {
    if (day === 'sin-fecha') return 'Sin fecha';
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const label = date.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'short' });
    if (same(date, today)) return `Hoy · ${label}`;
    if (same(date, yesterday)) return `Ayer · ${label}`;
    return label.charAt(0).toUpperCase() + label.slice(1);
}

const todayInput = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Movimientos (Kardex completo): todos los movimientos de inventario de la
 * cuenta, por fecha, producto y tipo. Lo confirmado viene del servidor; lo
 * pendiente del dispositivo se muestra aparte y nunca suma al saldo.
 */
export default function MovementsScreen({ isOpen, onClose, products = [], initialProductId = null }) {
    const [opening, setOpening] = useState({ checked: false, data: null });
    const [preset, setPreset] = useState('hoy');
    const [custom, setCustom] = useState({ from: todayInput(), to: todayInput() });
    const [typeFilter, setTypeFilter] = useState('todos');
    const [productId, setProductId] = useState(initialProductId);
    const [search, setSearch] = useState('');
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [state, setState] = useState({ loading: false, error: null, rows: [], summary: null, hasMore: false });
    const [loadingMore, setLoadingMore] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [book, setBook] = useState(null);
    const [pending, setPending] = useState([]);
    const [saleNumbers, setSaleNumbers] = useState(new Map());
    const requestRef = useRef(0);

    const productsById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
    const selectedProduct = productId ? productsById.get(productId) : null;

    useEffect(() => {
        if (isOpen) {
            setProductId(initialProductId);
            setPreset(initialProductId ? 'todo' : 'hoy');
            setSearch('');
        }
    }, [isOpen, initialProductId]);

    useEffect(() => {
        if (!isOpen) return;
        fetchKardexStatus()
            .then(d => setOpening({ checked: true, data: d?.opening || null }))
            .catch(() => setOpening({ checked: true, data: null }));
        storageService.getItem('bodega_sales_v1', [])
            .then(sales => setSaleNumbers(buildSaleNumberIndex(sales)))
            .catch(() => {});
    }, [isOpen]);

    // Coincidencias del buscador (nombre o código de barras).
    const matches = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (q.length < 2) return [];
        return products.filter(p => (p.name || '').toLowerCase().includes(q) || String(p.barcode || '').includes(q)).slice(0, 100);
    }, [search, products]);

    const filters = useMemo(() => {
        const range = preset === 'todo' ? { from: null, to: null } : dateRangeFor(preset, new Date(), custom);
        const types = MOVEMENT_TYPE_FILTERS.find(t => t.id === typeFilter)?.types || [];
        const productIds = productId ? [productId] : (search.trim().length >= 2 ? matches.map(p => p.id) : []);
        return { ...range, types, productIds, noMatches: !productId && search.trim().length >= 2 && matches.length === 0 };
    }, [preset, custom, typeFilter, productId, search, matches]);

    const load = useCallback(async () => {
        const req = ++requestRef.current;
        if (filters.noMatches) {
            setState({ loading: false, error: null, rows: [], summary: { count: 0, entradas: 0, salidas: 0 }, hasMore: false });
            return;
        }
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const data = await fetchMovements(filters);
            if (req !== requestRef.current) return;
            setState({ loading: false, error: null, rows: data.movements || [], summary: data.summary, hasMore: Boolean(data.hasMore) });
        } catch (err) {
            if (req !== requestRef.current) return;
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            setState({ loading: false, error: offline ? 'offline' : (err?.message || 'error'), rows: [], summary: null, hasMore: false });
        }
    }, [filters]);

    useEffect(() => {
        if (!isOpen || !opening.data) return undefined;
        const t = setTimeout(load, search ? 300 : 0);
        return () => clearTimeout(t);
    }, [isOpen, opening.data, load, search]);

    // Libreta completa del producto elegido (saldo inicial + movimientos).
    useEffect(() => {
        if (!isOpen || !productId || !opening.data) { setBook(null); return; }
        let alive = true;
        fetchProductKardex(productId)
            .then(d => { if (alive) setBook(buildKardexView(d?.movements || [])); })
            .catch(() => { if (alive) setBook(null); });
        return () => { alive = false; };
    }, [isOpen, productId, opening.data, state.rows]);

    // Pendientes del dispositivo (colas sin confirmar).
    useEffect(() => {
        if (!isOpen) return;
        Promise.all([
            offlineQueueService.getQueue().catch(() => []),
            inventoryQueueService.getQueue().catch(() => []),
        ]).then(([salesQueue, inventoryQueue]) => {
            const all = pendingKardexEntries(null, { salesQueue, inventoryQueue });
            const ids = new Set(filters.productIds);
            setPending(filters.productIds.length ? all.filter(p => ids.has(p.productId)) : all);
        });
    }, [isOpen, filters.productIds, state.rows]);

    const loadMore = async () => {
        const last = state.rows[state.rows.length - 1];
        if (!last) return;
        setLoadingMore(true);
        try {
            const data = await fetchMovements({ ...filters, beforeId: last.id });
            setState(s => ({ ...s, rows: [...s.rows, ...(data.movements || [])], hasMore: Boolean(data.hasMore) }));
        } catch { /* el botón queda para reintentar */ }
        setLoadingMore(false);
    };

    const exportCsv = async () => {
        setExporting(true);
        try {
            let rows = [];
            let beforeId = null;
            for (let page = 0; page < 50; page++) {
                const data = await fetchMovements({ ...filters, beforeId, limit: 100 });
                rows = rows.concat(data.movements || []);
                if (!data.hasMore || !data.movements?.length) break;
                beforeId = data.movements[data.movements.length - 1].id;
            }
            const csv = movementsToCsv(rows, { productsById, saleNumbers });
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `movimientos-${todayInput()}${selectedProduct ? '-' + selectedProduct.name.replace(/[^\w-]+/g, '_') : ''}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { /* sin conexión: no se descarga nada */ }
        setExporting(false);
    };

    if (!isOpen) return null;

    const groups = groupByDay(state.rows);
    const summary = state.summary;

    return (
        <div className="fixed inset-0 z-[95] bg-slate-50 dark:bg-slate-950 overflow-y-auto animate-in fade-in duration-150">
            <div className="max-w-3xl mx-auto p-3 sm:p-4 pb-28 space-y-3">
                {/* Cabecera */}
                <div className="flex items-center gap-2">
                    <button onClick={onClose} className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 active:scale-95" title="Volver">
                        <ArrowLeft size={18} />
                    </button>
                    <ArrowRightLeft size={20} className="text-brand" />
                    <h2 className="text-lg sm:text-2xl font-black text-slate-800 dark:text-white tracking-tight">Movimientos</h2>
                    {opening.data && (
                        <span className="hidden sm:inline text-[10px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded-full">
                            Kardex desde {new Date(opening.data.opened_at).toLocaleDateString('es-VE')}
                        </span>
                    )}
                    {opening.data && (
                        <button onClick={exportCsv} disabled={exporting || state.rows.length === 0}
                            className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 disabled:opacity-40 active:scale-95"
                            title="Descargar para Excel">
                            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Excel
                        </button>
                    )}
                </div>

                {opening.checked && !opening.data && (
                    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 text-sm text-slate-600 dark:text-slate-300 space-y-2">
                        <p className="flex items-center gap-2 font-bold text-slate-800 dark:text-white"><BookOpen size={18} className="text-emerald-500" /> El Kardex aún no se ha iniciado</p>
                        <p>Cuando el dueño pulse <b>Iniciar Kardex</b> (libro verde en Inventario), aquí verás cada venta, anulación, ajuste y conteo con el saldo que quedó.</p>
                    </div>
                )}

                {opening.data && (
                    <>
                        {/* Fechas */}
                        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
                            {DATE_PRESETS.map(p => (
                                <button key={p.id} onClick={() => setPreset(p.id)}
                                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${preset === p.id ? 'bg-brand text-white border-brand' : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-800'}`}>
                                    {p.label}
                                </button>
                            ))}
                            <button onClick={() => setPreset('custom')}
                                className={`shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${preset === 'custom' ? 'bg-brand text-white border-brand' : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-800'}`}>
                                <CalendarDays size={13} /> Elegir fechas
                            </button>
                        </div>
                        {preset === 'custom' && (
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                <span>Desde</span>
                                <input type="date" value={custom.from} max={custom.to} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
                                    className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900" />
                                <span>hasta</span>
                                <input type="date" value={custom.to} min={custom.from} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
                                    className="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900" />
                            </div>
                        )}

                        {/* Producto y tipo */}
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            {selectedProduct ? (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm font-bold text-blue-700 dark:text-blue-300 min-w-0">
                                    <span className="truncate">{selectedProduct.name}</span>
                                    <button onClick={() => { setProductId(null); setPreset('hoy'); }} className="ml-auto p-0.5 shrink-0" title="Quitar producto"><X size={15} /></button>
                                </div>
                            ) : (
                                <div className="relative">
                                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                    <input value={search} onChange={e => { setSearch(e.target.value); setShowSuggestions(true); }}
                                        onFocus={() => setShowSuggestions(true)} onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                                        placeholder="Buscar producto (nombre o código)"
                                        className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" />
                                    {showSuggestions && matches.length > 0 && (
                                        <div className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg max-h-60 overflow-y-auto">
                                            {matches.slice(0, 8).map(p => (
                                                <button key={p.id} onMouseDown={() => { setProductId(p.id); setSearch(''); setPreset('todo'); }}
                                                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                                                    {p.name} <span className="text-xs text-slate-400">· ver su libreta</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            <RoundedSelect value={typeFilter} onChange={setTypeFilter} ariaLabel="Tipo de movimiento"
                                options={MOVEMENT_TYPE_FILTERS.map(t => ({ value: t.id, label: t.label }))} />
                        </div>

                        {/* Libreta del producto elegido */}
                        {selectedProduct && book?.started && (
                            <div className={`rounded-2xl border p-3 text-sm ${book.consistent ? 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800' : 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800'}`}>
                                <p className={`flex items-center gap-1.5 font-bold ${book.consistent ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
                                    {book.consistent ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
                                    {book.consistent ? 'La libreta cuadra' : 'Hay cambios de stock sin movimiento anotado'}
                                </p>
                                <p className="mt-1 text-slate-600 dark:text-slate-300">
                                    Saldo inicial <b>{formatUnits(book.opening.saldo, selectedProduct)}</b> · entradas <b className="text-emerald-600">{signed(book.totalIn, '+')}</b> · salidas <b className="text-rose-500">{signed(book.totalOut, '−')}</b> · saldo hoy <b>{formatUnits(book.balance, selectedProduct)}</b>
                                </p>
                            </div>
                        )}
                        {selectedProduct && book && !book.started && (
                            <p className="text-xs text-slate-500 px-1">Este producto aún no tiene saldo inicial en el Kardex.</p>
                        )}

                        {/* Resumen del rango */}
                        {summary && (
                            <div className="grid grid-cols-3 gap-2">
                                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                                    <p className="text-[11px] font-bold text-slate-400 uppercase">Entradas</p>
                                    <p className="text-xl font-black text-emerald-600">{signed(summary.entradas, '+')}</p>
                                </div>
                                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                                    <p className="text-[11px] font-bold text-slate-400 uppercase">Salidas</p>
                                    <p className="text-xl font-black text-rose-500">{signed(summary.salidas, '−')}</p>
                                </div>
                                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                                    <p className="text-[11px] font-bold text-slate-400 uppercase">Movimientos</p>
                                    <p className="text-xl font-black text-slate-700 dark:text-white">{fmtNum(summary.count)}</p>
                                </div>
                            </div>
                        )}

                        {/* Pendientes del dispositivo */}
                        {pending.length > 0 && (
                            <div className="rounded-2xl border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/10 overflow-hidden">
                                <p className="flex items-center gap-1.5 px-3 pt-2.5 text-[11px] font-black uppercase tracking-wider text-amber-600">
                                    <Clock size={13} /> Sin confirmar en este dispositivo ({pending.length})
                                </p>
                                {pending.map(p => {
                                    const prod = productsById.get(p.productId);
                                    const saleNo = p.ref && saleNumbers.get(String(p.ref));
                                    return (
                                        <div key={p.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-amber-800 dark:text-amber-300">
                                            <span className="truncate"><b>{prod?.name || 'Producto'}</b> · {p.label}{saleNo ? ` #${String(saleNo).padStart(7, '0')}` : ''} · {fmtTime(p.createdAt)}</span>
                                            <span className="font-bold shrink-0">{p.countTo != null ? `= ${fmtNum(p.countTo)}` : p.entra != null ? `+${fmtNum(p.entra)}` : `−${fmtNum(p.sale)}`}</span>
                                        </div>
                                    );
                                })}
                                <p className="px-3 pb-2.5 text-[11px] text-amber-600/80">Se sumarán a la libreta cuando el servidor los confirme.</p>
                            </div>
                        )}

                        {/* Lista */}
                        {state.loading && <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Cargando…</p>}
                        {!state.loading && state.error && (
                            <div className="flex items-center gap-2 p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-500">
                                <WifiOff size={16} />
                                <span className="flex-1">{state.error === 'offline' ? 'Sin conexión: los movimientos se leen del servidor.' : `No se pudieron leer los movimientos (${state.error}).`}</span>
                                <button onClick={load} className="text-brand font-bold">Reintentar</button>
                            </div>
                        )}
                        {!state.loading && !state.error && state.rows.length === 0 && (
                            <div className="text-center py-10 text-sm text-slate-400">
                                No hay movimientos en este rango.
                                {preset !== 'todo' && <button onClick={() => setPreset('todo')} className="block mx-auto mt-2 text-brand font-bold">Ver todas las fechas</button>}
                            </div>
                        )}
                        {!state.loading && !state.error && groups.map(g => (
                            <div key={g.day}>
                                <p className="px-1 pb-1.5 pt-1 text-xs font-bold text-slate-400 capitalize">{dayTitle(g.day)}</p>
                                <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
                                    {g.rows.map(r => {
                                        const prod = productsById.get(r.product_id);
                                        const style = TYPE_STYLE[r.operation_type] || TYPE_STYLE.AJUSTE_DIRECTO;
                                        const delta = Number(r.delta);
                                        const isOpening = r.operation_type === 'APERTURA';
                                        return (
                                            <div key={r.id} className="grid grid-cols-[32px_minmax(0,1fr)_auto_auto] gap-x-3 items-center px-3 py-2.5">
                                                <span className={`w-8 h-8 rounded-xl flex items-center justify-center ${style.color}`}><style.Icon size={16} /></span>
                                                <button onClick={() => { if (prod) { setProductId(prod.id); setPreset('todo'); } }} className="min-w-0 text-left">
                                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{prod?.name || 'Producto eliminado'}</p>
                                                    <p className="text-[11px] text-slate-400 truncate">{describeMovement(r, { saleNumbers })} · {fmtTime(r.created_at)}{r.actor ? ` · ${r.actor}` : ''}</p>
                                                </button>
                                                <span className={`text-sm font-black text-right ${isOpening ? 'text-violet-500' : delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-500' : 'text-slate-400'}`}>
                                                    {isOpening ? 'Inicio' : delta > 0 ? `+${fmtNum(delta)}` : delta < 0 ? `−${fmtNum(-delta)}` : '0'}
                                                </span>
                                                <span className="text-right min-w-[3.5rem]">
                                                    <span className="block text-sm font-black text-slate-700 dark:text-white">{fmtNum(r.stock_after)}</span>
                                                    <span className="block text-[10px] text-slate-400">saldo</span>
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                        {!state.loading && state.hasMore && (
                            <button onClick={loadMore} disabled={loadingMore}
                                className="w-full py-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm font-bold text-brand active:scale-[0.99]">
                                {loadingMore ? 'Cargando…' : 'Ver más movimientos'}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

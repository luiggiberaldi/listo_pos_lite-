import { useState, useEffect, useMemo } from 'react';
import { BarChart3, Calendar, Download, TrendingUp, ShoppingBag, DollarSign, Package, ChevronDown } from 'lucide-react';
import { storageService } from '../utils/storageService';
import { formatBs } from '../utils/calculatorUtils';
import { getPaymentLabel, PAYMENT_ICONS, toTitleCase, getPaymentIcon } from '../config/paymentMethods';
import { useProductContext } from '../context/ProductContext';
import EmptyState from '../components/EmptyState';

const SALES_KEY = 'bodega_sales_v1';

const RANGE_OPTIONS = [
    { id: 'today', label: 'Hoy' },
    { id: 'week', label: 'Esta Semana' },
    { id: 'month', label: 'Este Mes' },
    { id: 'lastMonth', label: 'Mes Anterior' },
    { id: 'custom', label: 'Personalizado' },
];

function getDateRange(rangeId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    switch (rangeId) {
        case 'today': {
            return { from: todayStr, to: todayStr };
        }
        case 'week': {
            const d = new Date(now);
            d.setDate(d.getDate() - d.getDay()); // domingo
            return { from: d.toISOString().split('T')[0], to: todayStr };
        }
        case 'month': {
            const d = new Date(now.getFullYear(), now.getMonth(), 1);
            return { from: d.toISOString().split('T')[0], to: todayStr };
        }
        case 'lastMonth': {
            const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const end = new Date(now.getFullYear(), now.getMonth(), 0);
            return { from: d.toISOString().split('T')[0], to: end.toISOString().split('T')[0] };
        }
        default:
            return { from: todayStr, to: todayStr };
    }
}

export default function ReportsView({ rates, triggerHaptic }) {
    const { products } = useProductContext();
    const [allSales, setAllSales] = useState([]);
    const [selectedRange, setSelectedRange] = useState('week');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    const bcvRate = rates?.bcv?.price || 0;

    useEffect(() => {
        const load = async () => {
            const saved = await storageService.getItem(SALES_KEY, []);
            setAllSales(saved);
            setIsLoading(false);
        };
        load();
    }, []);

    const { from, to } = useMemo(() => {
        if (selectedRange === 'custom') {
            return {
                from: customFrom || new Date().toISOString().split('T')[0],
                to: customTo || new Date().toISOString().split('T')[0],
            };
        }
        return getDateRange(selectedRange);
    }, [selectedRange, customFrom, customTo]);

    const filteredSales = useMemo(() => {
        return allSales.filter(s => {
            if (s.status === 'ANULADA' || s.tipo === 'COBRO_DEUDA' || s.tipo === 'AJUSTE_ENTRADA' || s.tipo === 'AJUSTE_SALIDA' || s.tipo === 'VENTA_FIADA') return false;
            const dateStr = s.timestamp?.split('T')[0];
            return dateStr >= from && dateStr <= to;
        });
    }, [allSales, from, to]);

    // ── Métricas ──
    const totalUsd = filteredSales.reduce((s, sale) => s + (sale.totalUsd || 0), 0);
    const totalBs = filteredSales.reduce((s, sale) => s + (sale.totalBs || 0), 0);
    const totalItems = filteredSales.reduce((s, sale) => s + sale.items.reduce((is, i) => is + i.qty, 0), 0);

    const profit = filteredSales.reduce((sum, s) => {
        return sum + s.items.reduce((is, item) => {
            const saleRate = s.rate || bcvRate;
            let costBs;
            if (item.costUsd) {
                costBs = item.costUsd * saleRate;
            } else if (item.costBs) {
                costBs = item.costBs;
            } else {
                const p = products.find(p => p.id === item.id || p.id === item._originalId || p.name === item.name);
                if (p) {
                    costBs = p.costUsd ? p.costUsd * saleRate : (p.costBs || 0);
                    if (item.id && typeof item.id === 'string' && item.id.endsWith('_unit')) costBs = costBs / (p.unitsPerPackage || 1);
                } else {
                    costBs = 0;
                }
            }
            const saleBs = item.priceUsd * item.qty * saleRate;
            return is + (saleBs - (costBs * item.qty));
        }, 0);
    }, 0);

    // Desglose por método de pago
    const paymentBreakdown = {};
    filteredSales.forEach(s => {
        (s.payments || []).forEach(p => {
            if (!paymentBreakdown[p.methodId]) paymentBreakdown[p.methodId] = { total: 0, currency: p.currency || 'BS', label: p.methodLabel };
            paymentBreakdown[p.methodId].total += (p.currency === 'USD' ? p.amountUsd : p.amountBs) || 0;
        });
    });

    // Top productos
    const productMap = {};
    filteredSales.forEach(s => {
        s.items.forEach(item => {
            if (!productMap[item.name]) productMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
            productMap[item.name].qty += item.qty;
            productMap[item.name].revenue += item.priceUsd * item.qty;
        });
    });
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    // Ventas por día para mini gráfica
    const salesByDay = useMemo(() => {
        const map = {};
        filteredSales.forEach(s => {
            const day = s.timestamp?.split('T')[0];
            if (!map[day]) map[day] = { date: day, total: 0, count: 0 };
            map[day].total += s.totalUsd || 0;
            map[day].count++;
        });
        return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
    }, [filteredSales]);

    const maxDayTotal = Math.max(...salesByDay.map(d => d.total), 1);

    // ── PDF Export ──
    const handleExportPDF = async () => {
        triggerHaptic && triggerHaptic();
        try {
            const { generateDailyClosePDF } = await import('../utils/dailyCloseGenerator');
            await generateDailyClosePDF({
                sales: filteredSales,
                allSales: filteredSales,
                bcvRate,
                paymentBreakdown,
                topProducts,
                todayTotalUsd: totalUsd,
                todayTotalBs: totalBs,
                todayProfit: profit,
                todayItemsSold: totalItems,
            });
        } catch (e) {
            console.error('Error generando PDF:', e);
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 p-3 sm:p-4 md:p-6 space-y-4">
                <div className="skeleton h-10 w-32" />
                <div className="flex gap-2">
                    <div className="skeleton h-9 w-20" />
                    <div className="skeleton h-9 w-24" />
                    <div className="skeleton h-9 w-20" />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="skeleton h-24" />
                    <div className="skeleton h-24" />
                    <div className="skeleton h-24" />
                    <div className="skeleton h-24" />
                </div>
                <div className="skeleton h-40" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 space-y-4 md:space-y-5 pb-32">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <h2 className="text-xl md:text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                    <div className="bg-indigo-500 text-white p-1.5 md:p-2 rounded-xl shadow-lg shadow-indigo-500/30">
                        <BarChart3 size={20} />
                    </div>
                    Reportes
                </h2>
                <button
                    onClick={handleExportPDF}
                    disabled={filteredSales.length === 0}
                    className="flex items-center gap-2 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold rounded-xl text-sm shadow-md shadow-indigo-500/20 active:scale-95 transition-all"
                >
                    <Download size={16} /> Descargar PDF
                </button>
            </div>

            {/* Range Selector */}
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1">
                {RANGE_OPTIONS.map(opt => (
                    <button
                        key={opt.id}
                        onClick={() => { triggerHaptic && triggerHaptic(); setSelectedRange(opt.id); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors active:scale-95 ${selectedRange === opt.id
                            ? 'bg-indigo-500 text-white shadow-sm shadow-indigo-500/30'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'
                            }`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* Custom Date Range */}
            {selectedRange === 'custom' && (
                <div className="flex flex-col sm:flex-row gap-3 bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800">
                    <div className="flex-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Desde</label>
                        <input
                            type="date"
                            value={customFrom}
                            onChange={e => setCustomFrom(e.target.value)}
                            className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold text-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-indigo-500/30"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Hasta</label>
                        <input
                            type="date"
                            value={customTo}
                            onChange={e => setCustomTo(e.target.value)}
                            className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold text-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-indigo-500/30"
                        />
                    </div>
                </div>
            )}

            {/* Summary Cards — Responsive grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={ShoppingBag} label="Ventas" value={filteredSales.length} color="emerald" />
                <StatCard icon={DollarSign} label="Ingresos" value={`$${totalUsd.toFixed(2)}`} sub={`${formatBs(totalBs)} Bs`} color="blue" />
                <StatCard icon={TrendingUp} label="Ganancia" value={`${formatBs(profit)} Bs`} sub={bcvRate > 0 ? `$${(profit / bcvRate).toFixed(2)}` : ''} color="indigo" />
                <StatCard icon={Package} label="Artículos" value={totalItems} color="amber" />
            </div>

            {/* Mini bar chart per day */}
            {salesByDay.length > 1 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm mt-4">
                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1">
                        <Calendar size={12} /> Ventas por Día
                    </h3>
                    <div className="flex items-end gap-1 h-24">
                        {salesByDay.map((day, i) => {
                            const pct = (day.total / maxDayTotal) * 100;
                            const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });
                            return (
                                <div key={day.date} className="flex-1 flex flex-col items-center gap-0.5">
                                    <span className="text-[8px] font-bold text-slate-400">${day.total.toFixed(0)}</span>
                                    <div className="w-full flex justify-center">
                                        <div
                                            className="w-full max-w-[24px] rounded-t-md bg-gradient-to-t from-indigo-500 to-indigo-400 transition-all duration-500"
                                            style={{ height: `${Math.max(pct, 6)}%`, minHeight: '3px' }}
                                        />
                                    </div>
                                    <span className="text-[8px] text-slate-400 font-medium leading-none">{dayLabel}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Payment Breakdown */}
            {Object.keys(paymentBreakdown).length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1">
                        <DollarSign size={12} /> Desglose por Método de Pago
                    </h3>
                    <div className="space-y-3">
                        {Object.entries(paymentBreakdown).map(([method, data]) => {
                            const label = toTitleCase(data.label || getPaymentLabel(method));
                            const PayIcon = getPaymentIcon(method) || PAYMENT_ICONS[method];
                            const totalBsEquiv = data.currency === 'USD' ? data.total * bcvRate : data.total;
                            const pct = totalBs > 0 ? (totalBsEquiv / totalBs * 100) : 0;
                            return (
                                <div key={method}>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-slate-600 dark:text-slate-300 font-medium flex items-center gap-1.5">
                                            {PayIcon && <PayIcon size={14} className="text-slate-400" />}
                                            {label}
                                        </span>
                                        <span className="font-bold text-slate-700 dark:text-white">
                                            {data.currency === 'USD' ? `$ ${data.total.toFixed(2)}` : `${formatBs(data.total)} Bs`}
                                        </span>
                                    </div>
                                    <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                        <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Top Products */}
            {topProducts.length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1">
                        <TrendingUp size={12} /> Top Productos
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {topProducts.map((p, i) => (
                            <div key={p.name} className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800 rounded-xl p-2.5">
                                <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black ${i < 3 ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'
                                    }`}>{i + 1}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{p.name}</p>
                                    <p className="text-[10px] text-slate-400">{p.qty} vendidos</p>
                                </div>
                                <span className="text-xs font-black text-indigo-600 dark:text-indigo-400">${p.revenue.toFixed(2)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Empty state */}
            {filteredSales.length === 0 && (
                <div className="mt-8">
                    <EmptyState
                        icon={BarChart3}
                        title="Sin ventas en este período"
                        description="Selecciona otro rango de fechas o usa el botón Personalizado para buscar más atrás."
                    />
                </div>
            )}
        </div>
    );
}

function StatCard({ icon: Icon, label, value, sub, color }) {
    const colors = {
        emerald: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
        blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
        indigo: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
        amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
    };
    return (
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 md:p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${colors[color]}`}>
                <Icon size={16} />
            </div>
            <p className="text-[10px] font-bold text-slate-400 uppercase">{label}</p>
            <p className="text-lg md:text-xl font-black text-slate-800 dark:text-white mt-0.5">{value}</p>
            {sub && <p className="text-xs font-bold text-slate-400 mt-0.5">{sub}</p>}
        </div>
    );
}

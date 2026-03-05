import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { storageService } from '../utils/storageService';
import { showToast } from '../components/Toast';
import { BarChart3, TrendingUp, Package, AlertTriangle, DollarSign, ShoppingBag, Clock, ArrowUpRight, Trash2, ShoppingCart, Store, Users, Send, Ban, ChevronDown, ChevronUp, Moon, Sun, UserPlus, Phone, FileText, Recycle } from 'lucide-react';
import { formatBs, formatVzlaPhone } from '../utils/calculatorUtils';
import { getPaymentLabel, getPaymentMethod, PAYMENT_ICONS } from '../config/paymentMethods';
import SalesHistory from '../components/Dashboard/SalesHistory';
import SalesChart from '../components/Dashboard/SalesChart';
import ConfirmModal from '../components/ConfirmModal';
import { generateTicketPDF } from '../utils/ticketGenerator';
import { generateDailyClosePDF } from '../utils/dailyCloseGenerator';
import { useNotifications } from '../hooks/useNotifications';
import AnimatedCounter from '../components/AnimatedCounter';

const SALES_KEY = 'bodega_sales_v1';

export default function DashboardView({ rates, triggerHaptic, onNavigate, theme, toggleTheme, isActive }) {
    const { notifyCierrePendiente, requestPermission } = useNotifications();
    const [sales, setSales] = useState([]);
    const [products, setProducts] = useState([]);
    const [customers, setCustomers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [voidSaleTarget, setVoidSaleTarget] = useState(null);
    const [isResetTodayOpen, setIsResetTodayOpen] = useState(false);
    const [ticketPendingSale, setTicketPendingSale] = useState(null);
    const [ticketClientName, setTicketClientName] = useState('');
    const [ticketClientPhone, setTicketClientPhone] = useState('');
    const [recycleOffer, setRecycleOffer] = useState(null);
    const [pullDistance, setPullDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const touchStartY = useRef(0);
    const scrollRef = useRef(null);

    const bcvRate = rates.bcv?.price || 0;

    useEffect(() => {
        if (!isActive) return;
        let mounted = true;
        const load = async () => {
            const [savedSales, savedProducts, savedCustomers] = await Promise.all([
                storageService.getItem(SALES_KEY, []),
                storageService.getItem('my_products_v1', []),
                storageService.getItem('my_customers_v1', []),
            ]);
            if (mounted) {
                setSales(savedSales);
                setProducts(savedProducts);
                setCustomers(savedCustomers);
                setIsLoading(false);
            }
        };
        load();
        // Solicitar permiso de notificaciones al primer uso
        requestPermission();
        return () => { mounted = false; };
    }, [isActive]);



    // ── Funciones de Historial Avanzado ──
    const handleVoidSale = async (sale) => {
        setVoidSaleTarget(sale);
    };

    const confirmVoidSale = async () => {
        const sale = voidSaleTarget;
        if (!sale) return;
        setVoidSaleTarget(null);

        try {
            // 1. Marcar venta como ANULADA
            const updatedSales = sales.map(s => {
                if (s.id === sale.id) return { ...s, status: 'ANULADA' };
                return s;
            });

            // 2. Revertir Stock
            const [savedProducts, savedCustomers] = await Promise.all([
                storageService.getItem('my_products_v1', []),
                storageService.getItem('my_customers_v1', [])
            ]);

            let updatedProducts = savedProducts;
            if (sale.items && sale.items.length > 0) {
                updatedProducts = savedProducts.map(p => {
                    const itemInSale = sale.items.find(i => i.id === p.id || i.id === p._originalId || i.id === p.id + '_unit');
                    if (itemInSale) {
                        return { ...p, stock: (p.stock || 0) + itemInSale.qty };
                    }
                    return p;
                });
            }

            // 3. Revertir Deuda/Saldo a Favor del Cliente
            let finalCustomers = savedCustomers;
            const fiadoAmountUsd = sale.fiadoUsd || 0;
            const favorUsed = sale.payments?.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + p.amountUsd, 0) || 0;
            const debtIncurred = fiadoAmountUsd + favorUsed;

            if (sale.customerId && debtIncurred > 0) {
                finalCustomers = finalCustomers.map(c => {
                    if (c.id === sale.customerId) {
                        return { ...c, deuda: c.deuda - debtIncurred };
                    }
                    return c;
                });
            }

            // 4. Guardar todo
            await storageService.setItem(SALES_KEY, updatedSales);
            await storageService.setItem('my_products_v1', updatedProducts);
            await storageService.setItem('my_customers_v1', finalCustomers);

            setSales(updatedSales);
            setProducts(updatedProducts); // actualizar kpi

            // Opcional: triggerHaptic()
            showToast('Venta anulada con éxito', 'success');

            // Ofrecer reciclar la venta
            setRecycleOffer(sale);
        } catch (error) {
            console.error('Error anulando venta:', error);
            showToast('Hubo un problema anulando la venta', 'error');
        }
    };


    const handleShareWhatsApp = (sale) => {
        let text = `*COMPROBANTE DE VENTA | PRECIOS AL DÍA*\n`;
        text += `--------------------------------\n`;
        text += `*Orden:* #${sale.id.substring(0, 6).toUpperCase()}\n`;
        text += `Cliente: ${sale.customerName || 'Consumidor Final'}\n`;
        text += `Fecha: ${new Date(sale.timestamp).toLocaleString('es-VE')}\n`;
        text += `===================================\n\n`;
        text += `*DETALLE DE PRODUCTOS:*\n`;

        if (sale.items && sale.items.length > 0) {
            sale.items.forEach(item => {
                const qty = item.isWeight ? `${item.qty.toFixed(3)}Kg` : `${item.qty} Und`;
                text += `- ${item.name}\n  ${qty} x $${item.priceUsd.toFixed(2)} = *$${(item.priceUsd * item.qty).toFixed(2)}*\n`;
            });
            text += `\n===================================\n`;
        }

        text += `*TOTAL A PAGAR: $${(sale.totalUsd || 0).toFixed(2)}*\n`;
        text += ` Ref: ${formatBs(sale.totalBs || 0)} Bs a ${formatBs(sale.rate || bcvRate)} Bs/$\n`;

        if (sale.fiadoUsd > 0) {
            text += `\n*SALDO PENDIENTE (FIADO): $${sale.fiadoUsd.toFixed(2)}*\n`;
        }
        text += `\n===================================\n`;
        text += `*¡Gracias por su compra!*`;

        const encoded = encodeURIComponent(text);

        // Buscar el cliente de la venta para abrir WhatsApp directo a su número
        const saleCustomer = sale.customerId
            ? customers.find(c => c.id === sale.customerId)
            : null;
        const phone = formatVzlaPhone(saleCustomer?.phone);
        const waUrl = phone
            ? `https://wa.me/${phone}?text=${encoded}`
            : `https://wa.me/?text=${encoded}`;
        window.open(waUrl, '_blank');
    };

    const handleDownloadPDF = (sale) => {
        triggerHaptic();
        generateTicketPDF(sale, bcvRate);
    };

    // ── Registrar cliente para ticket ──
    const handleRegisterClientForTicket = async () => {
        if (!ticketClientName.trim() || !ticketPendingSale) return;

        // 1. Crear nuevo cliente
        const newCustomer = {
            id: crypto.randomUUID(),
            name: ticketClientName.trim(),
            phone: ticketClientPhone.trim() || '',
            deuda: 0,
            favor: 0,
            createdAt: new Date().toISOString(),
        };

        // 2. Guardar cliente en storage
        const updatedCustomers = [...customers, newCustomer];
        setCustomers(updatedCustomers);
        await storageService.setItem('my_customers_v1', updatedCustomers);

        // 3. Actualizar la venta con el cliente nuevo
        const updatedSale = {
            ...ticketPendingSale,
            customerId: newCustomer.id,
            customerName: newCustomer.name,
            customerPhone: newCustomer.phone,
        };
        const updatedSales = sales.map(s => s.id === updatedSale.id ? updatedSale : s);
        setSales(updatedSales);
        await storageService.setItem(SALES_KEY, updatedSales);

        // 4. Cerrar modal y limpiar
        setTicketPendingSale(null);
        setTicketClientName('');
        setTicketClientPhone('');

        // 5. Enviar ticket por WhatsApp automáticamente
        handleShareWhatsApp(updatedSale);
    };

    // ── Métricas del Día (memoized) ──
    const today = new Date().toISOString().split('T')[0];

    const todaySales = useMemo(() =>
        sales.filter(s => s.timestamp?.startsWith(today) && s.tipo !== 'COBRO_DEUDA' && s.status !== 'ANULADA'),
        [sales, today]
    );
    const todayTotalBs = useMemo(() => todaySales.reduce((sum, s) => sum + (s.totalBs || 0), 0), [todaySales]);
    const todayTotalUsd = useMemo(() => todaySales.reduce((sum, s) => sum + (s.totalUsd || 0), 0), [todaySales]);
    const todayItemsSold = useMemo(() => todaySales.reduce((sum, s) => sum + s.items.reduce((is, i) => is + i.qty, 0), 0), [todaySales]);

    // Notificar cierre de caja pendiente (>7pm con ventas sin cerrar)
    useEffect(() => {
        if (todaySales.length > 0) notifyCierrePendiente(todaySales.length);
    }, [todaySales.length, notifyCierrePendiente]);

    const todayProfit = useMemo(() =>
        todaySales.reduce((sum, s) => sum + s.items.reduce((is, item) => {
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
                    if (item.id && item.id.endsWith('_unit')) costBs = costBs / (p.unitsPerPackage || 1);
                } else {
                    costBs = 0;
                }
            }
            const saleBs = item.priceUsd * item.qty * saleRate;
            return is + (saleBs - (costBs * item.qty));
        }, 0), 0),
        [todaySales, bcvRate, products]
    );

    // Últimas 7 ventas
    const recentSales = useMemo(() => sales.slice(0, 7), [sales]);

    // Datos últimos 7 días (para gráfica)
    const weekData = useMemo(() => Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        const dateStr = d.toISOString().split('T')[0];
        const daySales = sales.filter(s => s.timestamp?.startsWith(dateStr) && s.tipo !== 'COBRO_DEUDA' && s.status !== 'ANULADA');
        return { date: dateStr, total: daySales.reduce((sum, s) => sum + (s.totalUsd || 0), 0), count: daySales.length };
    }), [sales]);

    // Productos bajo stock
    const lowStockProducts = useMemo(() =>
        products.filter(p => (p.stock ?? 0) <= (p.lowStockAlert ?? 5))
            .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0)).slice(0, 6),
        [products]
    );

    // Top productos vendidos (todas las ventas netas)
    const topProducts = useMemo(() => {
        const productSalesMap = {};
        sales.filter(s => s.tipo !== 'COBRO_DEUDA' && s.status !== 'ANULADA').forEach(s => {
            s.items.forEach(item => {
                if (!productSalesMap[item.name]) productSalesMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
                productSalesMap[item.name].qty += item.qty;
                productSalesMap[item.name].revenue += item.priceUsd * item.qty * (s.rate || bcvRate);
            });
        });
        return Object.values(productSalesMap).sort((a, b) => b.qty - a.qty).slice(0, 5);
    }, [sales, bcvRate]);

    // Payment method breakdown (today)
    const paymentBreakdown = useMemo(() => {
        const allTodayTransactions = sales.filter(s => s.timestamp?.startsWith(today) && s.status !== 'ANULADA');
        return allTodayTransactions.reduce((acc, s) => {
            if (s.payments && s.payments.length > 0) {
                s.payments.forEach(p => {
                    if (!acc[p.methodId]) acc[p.methodId] = { total: 0, currency: p.currency || 'BS' };
                    acc[p.methodId].total += (p.currency === 'USD' ? p.amountUsd : p.amountBs) || 0;
                });
            } else {
                const method = s.paymentMethod || 'efectivo_bs';
                if (!acc[method]) acc[method] = { total: 0, currency: 'BS' };
                acc[method].total += (s.totalBs || 0);
            }
            return acc;
        }, {});
    }, [sales, today]);

    // Top productos vendidos HOY (para cierre del día)
    const todayTopProducts = useMemo(() => {
        const todayProductMap = {};
        todaySales.forEach(s => {
            s.items.forEach(item => {
                if (!todayProductMap[item.name]) todayProductMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
                todayProductMap[item.name].qty += item.qty;
                todayProductMap[item.name].revenue += item.priceUsd * item.qty * (s.rate || bcvRate);
            });
        });
        return Object.values(todayProductMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
    }, [todaySales, bcvRate]);

    // Handler: Cierre de Caja (abre modal de confirmación)
    const handleDailyClose = () => {
        triggerHaptic && triggerHaptic();
        if (todaySales.length === 0) {
            showToast('No hay ventas hoy para cerrar caja', 'error');
            return;
        }
        setIsResetTodayOpen(true);
    };

    const handleResetToday = async () => {
        // 1. Generar PDF del cierre ANTES de borrar
        if (todaySales.length > 0) {
            const allTodayForReport = sales.filter(s => s.timestamp?.startsWith(today));
            await generateDailyClosePDF({
                sales: todaySales,
                allSales: allTodayForReport,
                bcvRate,
                paymentBreakdown,
                topProducts: todayTopProducts,
                todayTotalUsd,
                todayTotalBs,
                todayProfit,
                todayItemsSold,
            });
        }
        // 2. Resetear ventas del día
        const remaining = sales.filter(s => !s.timestamp?.startsWith(today));
        await storageService.setItem(SALES_KEY, remaining);
        setSales(remaining);
        setIsResetTodayOpen(false);
        showToast('Cierre de caja completado', 'success');
    };

    if (isLoading) {
        return (
            <div className="flex-1 p-3 sm:p-6 space-y-4">
                <div className="skeleton h-14 w-40" />
                <div className="grid grid-cols-3 gap-3">
                    <div className="skeleton h-20" />
                    <div className="skeleton h-20" />
                    <div className="skeleton h-20" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div className="skeleton h-32" />
                    <div className="skeleton h-32" />
                </div>
                <div className="skeleton h-48" />
                <div className="skeleton h-24" />
            </div>
        );
    }

    // Pull-to-refresh handlers
    const handleTouchStart = (e) => {
        if (scrollRef.current?.scrollTop === 0) {
            touchStartY.current = e.touches[0].clientY;
        }
    };
    const handleTouchMove = (e) => {
        if (scrollRef.current?.scrollTop > 0) return;
        const diff = e.touches[0].clientY - touchStartY.current;
        if (diff > 0) setPullDistance(Math.min(diff * 0.4, 80));
    };
    const handleTouchEnd = async () => {
        if (pullDistance > 60) {
            setIsRefreshing(true);
            const [savedSales, savedProducts, savedCustomers] = await Promise.all([
                storageService.getItem(SALES_KEY, []),
                storageService.getItem('my_products_v1', []),
                storageService.getItem('my_customers_v1', []),
            ]);
            setSales(savedSales);
            setProducts(savedProducts);
            setCustomers(savedCustomers);
            setIsRefreshing(false);
        }
        setPullDistance(0);
    };

    return (
        <div
            ref={scrollRef}
            className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 p-3 sm:p-6 overflow-y-auto scrollbar-hide"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Pull-to-refresh indicator */}
            {(pullDistance > 0 || isRefreshing) && (
                <div className="flex justify-center pb-3 transition-all" style={{ height: pullDistance > 0 ? pullDistance : 40 }}>
                    <div className={`w-6 h-6 rounded-full border-2 border-slate-300 dark:border-slate-700 border-t-emerald-500 ${isRefreshing || pullDistance > 60 ? 'animate-spin-slow' : ''}`}
                        style={{ opacity: Math.min(pullDistance / 60, 1), transform: `rotate(${pullDistance * 4}deg)` }}
                    />
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between mb-6 pt-2">
                <div className="relative h-14 sm:h-16">
                    <img src="/logo.png" alt="Logo Precios al Día" className={`h-14 sm:h-16 w-auto object-contain drop-shadow-md transition-opacity duration-200 ${theme === 'dark' ? 'opacity-0 absolute' : 'opacity-100'}`} />
                    <img src="/logodark.png" alt="Logo Precios al Día" className={`h-14 sm:h-16 w-auto object-contain drop-shadow-md transition-opacity duration-200 ${theme === 'dark' ? 'opacity-100' : 'opacity-0 absolute'}`} />
                </div>
                <button
                    onClick={() => { triggerHaptic(); toggleTheme(); }}
                    className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-90 transition-all"
                    title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
                >
                    {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                </button>
            </div>

            {/* Acciones Rápidas */}
            <div className="grid grid-cols-3 gap-3 mb-5">
                <button onClick={() => { if (onNavigate) { triggerHaptic(); onNavigate('ventas'); } }} className="bg-emerald-500 text-white rounded-2xl p-3 flex flex-col items-center justify-center gap-2 shadow-sm hover:scale-[1.02] active:scale-95 transition-all">
                    <ShoppingCart size={22} />
                    <span className="text-xs font-bold">Vender</span>
                </button>
                <button onClick={() => { if (onNavigate) { triggerHaptic(); onNavigate('catalogo'); } }} className="bg-indigo-500 text-white rounded-2xl p-3 flex flex-col items-center justify-center gap-2 shadow-sm hover:scale-[1.02] active:scale-95 transition-all">
                    <Store size={22} />
                    <span className="text-xs font-bold">Inventario</span>
                </button>
                <button onClick={() => { if (onNavigate) { triggerHaptic(); onNavigate('clientes'); } }} className="bg-blue-500 text-white rounded-2xl p-3 flex flex-col items-center justify-center gap-2 shadow-sm hover:scale-[1.02] active:scale-95 transition-all">
                    <Users size={22} />
                    <span className="text-xs font-bold">Clientes</span>
                </button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 gap-3 mb-5">
                {/* Ventas Hoy */}
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden">
                    <div className="absolute -right-4 -top-4 w-16 h-16 bg-emerald-50 dark:bg-emerald-900/10 rounded-full blur-2xl"></div>
                    <div className="flex items-center justify-between mb-3 relative z-10">
                        <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center shadow-inner">
                            <span className="text-emerald-600 dark:text-emerald-400 font-black text-xl">$</span>
                        </div>
                        <div className="flex items-center gap-2 relative z-10">
                            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-1 rounded-lg tracking-wider">HOY</span>
                            <button
                                onClick={handleDailyClose}
                                className="p-1 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                                title="Cierre de caja"
                            >
                                <FileText size={13} />
                            </button>
                        </div>
                    </div>
                    <div className="relative z-10">
                        <div className="flex items-baseline gap-1">
                            <span className="text-2xl font-black text-slate-800 dark:text-white tracking-tight">$<AnimatedCounter value={todayTotalUsd} /></span>
                        </div>
                        <p className="text-sm font-bold text-slate-400 dark:text-slate-500 mt-0.5">{formatBs(todayTotalBs)} Bs</p>
                        <p className="text-[11px] font-medium text-slate-400 mt-1">Ingresos brutos</p>
                    </div>
                </div>

                {/* Transacciones */}
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div className="flex items-center justify-between mb-2">
                        <div className="w-9 h-9 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center">
                            <ShoppingBag size={18} className="text-indigo-500" />
                        </div>
                    </div>
                    <p className="text-xl font-black text-slate-800 dark:text-white leading-none"><AnimatedCounter value={todaySales.length} /> <span className="text-xs font-bold text-slate-400">{todaySales.length === 1 ? 'venta' : 'ventas'}</span></p>
                    <p className="text-[11px] text-slate-400 mt-1"><AnimatedCounter value={todayItemsSold} /> {todayItemsSold === 1 ? 'artículo vendido' : 'artículos vendidos'}</p>
                </div>

                {/* Ganancia Estimada */}
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden">
                    <div className="absolute -right-4 -top-4 w-16 h-16 bg-green-50 dark:bg-green-900/10 rounded-full blur-2xl"></div>
                    <div className="flex items-center justify-between mb-3 relative z-10">
                        <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-xl flex items-center justify-center shadow-inner">
                            <TrendingUp size={20} className="text-green-600 dark:text-green-400" strokeWidth={2.5} />
                        </div>
                    </div>
                    <div className="relative z-10">
                        <div className="flex items-baseline gap-1">
                            <span className={`text-2xl font-black tracking-tight ${todayProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                {todayProfit >= 0 ? '+' : ''}${(todayProfit / bcvRate).toFixed(2)}
                            </span>
                        </div>
                        <p className="text-sm font-bold text-slate-400 dark:text-slate-500 mt-0.5">{formatBs(todayProfit)} Bs</p>
                        <p className="text-[11px] font-medium text-slate-400 mt-1">Ganancia estimada</p>
                    </div>
                </div>

                {/* Tasa BCV */}
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div className="flex items-center justify-between mb-2">
                        <div className="w-9 h-9 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center">
                            <ArrowUpRight size={18} className="text-blue-500" />
                        </div>
                    </div>
                    <p className="text-xl font-black text-slate-800 dark:text-white leading-none">{formatBs(bcvRate)} <span className="text-xs font-bold text-slate-400">Bs/$</span></p>
                    <p className="text-[11px] text-slate-400 mt-1">Tasa BCV actual</p>
                </div>
            </div>

            {/* Pago por Método */}
            {Object.keys(paymentBreakdown).length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm mb-5">
                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3">Pagos del día</h3>
                    <div className="space-y-2">
                        {Object.entries(paymentBreakdown).map(([method, data]) => {
                            const label = getPaymentLabel(method);
                            const PayIcon = PAYMENT_ICONS[method];
                            const totalBsEquiv = data.currency === 'USD' ? data.total * bcvRate : data.total;
                            const pct = todayTotalBs > 0 ? (totalBsEquiv / todayTotalBs * 100) : 0;
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
                                        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Gráfica semanal */}
            <SalesChart weekData={weekData} />

            {/* Bajo Stock */}
            {lowStockProducts.length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-amber-200 dark:border-amber-800/30 shadow-sm mb-5">
                    <h3 className="text-xs font-bold text-amber-500 uppercase mb-3 flex items-center gap-1">
                        <AlertTriangle size={12} /> Bajo Stock ({lowStockProducts.length})
                    </h3>
                    <div className="space-y-2">
                        {lowStockProducts.map(p => (
                            <div key={p.id} className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
                                    {p.image ? <img src={p.image} className="w-full h-full object-contain" /> : <Package size={14} className="text-slate-400" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{p.name}</p>
                                </div>
                                <span className={`text-xs font-black px-2 py-0.5 rounded-full ${(p.stock ?? 0) === 0 ? 'bg-red-100 text-red-600 dark:bg-red-900/20 dark:text-red-400' : 'bg-amber-100 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400'
                                    }`}>
                                    {p.stock ?? 0} {p.unit === 'kg' ? 'kg' : p.unit === 'litro' ? 'lt' : 'ud'}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Top Productos */}
            {topProducts.length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm mb-5">
                    <h3 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1">
                        <TrendingUp size={12} /> Más Vendidos
                    </h3>
                    <div className="space-y-2">
                        {topProducts.map((p, i) => (
                            <div key={p.name} className="flex items-center gap-3">
                                <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black ${i === 0 ? 'bg-amber-100 text-amber-600' : i === 1 ? 'bg-slate-200 text-slate-500' : 'bg-orange-50 text-orange-400'
                                    }`}>{i + 1}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{p.name}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs font-bold text-slate-600 dark:text-slate-300">{p.qty} vendidos</p>
                                    <p className="text-[10px] text-slate-400">{formatBs(p.revenue)} Bs</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <SalesHistory
                recentSales={recentSales}
                bcvRate={bcvRate}
                totalSalesCount={sales.length}
                onVoidSale={handleVoidSale}
                onShareWhatsApp={handleShareWhatsApp}
                onDownloadPDF={handleDownloadPDF}
                onOpenDeleteModal={() => setIsDeleteModalOpen(true)}
                onRequestClientForTicket={(sale) => {
                    triggerHaptic && triggerHaptic();
                    setTicketPendingSale(sale);
                }}
                onRecycleSale={(sale) => {
                    triggerHaptic && triggerHaptic();
                    localStorage.setItem('recycled_cart', JSON.stringify(sale.items));
                    if (onNavigate) onNavigate('ventas');
                }}
            />

            {/* Empty state */}
            {sales.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-300 dark:text-slate-700 py-10 space-y-3">
                    <BarChart3 size={64} strokeWidth={1} />
                    <p className="text-sm font-medium">Sin datos aún</p>
                    <p className="text-xs text-slate-400">Las estadísticas aparecerán cuando hagas tu primera venta</p>
                </div>
            )}

            {/* Modal Registrar Cliente para Ticket */}
            {ticketPendingSale && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200"
                    onClick={() => { setTicketPendingSale(null); setTicketClientName(''); setTicketClientPhone(''); }}
                >
                    <div
                        className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-5">
                            <div className="flex justify-center mb-4">
                                <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500 rounded-full flex items-center justify-center">
                                    <UserPlus size={28} />
                                </div>
                            </div>
                            <h3 className="text-lg font-black text-center text-slate-900 dark:text-white mb-1">
                                Registrar Cliente
                            </h3>
                            <p className="text-xs text-center text-slate-400 mb-5">
                                Para enviar el ticket, registra los datos del cliente.
                            </p>

                            <div className="space-y-3">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Nombre del Cliente *</label>
                                    <input
                                        type="text"
                                        value={ticketClientName}
                                        onChange={(e) => setTicketClientName(e.target.value)}
                                        placeholder="Ej: María García"
                                        autoFocus
                                        className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-medium text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1">
                                        <Phone size={10} /> Teléfono / WhatsApp
                                    </label>
                                    <input
                                        type="tel"
                                        value={ticketClientPhone}
                                        onChange={(e) => setTicketClientPhone(e.target.value)}
                                        placeholder="Ej: 0414-1234567"
                                        className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-medium text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex gap-3">
                            <button
                                onClick={() => { setTicketPendingSale(null); setTicketClientName(''); setTicketClientPhone(''); }}
                                className="flex-1 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white font-bold rounded-xl active:scale-[0.98] transition-all"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleRegisterClientForTicket}
                                disabled={!ticketClientName.trim()}
                                className="flex-1 py-3 bg-emerald-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 hover:bg-emerald-600 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex justify-center items-center gap-2 shadow-md shadow-emerald-500/20"
                            >
                                <Send size={16} /> Registrar y Enviar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de Confirmación Borrado Historial */}
            {isDeleteModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-4 flex flex-col items-center text-center">
                            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/40 text-red-500 rounded-full flex items-center justify-center mb-4">
                                <Trash2 size={32} />
                            </div>
                            <h3 className="text-xl font-black text-slate-800 dark:text-white mb-2">¿Estás absolutamente seguro?</h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 px-2">
                                Esta acción borrará permanentemente <strong className="text-red-500">TODO el historial de ventas</strong>. (No afectará tu inventario de productos).
                            </p>
                            <div className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
                                <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wide">Escribe "BORRAR" para confirmar:</p>
                                <input
                                    type="text"
                                    value={deleteConfirmText}
                                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                                    placeholder="BORRAR"
                                    className="w-full form-input bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-3 text-center font-black text-red-500 uppercase tracking-widest focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                                />
                            </div>
                        </div>
                        <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex gap-3">
                            <button
                                onClick={() => { setIsDeleteModalOpen(false); setDeleteConfirmText(''); }}
                                className="flex-1 py-3.5 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white font-bold rounded-xl active:scale-[0.98] transition-all"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={() => {
                                    if (deleteConfirmText.trim().toUpperCase() === 'BORRAR') {
                                        setSales([]);
                                        storageService.removeItem('my_sales_v1');
                                        setIsDeleteModalOpen(false);
                                        setDeleteConfirmText('');
                                    }
                                }}
                                disabled={deleteConfirmText.trim().toUpperCase() !== 'BORRAR'}
                                className="flex-1 py-3.5 bg-red-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex justify-center items-center gap-2"
                            >
                                <Trash2 size={18} /> Borrar Historial
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Modal: ¿Reciclar Venta? */}
            {recycleOffer && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200"
                    onClick={() => setRecycleOffer(null)}
                >
                    <div
                        className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl shadow-xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-5 text-center">
                            <div className="flex justify-center mb-4">
                                <div className="w-14 h-14 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-500 rounded-full flex items-center justify-center">
                                    <Recycle size={28} />
                                </div>
                            </div>
                            <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1">
                                Venta Anulada
                            </h3>
                            <p className="text-xs text-slate-400 mb-2">
                                ¿Quieres reciclar los productos de esta venta y enviarlos a la caja?
                            </p>
                            <div className="text-left bg-slate-50 dark:bg-slate-800 rounded-xl p-3 mt-3 space-y-1">
                                {recycleOffer.items?.slice(0, 5).map((item, i) => (
                                    <div key={i} className="flex justify-between text-xs">
                                        <span className="text-slate-600 dark:text-slate-300 font-medium">{item.qty}{item.isWeight ? 'kg' : 'u'} {item.name.length > 20 ? item.name.substring(0, 20) + '…' : item.name}</span>
                                        <span className="text-slate-400 font-bold">${(item.priceUsd * item.qty).toFixed(2)}</span>
                                    </div>
                                ))}
                                {recycleOffer.items?.length > 5 && (
                                    <p className="text-[10px] text-slate-400 text-center">+{recycleOffer.items.length - 5} más...</p>
                                )}
                            </div>
                        </div>
                        <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex gap-3">
                            <button
                                onClick={() => setRecycleOffer(null)}
                                className="flex-1 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white font-bold rounded-xl active:scale-[0.98] transition-all"
                            >
                                No, gracias
                            </button>
                            <button
                                onClick={() => {
                                    // Guardar items reciclados en localStorage como señal
                                    localStorage.setItem('recycled_cart', JSON.stringify(recycleOffer.items));
                                    setRecycleOffer(null);
                                    if (onNavigate) onNavigate('ventas');
                                }}
                                className="flex-1 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex justify-center items-center gap-2 shadow-md shadow-indigo-500/20"
                            >
                                <Recycle size={16} /> Reciclar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal Confirmación: Anular Venta */}
            <ConfirmModal
                isOpen={!!voidSaleTarget}
                onClose={() => setVoidSaleTarget(null)}
                onConfirm={confirmVoidSale}
                title={`Anular venta #${voidSaleTarget?.id?.substring(0, 6).toUpperCase() || ''}`}
                message={`Esta acción:\n• Marcará la venta como ANULADA\n• Devolverá el stock a la bodega\n• Revertirá deudas o saldos a favor\n\nEsta acción no se puede deshacer.`}
                confirmText="Sí, anular"
                variant="danger"
            />
            <ConfirmModal
                isOpen={isResetTodayOpen}
                onClose={() => setIsResetTodayOpen(false)}
                onConfirm={handleResetToday}
                title="Cierre de Caja"
                message="Se generará un PDF con el reporte del día y se borrarán las ventas de hoy.\n\nEsta acción no se puede deshacer."
                confirmText="Cerrar Caja"
                confirmClassName="bg-indigo-500 hover:bg-indigo-600 text-white"
            />
        </div>
    );
}

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RefreshCw, Search, ShoppingCart, Mic, Package, X, Home, LayoutGrid, Users, BarChart3 } from 'lucide-react';
import { storageService } from '../utils/storageService';
import { showToast } from '../components/Toast';
import { formatBs, formatVzlaPhone } from '../utils/calculatorUtils';
import { getActivePaymentMethods } from '../config/paymentMethods';
import { BODEGA_CATEGORIES, CATEGORY_ICONS, CATEGORY_COLORS } from '../config/categories';
import { useVoiceSearch } from '../hooks/useVoiceSearch';
import { useSounds } from '../hooks/useSounds';
import { useNotifications } from '../hooks/useNotifications';
import CartPanel from '../components/Sales/CartPanel';
import ConfirmModal from '../components/ConfirmModal';
import ReceiptModal from '../components/Sales/ReceiptModal';
import CheckoutModal from '../components/Sales/CheckoutModal';
import Confetti from '../components/Confetti';

const SALES_KEY = 'bodega_sales_v1';

export default function SalesView({ rates, triggerHaptic, onNavigate }) {
    const { playAdd, playRemove, playCheckout, playError } = useSounds();
    const { notifySaleComplete, notifyLowStock } = useNotifications();
    const [products, setProducts] = useState([]);
    const [showClearCartConfirm, setShowClearCartConfirm] = useState(false);
    const [showConfetti, setShowConfetti] = useState(false);
    const [customers, setCustomers] = useState([]);
    const [selectedCustomerId, setSelectedCustomerId] = useState('');
    const [cart, setCart] = useState(() => {
        try {
            const saved = localStorage.getItem('pending_cart');
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });
    const [searchTerm, setSearchTerm] = useState('');
    const [showCheckout, setShowCheckout] = useState(false);
    const [showReceipt, setShowReceipt] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [showRateConfig, setShowRateConfig] = useState(false);
    const [hierarchyPending, setHierarchyPending] = useState(null);
    const [weightPending, setWeightPending] = useState(null);
    const [paymentMethods, setPaymentMethods] = useState([]);
    const [selectedCategory, setSelectedCategory] = useState('todos');

    // Búsqueda y Navegación
    const searchInputRef = useRef(null);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const handleSetSearchTerm = (text) => {
        setSearchTerm(text);
        setSelectedIndex(0);
    };

    // Audio / Voice Search (Groq Whisper)
    const { isRecording, isProcessingAudio, toggleRecording } = useVoiceSearch({
        onResult: (text) => { handleSetSearchTerm(text); searchInputRef.current?.focus(); },
        triggerHaptic,
    });

    // ── Tasa BCV (automática o manual) ──
    const [useAutoRate, setUseAutoRate] = useState(() => {
        const saved = localStorage.getItem('bodega_use_auto_rate');
        return saved !== null ? JSON.parse(saved) : true;
    });
    const [customRate, setCustomRate] = useState(() => {
        const saved = localStorage.getItem('bodega_custom_rate');
        return saved && parseFloat(saved) > 0 ? saved : '';
    });

    const bcvRate = rates.bcv?.price || 0;
    const effectiveRate = useAutoRate ? bcvRate : (parseFloat(customRate) > 0 ? parseFloat(customRate) : bcvRate);

    // Persist rate config
    useEffect(() => {
        localStorage.setItem('bodega_use_auto_rate', JSON.stringify(useAutoRate));
        localStorage.setItem('bodega_custom_rate', customRate.toString());
    }, [useAutoRate, customRate]);

    // Persist cart to localStorage
    useEffect(() => {
        if (cart.length > 0) {
            localStorage.setItem('pending_cart', JSON.stringify(cart));
        } else {
            localStorage.removeItem('pending_cart');
        }
    }, [cart]);

    // Load products and customers from IndexedDB
    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const [saved, savedCustomers, methods] = await Promise.all([
                storageService.getItem('my_products_v1', []),
                storageService.getItem('my_customers_v1', []),
                getActivePaymentMethods()
            ]);
            if (mounted) {
                setProducts(saved);
                setCustomers(savedCustomers);
                setPaymentMethods(methods);
                setIsLoading(false);

                // Comprobar si hay una venta reciclada esperando
                const recycled = localStorage.getItem('recycled_cart');
                if (recycled) {
                    try {
                        const items = JSON.parse(recycled);
                        if (Array.isArray(items) && items.length > 0) {
                            setCart(items.map(item => ({
                                id: item.id,
                                name: item.name,
                                qty: item.qty,
                                priceUsd: item.priceUsd,
                                costBs: item.costBs || 0,
                                isWeight: item.isWeight || false,
                            })));
                        }
                    } catch (_) { /* ignore parse errors */ }
                    localStorage.removeItem('recycled_cart');
                }
            }
        };
        load();
        return () => { mounted = false; };
    }, []);

    // Regresar el foco al input
    useEffect(() => {
        if (!isLoading && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [isLoading]);

    // Refresh products (when coming back from catalog)
    useEffect(() => {
        const handleFocus = async () => {
            const saved = await storageService.getItem('my_products_v1', []);
            setProducts(saved);
        };
        window.addEventListener('focus', handleFocus);
        return () => window.removeEventListener('focus', handleFocus);
    }, []);



    // Search results (memoized)
    const searchResults = useMemo(() => searchTerm.length >= 1
        ? products.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.barcode?.includes(searchTerm)).slice(0, 6)
        : [],
        [searchTerm, products]
    );

    // Productos filtrados por categoría (memoized)
    const filteredByCategory = useMemo(() => selectedCategory === 'todos'
        ? products
        : products.filter(p => p.category === selectedCategory),
        [selectedCategory, products]
    );

    // Cart calculations — Todo en $ BCV y Bs
    const cartTotalUsd = cart.reduce((sum, item) => sum + (item.priceUsd * item.qty), 0);
    const cartTotalBs = cartTotalUsd * effectiveRate;
    const cartItemCount = cart.reduce((sum, item) => sum + item.qty, 0);

    // Add to cart — Convierte priceUsdt a $ BCV para uniformidad
    const addToCart = useCallback((product, qtyOverride = null, forceMode = null) => {
        triggerHaptic && triggerHaptic();
        playAdd();

        // Si el producto tiene jerarquía y no se ha elegido modo, mostrar popup
        if (product.sellByUnit && product.unitPriceUsd && !forceMode && !qtyOverride) {
            setHierarchyPending(product);
            return;
        }

        // Si el producto es por peso/volumen y no tiene cantidad, mostrar popup de pesaje
        if ((product.unit === 'kg' || product.unit === 'litro') && !qtyOverride) {
            setWeightPending(product);
            return;
        }

        const usdtRate = effectiveRate;
        let priceToUse = product.priceUsdt;
        let cartId = product.id;
        let cartName = product.name;
        let qtyToAdd = qtyOverride || 1;

        // Si se elige unidad suelta, usar precio unitario
        if (forceMode === 'unit') {
            priceToUse = product.unitPriceUsd;
            cartId = product.id + '_unit';
            cartName = product.name + ' (Ud.)';
        }

        const priceInBcvUsd = (priceToUse * usdtRate) / effectiveRate;

        setCart(prev => {
            const existing = prev.find(i => i.id === cartId);
            if (existing && !qtyOverride) {
                return prev.map(i => i.id === cartId ? { ...i, qty: i.qty + 1 } : i);
            }
            if (existing && qtyOverride) {
                return prev.map(i => i.id === cartId ? { ...i, qty: i.qty + qtyOverride } : i);
            }
            return [...prev, {
                ...product,
                id: cartId,
                name: cartName,
                priceUsd: priceInBcvUsd,
                costBs: forceMode === 'unit'
                    ? (product.costBs || 0) / (product.unitsPerPackage || 1)
                    : (product.costBs || 0),
                qty: qtyToAdd,
                isWeight: !!qtyOverride,
                _originalId: product.id, // Para descontar stock correctamente
                _mode: forceMode || 'package',
                _unitsPerPackage: product.unitsPerPackage || 1,
            }];
        });
        handleSetSearchTerm('');
        setHierarchyPending(null);
        searchInputRef.current?.focus();
    }, [triggerHaptic, effectiveRate]);

    // Eventos del Input para teclado interactivo y Escáner
    const handleSearchKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();

            // Lógica de Balanza y Escáner Continuo (Prefijo 21)
            // Ejemplo peso: 2100012003504 (PLU 12, PESA 0.350kg)
            if (searchTerm.startsWith('21') && searchTerm.length >= 13) {
                const pluCode = parseInt(searchTerm.substring(2, 7), 10).toString(); // Quitar ceros a la izquierda
                const weightRaw = searchTerm.substring(7, 12); // 5 dígitos de peso en gramos
                const weightKg = parseInt(weightRaw, 10) / 1000;
                // Busca por ID simulando el PLU o por Barcode
                const p = products.find(p => p.id === pluCode || p.barcode?.includes(pluCode) || p.barcode?.includes(searchTerm.substring(0, 7)));
                if (p) {
                    addToCart({ ...p, isWeight: true }, weightKg);
                    handleSetSearchTerm('');
                    return;
                }
            }

            // Seleccion normal por lista
            if (searchResults[selectedIndex]) {
                addToCart(searchResults[selectedIndex]);
            } else if (searchResults.length === 1) {
                addToCart(searchResults[0]);
            } else if (searchTerm.length >= 3 && searchResults.length === 0) {
                // Si fue escáner pero no encontró con '21', buscar coincidencia exacta
                const exactMatch = products.find(p => p.barcode === searchTerm);
                if (exactMatch) {
                    addToCart(exactMatch);
                }
            }
        }
    };

    const updateQty = (id, delta) => {
        triggerHaptic && triggerHaptic();
        if (delta < 0) playRemove();
        setCart(prev => prev.map(i => {
            if (i.id !== id) return i;
            // Permitir decimales en el cambio de cantidad si isWeight es true? 
            let newQty = i.qty + delta;
            if (newQty < 0) newQty = 0;
            // Redondear a 3 decimales para evitar problemas
            newQty = Math.round(newQty * 1000) / 1000;
            return newQty === 0 ? null : { ...i, qty: newQty };
        }).filter(Boolean));
        searchInputRef.current?.focus();
    };

    const removeFromCart = (id) => {
        triggerHaptic && triggerHaptic();
        playRemove();
        setCart(prev => prev.filter(i => i.id !== id));
        searchInputRef.current?.focus();
    };

    // Global Keybinds
    useEffect(() => {
        const handleGlobalKeyMap = (e) => {
            if (e.key === 'F9') {
                e.preventDefault();
                if (cart.length > 0 && !showCheckout && !showReceipt) setShowCheckout(true);
            }
            if (e.key === 'Escape') {
                if (showCheckout) {
                    setShowCheckout(false);
                    setSelectedCustomerId('');
                }
                if (showReceipt) {
                    setShowReceipt(null);
                    setSelectedCustomerId('');
                }
            }
        };
        window.addEventListener('keydown', handleGlobalKeyMap);
        return () => window.removeEventListener('keydown', handleGlobalKeyMap);
    }, [cart, showCheckout, showReceipt]);

    // Al cerrar checkout/receipt, devolver foco
    useEffect(() => {
        if (!showCheckout && !showReceipt && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [showCheckout, showReceipt]);

    // Saldo a Favor handler — ahora será invocado desde el modal
    // TODO: saldo a favor se maneja de forma simplificada
    const handleUseSaldoFavor = () => {
        // El modal maneja esto internamente ahora
    };

    // Checkout Final
    const handleCheckout = async (payments) => {
        triggerHaptic && triggerHaptic();

        const selectedCustomer = customers.find(c => c.id === selectedCustomerId);

        if (cart.length === 0) return;

        // Recalcular totales desde payments recibidos
        const totalPaidUsd = payments.reduce((acc, p) => acc + p.amountUsd, 0);
        const remainingUsd = Math.max(0, cartTotalUsd - totalPaidUsd);
        const changeUsd = Math.max(0, totalPaidUsd - cartTotalUsd);
        const changeBs = changeUsd * effectiveRate;

        if (!selectedCustomer && remainingUsd > 0.01) return;

        // Auditoría de datos
        if (isNaN(cartTotalUsd) || cartTotalUsd < 0 || isNaN(totalPaidUsd) || totalPaidUsd < 0) {
            console.error('Abortando venta. Integridad matemática comprometida.');
            showToast('Error de integridad de datos. Revisa los montos.', 'error');
            playError();
            return;
        }

        const fiadoAmountUsd = remainingUsd > 0.01 ? remainingUsd : 0;

        const sale = {
            id: crypto.randomUUID(),
            tipo: fiadoAmountUsd > 0 ? 'VENTA_FIADA' : 'VENTA',
            status: 'COMPLETADA',
            items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, priceUsd: i.priceUsd, costBs: i.costBs || 0, isWeight: i.isWeight })),
            totalUsd: cartTotalUsd,
            totalBs: cartTotalBs,
            payments,
            rate: effectiveRate,
            rateSource: useAutoRate ? 'BCV Auto' : 'Manual',
            timestamp: new Date().toISOString(),
            changeUsd: fiadoAmountUsd > 0 ? 0 : changeUsd,
            changeBs: fiadoAmountUsd > 0 ? 0 : changeBs,
            customerId: selectedCustomerId || null,
            customerName: selectedCustomer ? selectedCustomer.name : 'Consumidor Final',
            customerPhone: selectedCustomer?.phone || null,
            fiadoUsd: fiadoAmountUsd
        };

        // Save sale — sequential correlative
        const existingSales = await storageService.getItem(SALES_KEY, []);
        const maxNumber = existingSales.reduce((mx, s) => Math.max(mx, s.saleNumber || 0), 0);
        sale.saleNumber = maxNumber + 1;
        await storageService.setItem(SALES_KEY, [sale, ...existingSales]);

        // Deduct stock
        const updatedProducts = products.map(p => {
            const cartItem = cart.find(i => i.id === p.id);
            if (cartItem) return { ...p, stock: Math.max(0, (p.stock ?? 0) - cartItem.qty) };
            return p;
        });
        setProducts(updatedProducts);
        await storageService.setItem('my_products_v1', updatedProducts);

        // Update Customer Balance if needed
        const amount_favor_used = payments.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + p.amountUsd, 0);
        const debtIncurred = fiadoAmountUsd + amount_favor_used;

        if (selectedCustomer && debtIncurred > 0) {
            const updatedCustomers = customers.map(c => {
                if (c.id === selectedCustomer.id) {
                    return { ...c, deuda: c.deuda + debtIncurred };
                }
                return c;
            });
            setCustomers(updatedCustomers);
            await storageService.setItem('my_customers_v1', updatedCustomers);
        }

        setShowReceipt(sale);
        playCheckout();
        setShowConfetti(true);
        notifySaleComplete(sale.saleNumber, sale.totalUsd, sale.totalBs);
        notifyLowStock(updatedProducts);
        setCart([]);
        setShowCheckout(false);
        setSelectedCustomerId('');
    };

    // Crear cliente inline desde checkout
    const handleCreateCustomer = async (name, phone) => {
        const newCustomer = {
            id: crypto.randomUUID(),
            name,
            phone: phone || '',
            deuda: 0,
            favor: 0,
            createdAt: new Date().toISOString(),
        };
        const updated = [...customers, newCustomer];
        setCustomers(updated);
        await storageService.setItem('my_customers_v1', updated);
        return newCustomer;
    };

    if (isLoading) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center">
                <div className="w-8 h-8 rounded-full border-4 border-slate-200 dark:border-slate-800 border-t-emerald-500 animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-950 p-2 sm:p-4 pb-14 sm:pb-4 overflow-hidden relative">

            {/* Header Rediseñado - Mobile First */}
            <div className="shrink-0 mb-3 bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl p-3 sm:p-4 shadow-sm border border-slate-100 dark:border-slate-800">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-3">
                    <div className="flex justify-between items-center">
                        <h2 className="text-xl sm:text-2xl font-black text-slate-800 dark:text-white tracking-tight flex items-center gap-2">
                            <div className="bg-emerald-500 text-white p-1.5 sm:p-2 rounded-xl shadow-lg shadow-emerald-500/30">
                                <ShoppingCart size={20} className="sm:w-[22px] sm:h-[22px]" />
                            </div>
                            Punto de Venta
                        </h2>
                        {/* Tasa Móvil (visible solo en sm) */}
                        <div className="sm:hidden">
                            <button onClick={() => setShowRateConfig(!showRateConfig)} className="flex items-center gap-1 bg-slate-50 dark:bg-slate-800 px-2 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700">
                                <RefreshCw size={12} className={showRateConfig ? "text-emerald-500" : "text-slate-400"} />
                                <strong className="text-xs text-emerald-600 dark:text-emerald-400">{formatBs(effectiveRate)}</strong>
                            </button>
                        </div>
                    </div>

                    {/* Tasa Desktop (oculto en sm) */}
                    <div className="hidden sm:flex items-center gap-2">
                        <button onClick={() => setShowRateConfig(!showRateConfig)} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-500 transition-colors group">
                            <span className="text-xs text-slate-500 dark:text-slate-400 font-bold flex items-center gap-1">
                                <RefreshCw size={12} className={showRateConfig ? "text-emerald-500" : "group-hover:text-emerald-500"} />
                                BCV:
                            </span>
                            <strong className="text-sm text-emerald-600 dark:text-emerald-400">{formatBs(effectiveRate)} Bs</strong>
                            {!useAutoRate && <span className="text-[10px] bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-1 rounded-md font-bold">MAN</span>}
                        </button>
                    </div>
                </div>

                {/* Rate Config Panel */}
                {showRateConfig && (
                    <div className="bg-slate-50 dark:bg-slate-950 rounded-xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 p-3 mb-3 animate-in fade-in slide-in-from-top-2">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-slate-500">Tasa de Cambio</span>
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-bold text-slate-400">
                                    {useAutoRate ? <span className="text-emerald-500">Auto Dólar BCV</span> : <span>Manual</span>}
                                </span>
                                <button onClick={() => { triggerHaptic && triggerHaptic(); setUseAutoRate(!useAutoRate); }}
                                    className={`relative w-10 h-6 rounded-full transition-colors ${useAutoRate ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}>
                                    <span className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${useAutoRate ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                        </div>
                        {!useAutoRate && (
                            <input type="number" value={customRate} onChange={e => setCustomRate(e.target.value)}
                                className="w-full p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold text-indigo-600 dark:text-indigo-400 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                                placeholder="Ingresa Tasa Manual (Bs por $)" autoFocus />
                        )}
                    </div>
                )}

                {/* Search Input Mejorado */}
                <div className="relative">
                    <Search size={20} className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        value={searchTerm}
                        onChange={e => handleSetSearchTerm(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        placeholder="Buscar producto..."
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl sm:rounded-2xl py-3 pl-10 sm:pl-12 pr-14 sm:pr-20 text-slate-800 dark:text-white font-medium outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-inner text-sm sm:text-base transition-all" />

                    <div className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 flex items-center pr-1 gap-0.5">
                        {searchTerm && (
                            <button onClick={() => { handleSetSearchTerm(''); searchInputRef.current?.focus(); }} className="text-slate-400 hover:text-slate-600 p-1.5 transition-colors">
                                <X size={18} />
                            </button>
                        )}

                        <button
                            onClick={(e) => { e.preventDefault(); toggleRecording(); }}
                            className={`p-1.5 rounded-full transition-all flex items-center justify-center ${isRecording
                                ? 'bg-red-100 text-red-500 shadow-inner animate-pulse'
                                : isProcessingAudio
                                    ? 'bg-amber-100 text-amber-500'
                                    : 'text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/30'
                                }`}
                            title={isRecording ? "Detener grabación" : "Búsqueda por voz"}
                        >
                            {isProcessingAudio ? (
                                <div className="w-[18px] h-[18px] border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                            ) : (
                                <Mic size={18} className={isRecording ? 'animate-bounce' : ''} />
                            )}
                        </button>
                    </div>

                    {/* Search Dropdown Mejorado con Indexado Visual */}
                    {searchResults.length > 0 && (
                        <div className="absolute top-full mt-2 left-0 right-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-20 overflow-hidden">
                            {searchResults.map((p, index) => {
                                const isLowStock = (p.stock ?? 0) <= (p.lowStockAlert ?? 5) && (p.stock ?? 0) >= 0;
                                const isOutOfStock = (p.stock ?? 0) === 0;
                                const catInfo = BODEGA_CATEGORIES.find(c => c.id === p.category);
                                const catColor = catInfo ? CATEGORY_COLORS[catInfo.color] : null;
                                const CatIcon = catInfo ? CATEGORY_ICONS[catInfo.id] : null;
                                const isSelected = index === selectedIndex;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => addToCart(p)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 border-b border-slate-50 dark:border-slate-800/50 last:border-0 transition-all active:scale-[0.98]
                                            ${isSelected
                                                ? 'bg-emerald-50 dark:bg-emerald-900/20 border-l-4 border-l-emerald-500'
                                                : 'bg-transparent border-l-4 border-l-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50'
                                            }
                                            ${isOutOfStock ? 'opacity-50' : ''}`}
                                    >
                                        <div className="w-10 h-10 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
                                            {p.image
                                                ? <img src={p.image} className="w-full h-full object-contain" alt={p.name} />
                                                : CatIcon
                                                    ? <CatIcon size={20} className="text-slate-400" />
                                                    : <Package size={16} className="text-slate-400" />
                                            }
                                        </div>
                                        <div className="flex-1 min-w-0 text-left">
                                            <p className={`text-sm font-bold truncate leading-tight ${isSelected ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-100'}`}>
                                                {p.name}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                {catInfo && catInfo.id !== 'otros' && catInfo.id !== 'todos' && catColor && (
                                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${catColor}`}>
                                                        {catInfo.label}
                                                    </span>
                                                )}
                                                <span className={`text-[10px] font-medium flex items-center gap-1
                                                    ${isOutOfStock ? 'text-red-500' : isLowStock ? 'text-amber-500' : 'text-slate-400'}`}>
                                                    {isLowStock && !isOutOfStock && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />}
                                                    {isOutOfStock ? 'Sin stock' : `Stock: ${p.stock ?? 0}`}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                                                ${p.priceUsdt?.toFixed(2)}
                                            </p>
                                            <p className="text-[10px] font-medium text-slate-400">
                                                {formatBs(p.priceUsdt * effectiveRate)} Bs
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                            <div className="bg-slate-50 dark:bg-slate-950 p-2 text-center border-t border-slate-100 dark:border-slate-800">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center justify-center gap-2">
                                    Navega con flechas <span className="px-1 bg-slate-200 dark:bg-slate-800 rounded">↓</span><span className="px-1 bg-slate-200 dark:bg-slate-800 rounded">↑</span> y presiona <span className="px-1 bg-slate-200 dark:bg-slate-800 rounded">ENTER ↵</span>
                                </span>
                            </div>
                        </div>
                    )}

                    {/* ─── POPUP JERARQUÍA LITE: Paquete o Unidad ─── */}
                    {hierarchyPending && (
                        <div className="absolute top-full mt-2 left-0 right-0 z-30 bg-white dark:bg-slate-900 border-2 border-indigo-200 dark:border-indigo-800 rounded-2xl shadow-2xl shadow-indigo-500/10 overflow-hidden">
                            <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 border-b border-indigo-100 dark:border-indigo-800">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-xs font-black text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">¿Cómo lo vendes?</p>
                                        <p className="text-[11px] text-indigo-500/70 dark:text-indigo-400/50 font-medium mt-0.5">{hierarchyPending.name}</p>
                                    </div>
                                    <button onClick={() => setHierarchyPending(null)} className="p-1 text-indigo-400 hover:text-indigo-600"><X size={16} /></button>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 p-3">
                                <button onClick={() => addToCart(hierarchyPending, null, 'package')}
                                    className="flex flex-col items-center gap-2 p-4 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border-2 border-indigo-200 dark:border-indigo-800 hover:border-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-all active:scale-95">
                                    <Package size={24} className="text-indigo-600 dark:text-indigo-400" />
                                    <span className="text-xs font-black text-indigo-700 dark:text-indigo-300 uppercase">Caja/Bulto</span>
                                    <span className="text-sm font-black text-indigo-600 dark:text-indigo-400">${hierarchyPending.priceUsdt?.toFixed(2)}</span>
                                    <span className="text-[9px] text-slate-400 font-bold">{hierarchyPending.unitsPerPackage} uds</span>
                                </button>
                                <button onClick={() => addToCart(hierarchyPending, null, 'unit')}
                                    className="flex flex-col items-center gap-2 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-200 dark:border-emerald-800 hover:border-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-all active:scale-95">
                                    <Box size={24} className="text-emerald-600 dark:text-emerald-400" />
                                    <span className="text-xs font-black text-emerald-700 dark:text-emerald-300 uppercase">Unidad</span>
                                    <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">${hierarchyPending.unitPriceUsd?.toFixed(2)}</span>
                                    <span className="text-[9px] text-slate-400 font-bold">1 ud</span>
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ─── POPUP PESAJE: Kg / Litro ─── */}
                    {weightPending && (
                        <div className="absolute top-full mt-2 left-0 right-0 z-30 bg-white dark:bg-slate-900 border-2 border-amber-200 dark:border-amber-800 rounded-2xl shadow-2xl shadow-amber-500/10 overflow-hidden">
                            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-xs font-black text-amber-700 dark:text-amber-300 uppercase tracking-wider">
                                            ¿Cuántos {weightPending.unit === 'kg' ? 'kilos' : 'litros'}?
                                        </p>
                                        <p className="text-[11px] text-amber-500/70 dark:text-amber-400/50 font-medium mt-0.5">{weightPending.name} · ${weightPending.priceUsdt?.toFixed(2)}/{weightPending.unit === 'kg' ? 'kg' : 'lt'}</p>
                                    </div>
                                    <button onClick={() => setWeightPending(null)} className="p-1 text-amber-400 hover:text-amber-600"><X size={16} /></button>
                                </div>
                            </div>
                            <div className="p-3 space-y-3">
                                {/* Botones rápidos */}
                                <div className="grid grid-cols-4 gap-2">
                                    {[0.25, 0.5, 1, 2].map(q => (
                                        <button key={q} onClick={() => { addToCart(weightPending, q); setWeightPending(null); }}
                                            className="py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm font-black text-amber-700 dark:text-amber-300 hover:bg-amber-100 active:scale-95 transition-all">
                                            {q} {weightPending.unit === 'kg' ? 'kg' : 'lt'}
                                        </button>
                                    ))}
                                </div>
                                {/* Input manual */}
                                <div className="flex gap-2">
                                    <input type="number" step="0.01" min="0.01" placeholder="Cantidad exacta..."
                                        id="weight-input"
                                        className="flex-1 bg-amber-50 dark:bg-slate-800 border border-amber-200 dark:border-amber-700 p-3 rounded-xl font-bold text-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-amber-500/50 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const val = parseFloat(e.target.value);
                                                if (val > 0) { addToCart(weightPending, val); setWeightPending(null); }
                                            }
                                        }} />
                                    <button onClick={() => {
                                        const input = document.getElementById('weight-input');
                                        const val = parseFloat(input?.value);
                                        if (val > 0) { addToCart(weightPending, val); setWeightPending(null); }
                                    }} className="px-4 py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-black text-sm active:scale-95 transition-all">
                                        Agregar
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Category Chips + Product Grid (browse mode) */}
            {!showCheckout && !showReceipt && (
                <div className={`${selectedCategory !== 'todos' && searchTerm.length === 0 ? 'flex-1 overflow-hidden flex flex-col min-h-0' : ''}`}>
                    {/* Category Chips */}
                    <div className="shrink-0 flex gap-1.5 overflow-x-auto pb-2 pt-1 px-1 scrollbar-hide">
                        {BODEGA_CATEGORIES.map(cat => {
                            const isActive = selectedCategory === cat.id;
                            const CatIcon = CATEGORY_ICONS[cat.id];
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => { triggerHaptic && triggerHaptic(); setSelectedCategory(isActive && cat.id !== 'todos' ? 'todos' : cat.id); }}
                                    className={`shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all active:scale-95 ${isActive
                                        ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20'
                                        : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:border-emerald-300'
                                        }`}
                                >
                                    {CatIcon && <CatIcon size={12} />}
                                    {cat.label}
                                </button>
                            );
                        })}
                    </div>

                    {/* Product Grid — solo cuando se filtra por categoría específica */}
                    {selectedCategory !== 'todos' && searchTerm.length === 0 && (
                        <div className="flex-1 overflow-y-auto min-h-0 pb-2">
                            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                                {filteredByCategory.map(p => {
                                    const isOut = (p.stock ?? 0) === 0;
                                    const CatIcon = CATEGORY_ICONS[p.category] || Package;
                                    return (
                                        <button
                                            key={p.id}
                                            onClick={() => addToCart(p)}
                                            disabled={isOut}
                                            className={`bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl p-2 flex flex-col items-center text-center transition-all active:scale-95 hover:border-emerald-300 hover:shadow-sm ${isOut ? 'opacity-40 cursor-not-allowed' : ''
                                                }`}
                                        >
                                            <div className="w-10 h-10 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center mb-1.5 overflow-hidden">
                                                {p.image
                                                    ? <img src={p.image} className="w-full h-full object-contain" alt={p.name} />
                                                    : <CatIcon size={18} className="text-slate-400" />
                                                }
                                            </div>
                                            <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-tight line-clamp-2 mb-1">{p.name}</p>
                                            <p className="text-[11px] font-black text-emerald-600 dark:text-emerald-400">${p.priceUsdt?.toFixed(2)}</p>
                                            <p className="text-[9px] text-slate-400 font-medium">{isOut ? 'Agotado' : `${p.stock ?? 0} disp.`}</p>
                                        </button>
                                    );
                                })}
                            </div>
                            {filteredByCategory.length === 0 && (
                                <div className="text-center py-10">
                                    <Package size={32} className="mx-auto text-slate-300 dark:text-slate-700 mb-2" />
                                    <p className="text-xs text-slate-400 font-medium">Sin productos en esta categoría</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Cart Container */}
            <CartPanel
                cart={cart}
                effectiveRate={effectiveRate}
                cartTotalUsd={cartTotalUsd}
                cartTotalBs={cartTotalBs}
                cartItemCount={cartItemCount}
                updateQty={updateQty}
                removeFromCart={removeFromCart}
                onCheckout={() => { triggerHaptic && triggerHaptic(); setShowCheckout(true); }}
                onClearCart={() => {
                    triggerHaptic && triggerHaptic();
                    setShowClearCartConfirm(true);
                }}
                triggerHaptic={triggerHaptic}
            />

            {/* ZONA DE COBRO */}
            {showCheckout && (
                <CheckoutModal
                    onClose={() => {
                        setShowCheckout(false);
                        setSelectedCustomerId('');
                    }}
                    cartTotalUsd={cartTotalUsd}
                    cartTotalBs={cartTotalBs}
                    effectiveRate={effectiveRate}
                    customers={customers}
                    selectedCustomerId={selectedCustomerId}
                    setSelectedCustomerId={setSelectedCustomerId}
                    paymentMethods={paymentMethods}
                    onConfirmSale={handleCheckout}
                    onUseSaldoFavor={handleUseSaldoFavor}
                    onCreateCustomer={handleCreateCustomer}
                    triggerHaptic={triggerHaptic}
                />
            )}

            {/* ZONA DE TICKETS */}
            <ReceiptModal
                receipt={showReceipt}
                onClose={() => { setShowReceipt(null); setSelectedCustomerId(''); }}
                onShareWhatsApp={(r) => {
                    const fecha = new Date(r.timestamp).toLocaleDateString('es-VE', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit'
                    });
                    const saleNum = r.id?.slice(-6).toUpperCase() ?? '------';
                    const sep = '================================';
                    const sep2 = '--------------------------------';

                    // Items
                    const itemsLines = (r.items ?? []).map(item => {
                        const qty = item.isWeight
                            ? `${parseFloat(item.qty).toFixed(3)} kg`
                            : `${item.qty} und`;
                        const sub = (item.priceUsd * item.qty).toFixed(2);
                        return `- ${item.name}\n  ${qty} x $${parseFloat(item.priceUsd).toFixed(2)} = $${sub}`;
                    }).join('\n');

                    // Pagos
                    const paymentsLines = (r.payments ?? []).map(p => {
                        const isBs = p.currency === 'BS';
                        const val = isBs
                            ? `Bs ${Math.ceil(p.amountBs ?? p.amountUsd * r.rate)}`
                            : `$${parseFloat(p.amountUsd).toFixed(2)}`;
                        return `  ${p.methodLabel}: ${val}`;
                    }).join('\n');

                    // Totales
                    const totalBs = r.totalBs ?? (r.totalUsd * r.rate);
                    const totalUsdStr = `$${parseFloat(r.totalUsd).toFixed(2)}`;
                    const totalBsStr = `Bs ${Math.ceil(totalBs)}`;

                    // Vuelto (solo si hay)
                    const changeLines = r.changeUsd > 0.005
                        ? `\nVUELTO: $${parseFloat(r.changeUsd).toFixed(2)}`
                        : '';

                    // Fiado (solo si aplica)
                    const fiadoLine = r.fiadoUsd > 0.005
                        ? `\nPENDIENTE (fiado): $${parseFloat(r.fiadoUsd).toFixed(2)}`
                        : '';

                    // Cliente
                    const clienteLine = r.customerName && r.customerName !== 'Consumidor Final'
                        ? `Cliente: ${r.customerName}\n`
                        : '';

                    const text = [
                        `COMPROBANTE DE VENTA | PRECIOS AL DIA`,
                        sep2,
                        `Orden: #${saleNum}`,
                        `${clienteLine}Fecha: ${fecha}`,
                        sep,
                        ``,
                        `DETALLE DE PRODUCTOS:`,
                        itemsLines,
                        ``,
                        sep,
                        `TOTAL: ${totalUsdStr}  /  ${totalBsStr}`,
                        paymentsLines ? `\nPAGOS:\n${paymentsLines}` : '',
                        changeLines,
                        fiadoLine,
                        sep,
                        `Gracias por su compra!`,
                        `Precios Al Dia - Sistema POS`,
                    ].filter(Boolean).join('\n');

                    const phone = formatVzlaPhone(r.customerPhone);
                    const waUrl = phone
                        ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
                        : `https://wa.me/?text=${encodeURIComponent(text)}`;
                    window.open(waUrl, '_blank');
                }}
            />

            {/* Modal de Confirmación: Vaciar Cesta */}
            <ConfirmModal
                isOpen={showClearCartConfirm}
                onClose={() => setShowClearCartConfirm(false)}
                onConfirm={() => { setCart([]); setShowClearCartConfirm(false); }}
                title="¿Vaciar toda la cesta?"
                message="Todos los productos serán eliminados de la cesta actual. Esta acción no se puede deshacer."
                confirmText="Sí, vaciar"
                variant="cart"
            />

            {/* 🎉 Confetti post-venta */}
            {showConfetti && <Confetti onDone={() => setShowConfetti(false)} />}

            {/* Mini Nav — fixed at bottom, replaces hidden tab bar in POS mode */}
            {onNavigate && (
                <div className="fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-xl border-t border-slate-700/50 pb-[env(safe-area-inset-bottom)]">
                    <div className="flex items-center justify-around max-w-md mx-auto px-2 py-1.5">
                        {[
                            { id: 'inicio', icon: Home, label: 'Inicio' },
                            { id: 'catalogo', icon: LayoutGrid, label: 'Catálogo' },
                            { id: 'clientes', icon: Users, label: 'Clientes' },
                            { id: 'reportes', icon: BarChart3, label: 'Reportes' },
                        ].map(nav => (
                            <button
                                key={nav.id}
                                onClick={() => { triggerHaptic?.(); onNavigate(nav.id); }}
                                className="flex flex-col items-center gap-0.5 py-1.5 px-3 rounded-xl text-slate-400 hover:text-white active:scale-95 transition-all"
                            >
                                <nav.icon size={18} />
                                <span className="text-[9px] font-bold">{nav.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

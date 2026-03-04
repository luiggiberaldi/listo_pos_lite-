import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { storageService } from '../utils/storageService';
import { useSounds } from '../hooks/useSounds';
import { useVoiceSearch } from '../hooks/useVoiceSearch';
import { useNotifications } from '../hooks/useNotifications';
import { getActivePaymentMethods } from '../config/paymentMethods';
import { showToast } from '../components/Toast';

// Components
import SalesHeader from '../components/Sales/SalesHeader';
import SearchBar from '../components/Sales/SearchBar';
import CategoryBar from '../components/Sales/CategoryBar';
import CartPanel from '../components/Sales/CartPanel';
import ReceiptModal from '../components/Sales/ReceiptModal';
import CheckoutModal from '../components/Sales/CheckoutModal';

import ConfirmModal from '../components/ConfirmModal';
import Confetti from '../components/Confetti';
import { buildReceiptWhatsAppUrl } from '../components/Sales/ReceiptShareHelper';

const SALES_KEY = 'bodega_sales_v1';

export default function SalesView({ rates, triggerHaptic, onNavigate }) {
    const { playAdd, playRemove, playCheckout, playError } = useSounds();
    const { notifySaleComplete, notifyLowStock } = useNotifications();

    // ── State ──────────────────────────────────────
    const [products, setProducts] = useState([]);
    const [customers, setCustomers] = useState([]);
    const [paymentMethods, setPaymentMethods] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showConfetti, setShowConfetti] = useState(false);
    const [showClearCartConfirm, setShowClearCartConfirm] = useState(false);

    // Cart
    const [cart, setCart] = useState(() => {
        try { const saved = localStorage.getItem('pending_cart'); return saved ? JSON.parse(saved) : []; }
        catch { return []; }
    });

    // Search
    const searchInputRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectedCategory, setSelectedCategory] = useState('todos');

    // Modals
    const [showCheckout, setShowCheckout] = useState(false);
    const [showReceipt, setShowReceipt] = useState(null);
    const [hierarchyPending, setHierarchyPending] = useState(null);
    const [weightPending, setWeightPending] = useState(null);
    const [selectedCustomerId, setSelectedCustomerId] = useState('');

    // Rate config
    const [showRateConfig, setShowRateConfig] = useState(false);
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

    // Voice
    const handleSetSearchTerm = (text) => { setSearchTerm(text); setSelectedIndex(0); };
    const { isRecording, isProcessingAudio, toggleRecording } = useVoiceSearch({
        onResult: (text) => { handleSetSearchTerm(text); searchInputRef.current?.focus(); },
        triggerHaptic,
    });

    // ── Derived (memos) ───────────────────────────
    const searchResults = useMemo(() => searchTerm.length >= 1
        ? products.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.barcode?.includes(searchTerm)).slice(0, 6)
        : [], [searchTerm, products]);

    const filteredByCategory = useMemo(() => selectedCategory === 'todos'
        ? products
        : products.filter(p => p.category === selectedCategory), [selectedCategory, products]);

    const cartTotalUsd = cart.reduce((sum, item) => sum + (item.priceUsd * item.qty), 0);
    const cartTotalBs = cartTotalUsd * effectiveRate;
    const cartItemCount = cart.reduce((sum, item) => sum + item.qty, 0);

    const formatBs = (n) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

    // ── Effects ───────────────────────────────────
    // Persist rate config
    useEffect(() => {
        localStorage.setItem('bodega_use_auto_rate', JSON.stringify(useAutoRate));
        localStorage.setItem('bodega_custom_rate', customRate.toString());
    }, [useAutoRate, customRate]);

    // Persist cart
    useEffect(() => {
        if (cart.length > 0) localStorage.setItem('pending_cart', JSON.stringify(cart));
        else localStorage.removeItem('pending_cart');
    }, [cart]);

    // Load data
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

                const recycled = localStorage.getItem('recycled_cart');
                if (recycled) {
                    try {
                        const items = JSON.parse(recycled);
                        if (Array.isArray(items) && items.length > 0) {
                            setCart(items.map(item => ({
                                id: item.id, name: item.name, qty: item.qty,
                                priceUsd: item.priceUsd, costBs: item.costBs || 0, costUsd: item.costUsd || 0, isWeight: item.isWeight || false,
                            })));
                        }
                    } catch (_) { /* ignore */ }
                    localStorage.removeItem('recycled_cart');
                }
            }
        };
        load();
        return () => { mounted = false; };
    }, []);

    // Auto-focus search
    useEffect(() => { if (!isLoading && searchInputRef.current) searchInputRef.current.focus(); }, [isLoading]);

    // Refresh products on window focus
    useEffect(() => {
        const handleFocus = async () => { setProducts(await storageService.getItem('my_products_v1', [])); };
        window.addEventListener('focus', handleFocus);
        return () => window.removeEventListener('focus', handleFocus);
    }, []);

    // Return focus after closing modals
    useEffect(() => { if (!showCheckout && !showReceipt && searchInputRef.current) searchInputRef.current.focus(); }, [showCheckout, showReceipt]);

    // Global keybinds (F9 = checkout, Escape = close modals)
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'F9') { e.preventDefault(); if (cart.length > 0 && !showCheckout && !showReceipt) setShowCheckout(true); }
            if (e.key === 'Escape') {
                if (showCheckout) { setShowCheckout(false); setSelectedCustomerId(''); }
                if (showReceipt) { setShowReceipt(null); setSelectedCustomerId(''); }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [cart, showCheckout, showReceipt]);

    // ── Callbacks ─────────────────────────────────
    const addToCart = useCallback((product, qtyOverride = null, forceMode = null) => {
        triggerHaptic && triggerHaptic();

        // Validación temprana: rechazar productos sin precio válido
        if (!product.priceUsdt || isNaN(product.priceUsdt) || product.priceUsdt <= 0) {
            playError();
            showToast('Este producto no tiene precio válido. Edítalo primero.', 'warning');
            return;
        }

        playAdd();

        if (product.sellByUnit && product.unitPriceUsd && !forceMode && !qtyOverride) { setHierarchyPending(product); return; }
        if ((product.unit === 'kg' || product.unit === 'litro') && !qtyOverride) { setWeightPending(product); return; }

        let priceToUse = parseFloat(product.priceUsdt) || 0;
        let cartId = product.id;
        let cartName = product.name;
        let qtyToAdd = qtyOverride || 1;

        if (forceMode === 'unit') {
            priceToUse = product.unitPriceUsd;
            cartId = product.id + '_unit';
            cartName = product.name + ' (Ud.)';
        }

        setCart(prev => {
            const existing = prev.find(i => i.id === cartId && i.priceUsd === priceToUse);
            if (existing && !qtyOverride) return prev.map(i => i.id === cartId ? { ...i, qty: i.qty + 1 } : i);
            if (existing && qtyOverride) return prev.map(i => i.id === cartId ? { ...i, qty: i.qty + qtyOverride } : i);

            const itemCostBs = product.costBs || (product.costUsd ? product.costUsd * effectiveRate : 0);
            return [...prev, {
                ...product, id: cartId, name: cartName, priceUsd: priceToUse,
                costBs: forceMode === 'unit' ? itemCostBs / (product.unitsPerPackage || 1) : itemCostBs,
                costUsd: forceMode === 'unit' ? (product.costUsd || 0) / (product.unitsPerPackage || 1) : (product.costUsd || 0),
                qty: qtyToAdd, isWeight: !!qtyOverride,
                _originalId: product.id, _mode: forceMode || 'package', _unitsPerPackage: product.unitsPerPackage || 1,
            }];
        });
        handleSetSearchTerm('');
        setHierarchyPending(null);
        searchInputRef.current?.focus();
    }, [triggerHaptic, effectiveRate]);

    const updateQty = (id, delta) => {
        triggerHaptic && triggerHaptic();
        if (delta < 0) playRemove();
        setCart(prev => prev.map(i => {
            if (i.id !== id) return i;
            let newQty = Math.round((i.qty + delta) * 1000) / 1000;
            if (newQty < 0) newQty = 0;
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

    const handleSearchKeyDown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(prev => Math.max(prev - 1, 0)); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            // Barcode scanner (prefix 21)
            if (searchTerm.startsWith('21') && searchTerm.length >= 13) {
                const pluCode = parseInt(searchTerm.substring(2, 7), 10).toString();
                const weightKg = parseInt(searchTerm.substring(7, 12), 10) / 1000;
                const p = products.find(p => p.id === pluCode || p.barcode?.includes(pluCode) || p.barcode?.includes(searchTerm.substring(0, 7)));
                if (p) { addToCart({ ...p, isWeight: true }, weightKg); handleSetSearchTerm(''); return; }
            }
            if (searchResults[selectedIndex]) addToCart(searchResults[selectedIndex]);
            else if (searchResults.length === 1) addToCart(searchResults[0]);
            else if (searchTerm.length >= 3 && searchResults.length === 0) {
                const exactMatch = products.find(p => p.barcode === searchTerm);
                if (exactMatch) addToCart(exactMatch);
            }
        }
    };

    const handleUseSaldoFavor = () => { /* Managed internally by CheckoutModal */ };

    const handleCheckout = async (payments) => {
        triggerHaptic && triggerHaptic();
        const selectedCustomer = customers.find(c => c.id === selectedCustomerId);
        if (cart.length === 0) return;

        const totalPaidUsd = payments.reduce((acc, p) => acc + p.amountUsd, 0);
        const remainingUsd = Math.max(0, cartTotalUsd - totalPaidUsd);
        const changeUsd = Math.max(0, totalPaidUsd - cartTotalUsd);
        const changeBs = changeUsd * effectiveRate;

        if (!selectedCustomer && remainingUsd > 0.01) return;
        if (isNaN(cartTotalUsd) || cartTotalUsd < 0 || isNaN(totalPaidUsd) || totalPaidUsd < 0) {
            console.error('Abortando venta. Integridad matemática comprometida.');
            showToast('Error de integridad de datos. Revisa los montos.', 'error');
            playError(); return;
        }

        const fiadoAmountUsd = remainingUsd > 0.01 ? remainingUsd : 0;
        const sale = {
            id: crypto.randomUUID(),
            tipo: fiadoAmountUsd > 0 ? 'VENTA_FIADA' : 'VENTA',
            status: 'COMPLETADA',
            items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, priceUsd: i.priceUsd, costBs: i.costBs || 0, costUsd: i.costUsd || 0, isWeight: i.isWeight })),
            totalUsd: cartTotalUsd, totalBs: cartTotalBs, payments, rate: effectiveRate,
            rateSource: useAutoRate ? 'BCV Auto' : 'Manual',
            timestamp: new Date().toISOString(),
            changeUsd: fiadoAmountUsd > 0 ? 0 : changeUsd,
            changeBs: fiadoAmountUsd > 0 ? 0 : changeBs,
            customerId: selectedCustomerId || null,
            customerName: selectedCustomer ? selectedCustomer.name : 'Consumidor Final',
            customerPhone: selectedCustomer?.phone || null,
            fiadoUsd: fiadoAmountUsd
        };

        const existingSales = await storageService.getItem(SALES_KEY, []);
        sale.saleNumber = existingSales.reduce((mx, s) => Math.max(mx, s.saleNumber || 0), 0) + 1;
        await storageService.setItem(SALES_KEY, [sale, ...existingSales]);

        // Deduct stock
        const updatedProducts = products.map(p => {
            const cartItem = cart.find(i => i.id === p.id);
            return cartItem ? { ...p, stock: Math.max(0, (p.stock ?? 0) - cartItem.qty) } : p;
        });
        setProducts(updatedProducts);
        await storageService.setItem('my_products_v1', updatedProducts);

        // Update customer debt
        const amount_favor_used = payments.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + p.amountUsd, 0);
        const debtIncurred = fiadoAmountUsd + amount_favor_used;
        if (selectedCustomer && debtIncurred > 0) {
            const updatedCustomers = customers.map(c => c.id === selectedCustomer.id ? { ...c, deuda: c.deuda + debtIncurred } : c);
            setCustomers(updatedCustomers);
            await storageService.setItem('my_customers_v1', updatedCustomers);
        }

        setShowReceipt(sale); playCheckout(); setShowConfetti(true);
        notifySaleComplete(sale.saleNumber, sale.totalUsd, sale.totalBs);
        notifyLowStock(updatedProducts);
        setCart([]); setShowCheckout(false); setSelectedCustomerId('');
    };

    const handleCreateCustomer = async (name, phone) => {
        const newCustomer = { id: crypto.randomUUID(), name, phone: phone || '', deuda: 0, favor: 0, createdAt: new Date().toISOString() };
        const updated = [...customers, newCustomer];
        setCustomers(updated);
        await storageService.setItem('my_customers_v1', updated);
        return newCustomer;
    };

    // ── Loading ───────────────────────────────────
    if (isLoading) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center">
                <div className="w-8 h-8 rounded-full border-4 border-slate-200 dark:border-slate-800 border-t-emerald-500 animate-spin" />
            </div>
        );
    }

    // ── Render ─────────────────────────────────────
    return (
        <div className="flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-950 p-2 sm:p-4 pb-14 sm:pb-4 overflow-hidden relative">

            {/* Header + Rate Config */}
            <SalesHeader
                effectiveRate={effectiveRate}
                useAutoRate={useAutoRate} setUseAutoRate={setUseAutoRate}
                customRate={customRate} setCustomRate={setCustomRate}
                showRateConfig={showRateConfig} setShowRateConfig={setShowRateConfig}
                triggerHaptic={triggerHaptic}
            />

            {/* ── Split Layout: Products (left) + Cart Sidebar (right) on desktop ── */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:gap-4">

                {/* ── Left Column: Search + Categories ── */}
                <div className="flex-1 min-h-0 flex flex-col lg:min-w-0 overflow-y-auto lg:overflow-hidden" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {/* Search + Popups */}
                    <div className="shrink-0 mb-3 bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl p-3 sm:p-4 shadow-sm border border-slate-100 dark:border-slate-800">
                        <SearchBar
                            ref={searchInputRef}
                            searchTerm={searchTerm}
                            onSearchChange={handleSetSearchTerm}
                            onKeyDown={handleSearchKeyDown}
                            searchResults={searchResults}
                            selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex}
                            effectiveRate={effectiveRate}
                            addToCart={addToCart}
                            isRecording={isRecording} isProcessingAudio={isProcessingAudio} toggleRecording={toggleRecording}
                            hierarchyPending={hierarchyPending} setHierarchyPending={setHierarchyPending}
                            weightPending={weightPending} setWeightPending={setWeightPending}
                        />
                    </div>

                    {/* Category Chips + Product Grid */}
                    {!showCheckout && !showReceipt && (
                        <CategoryBar
                            selectedCategory={selectedCategory} setSelectedCategory={setSelectedCategory}
                            filteredByCategory={filteredByCategory}
                            addToCart={addToCart}
                            triggerHaptic={triggerHaptic}
                            searchTerm={searchTerm}
                        />
                    )}

                    {/* Cart — visible on mobile only (below products) */}
                    <div className="lg:hidden pb-20">
                        <CartPanel
                            cart={cart} effectiveRate={effectiveRate}
                            cartTotalUsd={cartTotalUsd} cartTotalBs={cartTotalBs} cartItemCount={cartItemCount}
                            updateQty={updateQty} removeFromCart={removeFromCart}
                            onCheckout={() => { triggerHaptic && triggerHaptic(); setShowCheckout(true); }}
                            onClearCart={() => { triggerHaptic && triggerHaptic(); setShowClearCartConfirm(true); }}
                            triggerHaptic={triggerHaptic}
                        />
                    </div>
                </div>

                {/* ── Right Column: Cart Sidebar — desktop only ── */}
                <div className="hidden lg:flex lg:w-[380px] lg:shrink-0 lg:flex-col">
                    <CartPanel
                        cart={cart} effectiveRate={effectiveRate}
                        cartTotalUsd={cartTotalUsd} cartTotalBs={cartTotalBs} cartItemCount={cartItemCount}
                        updateQty={updateQty} removeFromCart={removeFromCart}
                        onCheckout={() => { triggerHaptic && triggerHaptic(); setShowCheckout(true); }}
                        onClearCart={() => { triggerHaptic && triggerHaptic(); setShowClearCartConfirm(true); }}
                        triggerHaptic={triggerHaptic}
                    />
                </div>

            </div>

            {/* Checkout Modal */}
            {showCheckout && (
                <CheckoutModal
                    onClose={() => { setShowCheckout(false); setSelectedCustomerId(''); }}
                    cartTotalUsd={cartTotalUsd} cartTotalBs={cartTotalBs} effectiveRate={effectiveRate}
                    customers={customers} selectedCustomerId={selectedCustomerId} setSelectedCustomerId={setSelectedCustomerId}
                    paymentMethods={paymentMethods}
                    onConfirmSale={handleCheckout} onUseSaldoFavor={handleUseSaldoFavor} onCreateCustomer={handleCreateCustomer}
                    triggerHaptic={triggerHaptic}
                />
            )}

            {/* Receipt Modal */}
            <ReceiptModal
                receipt={showReceipt}
                onClose={() => { setShowReceipt(null); setSelectedCustomerId(''); }}
                onShareWhatsApp={(r) => { window.open(buildReceiptWhatsAppUrl(r), '_blank'); }}
            />

            {/* Clear Cart Confirm */}
            <ConfirmModal
                isOpen={showClearCartConfirm}
                onClose={() => setShowClearCartConfirm(false)}
                onConfirm={() => { setCart([]); setShowClearCartConfirm(false); }}
                title="¿Vaciar toda la cesta?"
                message="Todos los productos serán eliminados de la cesta actual. Esta acción no se puede deshacer."
                confirmText="Sí, vaciar"
                variant="cart"
            />

            {/* Confetti */}
            {showConfetti && <Confetti onDone={() => setShowConfetti(false)} />}

            {/* Mini Nav */}

        </div>
    );
}

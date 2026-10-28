import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { storageService } from '../utils/storageService';
import { BODEGA_CATEGORIES } from '../config/categories';
import { runStockOperation } from '../services/inventoryOperationService';
import { getActiveAccountId } from '../config/storageScope';
import { resolveLocalStock, isUnknownProductResult } from '../sync/stockResolution';

const ProductContext = createContext();

export function ProductProvider({ children, rates }) {
    const [products, setProducts] = useState([]);
    const [categories, setCategories] = useState(BODEGA_CATEGORIES);
    const [isLoadingProducts, setIsLoadingProducts] = useState(true);

    // Guard ref: prevents infinite loop when auto-save fires app_storage_update
    const savingRef = useRef(false);
    // Max-wait ref: tracks last save time for debounce ceiling
    const lastSaveRef = useRef(Date.now());

    // MARKET LOGIC - Street Rate
    const [streetRate, setStreetRate] = useState(() => {
        const saved = localStorage.getItem('street_rate_bs');
        return saved ? parseFloat(saved) : 0;
    });

    // GLOBAL RATE LOGIC (Sync with SalesView)
    const [rateMode, setRateMode] = useState(() => {
        const savedMode = localStorage.getItem('bodega_rate_mode');
        if (savedMode) return savedMode;
        
        // Retrocompatibilidad
        const savedAuto = localStorage.getItem('bodega_use_auto_rate');
        if (savedAuto !== null) {
            return JSON.parse(savedAuto) ? 'bcv' : 'manual';
        }
        return 'bcv';
    });
    const [customRate, setCustomRate] = useState(() => {
        const saved = localStorage.getItem('bodega_custom_rate');
        return saved && parseFloat(saved) > 0 ? saved : '';
    });

    // AUTO COP LOGIC
    const [copEnabled, setCopEnabled] = useState(() => {
        return localStorage.getItem('cop_enabled') === 'true';
    });
    const [autoCopEnabled, setAutoCopEnabled] = useState(() => {
        return localStorage.getItem('auto_cop_enabled') === 'true';
    });
    const [tasaCopManual, setTasaCopManual] = useState(() => {
        return localStorage.getItem('tasa_cop') || '';
    });

    const useAutoRate = rateMode === 'bcv' || rateMode === 'euro';
    const setUseAutoRate = (val) => {
        const nextMode = val ? 'bcv' : 'manual';
        setRateMode(nextMode);
    };

    const bcvPrice = rates?.bcv?.price || 0;
    const euroPrice = rates?.euro?.price || 0;
    
    let effectiveRate = bcvPrice;
    if (rateMode === 'bcv') {
        effectiveRate = bcvPrice;
    } else if (rateMode === 'euro') {
        effectiveRate = euroPrice;
    } else if (rateMode === 'manual') {
        effectiveRate = parseFloat(customRate) > 0 ? parseFloat(customRate) : bcvPrice;
    }
    
    // Calcula el COP efectivo. rates.autoCopRate es calculado en useRates basado en TRM y la Brecha USDT/BCV.
    const tasaCop = autoCopEnabled && rates.autoCopRate?.price 
        ? rates.autoCopRate.price 
        : (parseFloat(tasaCopManual) > 0 ? parseFloat(tasaCopManual) : 4150);

    // Initial Load
    useEffect(() => {
        let isMounted = true;
        const loadData = async () => {
            try {
                const savedProducts = await storageService.getItem('bodega_products_v1', []);
                const savedCategories = await storageService.getItem('my_categories_v1', BODEGA_CATEGORIES);
                if (isMounted) {
                    setProducts(savedProducts);
                    setCategories(savedCategories);
                }
            } catch (err) {
                console.error('[ProductContext] Error loading initial data:', err);
            } finally {
                if (isMounted) setIsLoadingProducts(false);
            }
        };
        loadData();
        return () => { isMounted = false; };
    }, []);

    // Set Initial Street Rate (from BCV)
    useEffect(() => {
        if (!streetRate && rates.bcv?.price > 0 && !localStorage.getItem('street_rate_bs')) {
            setStreetRate(rates.bcv.price);
        }
    }, [rates.bcv?.price, streetRate]);

    // Auto-save products and categories with Debounce (Performance Fix)
    useEffect(() => {
        if (!isLoadingProducts) {
            savingRef.current = true;
            const elapsed = Date.now() - lastSaveRef.current;
            const delay = elapsed > 10000 ? 0 : 1000;
            const timer = setTimeout(() => {
                lastSaveRef.current = Date.now();
                const savePromises = [];
                if (products.length > 0) {
                    savePromises.push(storageService.setItem('bodega_products_v1', products));
                } else {
                    // Guardar array vacío explícitamente (en vez de removeItem) 
                    // para que la nube sincronice el borrado correctamente
                    savePromises.push(storageService.setItem('bodega_products_v1', []));
                }
                savePromises.push(storageService.setItem('my_categories_v1', categories));
                Promise.all(savePromises).finally(() => {
                    // Reset guard after microtask queue flushes
                    setTimeout(() => { savingRef.current = false; }, 50);
                });
            }, delay); // debounce with max-wait of 10s

            return () => clearTimeout(timer);
        }
    }, [products, categories, isLoadingProducts]);

    useEffect(() => {
        if (streetRate > 0) localStorage.setItem('street_rate_bs', streetRate.toString());
    }, [streetRate]);

    useEffect(() => {
        localStorage.setItem('bodega_rate_mode', rateMode);
        localStorage.setItem('bodega_use_auto_rate', JSON.stringify(rateMode === 'bcv' || rateMode === 'euro'));
        if (customRate) localStorage.setItem('bodega_custom_rate', customRate.toString());
    }, [rateMode, customRate]);

    // Listener para actualizar si cambia en otra pestaña/componente
    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'bodega_custom_rate') {
                setCustomRate(e.newValue);
            }
            if (e.key === 'bodega_rate_mode') {
                setRateMode(e.newValue);
            }
            if (e.key === 'bodega_use_auto_rate') {
                // bodega_rate_mode (A5) llega por su lado y es el dato preciso; esta
                // llave vieja solo dice auto/manual, así que no debe pisar 'euro'.
                const isAuto = !!JSON.parse(e.newValue);
                setRateMode(prev => {
                    if (!isAuto) return 'manual';
                    if (prev !== 'manual') return prev;
                    const stored = localStorage.getItem('bodega_rate_mode');
                    return stored && stored !== 'manual' ? stored : 'bcv';
                });
            }
            if (e.key === 'cop_enabled') {
                setCopEnabled(e.newValue === 'true');
            }
            if (e.key === 'auto_cop_enabled') {
                setAutoCopEnabled(e.newValue === 'true');
            }
            if (e.key === 'tasa_cop') {
                setTasaCopManual(e.newValue);
            }
            if (e.key === 'bodega_products_v1') {
                // If modified in another tab, fetch it
                storageService.getItem('bodega_products_v1', []).then(updatedProducts => setProducts(updatedProducts));
            }
            if (e.key === 'my_categories_v1') {
                storageService.getItem('my_categories_v1', BODEGA_CATEGORIES).then(updatedCategories => setCategories(updatedCategories));
            }
        };

        // Mantener app_storage_update por si algún componente viejo sigue usándolo para sincronizar
        // aunque ahora ProductContext centraliza todo.
        const handleAppStorageUpdate = async (e) => {
            // Un pull de nube tiene prioridad sobre el auto-save local que pudo
            // arrancar mientras se hidrataba la cuenta.
            if (savingRef.current && e.detail?.source !== 'cloud') return;

            if (e.detail?.key === 'bodega_products_v1') {
                const updatedProducts = await storageService.getItem('bodega_products_v1', []);
                setProducts(updatedProducts);
            }
            if (e.detail?.key === 'my_categories_v1') {
                const updatedCategories = await storageService.getItem('my_categories_v1', BODEGA_CATEGORIES);
                setCategories(updatedCategories);
            }
        };

        window.addEventListener('storage', handleStorageChange);
        window.addEventListener('app_storage_update', handleAppStorageUpdate);
        return () => {
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener('app_storage_update', handleAppStorageUpdate);
        };
    }, []);

    // Fase 3: el stock lo decide el CONTRATO de operación de inventario, no el
    // reemplazo del array local. Estados del resultado:
    //   confirmed → el stock_after del servidor es la única ley (sin clamps);
    //   conflict/invalid → el stock local NO se toca (explicado al usuario);
    //   pending (offline) → cambio optimista marcado como pendiente, jamás
    //   confirmado hasta que el contrato lo acepte.
    // A7 (mitigación): mientras public.products del servidor no tenga el stock real
    // por cuenta (Fase C), el saldo del servidor NO se copia sobre el stock local.
    // La operación se aplica sobre el stock del dispositivo (ver sync/stockResolution).
    //   confirmed → aplicada en el servidor (o ya procesada): se refleja localmente;
    //   producto desconocido en el servidor → se aplica solo localmente (local_only);
    //   conflict/invalid → el stock local NO se toca (explicado al usuario);
    //   pending (offline) → cambio optimista marcado como pendiente.
    const applyStockResultToProduct = (productId, rawResult) => {
        const product = products.find(p => p.id === productId);
        let result = rawResult;
        if (isUnknownProductResult(result)) {
            result = { ...result, outcome: 'confirmed', status: 'local_only' };
        }

        if (result.outcome === 'confirmed' || result.outcome === 'pending') {
            const target = resolveLocalStock({
                currentStock: product?.stock,
                operation: result.operation,
                status: result.status,
                unit: product?.unit || 'unidad',
            });
            const stockSync = result.outcome === 'pending'
                ? 'pending'
                : (result.status === 'local_only' ? 'local_only' : 'synced');
            setProducts(prevProducts => {
                const updated = prevProducts.map(p => p.id === productId
                    ? {
                        ...p,
                        stock: target,
                        stockSync,
                        ...(result.outcome === 'confirmed' && Number.isFinite(result.stockAfter)
                            ? { stockServer: result.stockAfter }
                            : {}),
                    }
                    : p);
                storageService.setItem('bodega_products_v1', updated).catch(() => {});
                return updated;
            });
            return result.outcome === 'confirmed' ? { ...result, stockAfter: target } : result;
        }
        return result;
    };

    // Optimista: la cantidad elegida se ve en el acto (sin "volver" al valor
    // anterior mientras responde el servidor). Si el contrato la rechaza
    // (conflicto/inválida), se revierte — solo si nadie la cambió entretanto.
    const showOptimisticStock = (product, operation) => {
        const unit = product.unit || 'unidad';
        const optimistic = resolveLocalStock({ currentStock: product.stock, operation, status: 'pending', unit });
        setProducts(prev => prev.map(p => p.id === product.id ? { ...p, stock: optimistic, stockSync: 'pending' } : p));
        return () => setProducts(prev => prev.map(p => (p.id === product.id && p.stock === optimistic)
            ? { ...p, stock: product.stock, stockSync: product.stockSync }
            : p));
    };
    const finishStockOperation = (productId, result, revert) => {
        const applied = applyStockResultToProduct(productId, result);
        if (applied.outcome === 'conflict' || applied.outcome === 'invalid') revert();
        return applied;
    };

    const adjustStock = async (productId, delta, meta = {}) => {
        const product = products.find(p => p.id === productId);
        if (!product) return { outcome: 'invalid', status: 'invalid', error: 'producto no encontrado' };
        const revert = showOptimisticStock(product, { mode: 'delta', quantity: delta });
        const result = await runStockOperation({
            productId,
            quantity: delta,
            mode: 'delta',
            operationType: 'AJUSTE_DIRECTO',
            unitMode: product.unit || 'unidad',
            reason: meta.reason || 'AJUSTE_DIRECTO',
            accountId: getActiveAccountId(),
            deviceId: meta.deviceId || null,
            actor: meta.actor || null,
        });
        return finishStockOperation(productId, result, revert);
    };

    const setProductStock = async (productId, exactStock, meta = {}) => {
        const product = products.find(p => p.id === productId);
        if (!product) return { outcome: 'invalid', status: 'invalid', error: 'producto no encontrado' };
        const parsed = typeof exactStock === 'number' ? exactStock : parseFloat(exactStock) || 0;
        const revert = showOptimisticStock(product, { mode: 'count', quantity: parsed });
        const result = await runStockOperation({
            productId,
            quantity: parsed,
            mode: 'count',
            operationType: 'CONTEO',
            unitMode: product.unit || 'unidad',
            reason: meta.reason || 'CONTEO',
            accountId: getActiveAccountId(),
            deviceId: meta.deviceId || null,
            actor: meta.actor || null,
        });
        return finishStockOperation(productId, result, revert);
    };

    return (
        <ProductContext.Provider value={{
            products,
            setProducts,
            categories,
            setCategories,
            isLoadingProducts,
            streetRate,
            setStreetRate,
            useAutoRate,
            setUseAutoRate,
            customRate,
            setCustomRate,
            effectiveRate,
            copEnabled,
            setCopEnabled,
            autoCopEnabled,
            setAutoCopEnabled,
            tasaCopManual,
            setTasaCopManual,
            tasaCop,
            adjustStock,
            setProductStock,
            rateMode,
            setRateMode
        }}>
            {children}
        </ProductContext.Provider>
    );
}

export const useProductContext = () => {
    const context = useContext(ProductContext);
    if (!context) {
        throw new Error("useProductContext must be used within a ProductProvider");
    }
    return context;
};

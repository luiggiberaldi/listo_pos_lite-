import { storageService } from './storageService';
import { procesarImpactoCliente } from './financialLogic';
import { logEvent } from '../services/auditService';
import { useAuthStore } from '../hooks/store/useAuthStore';
import { round2, subR, sumR } from './dinero';
import { supabase } from '../core/supabaseClient';
import { offlineQueueService } from '../services/offlineQueueService';

const SALES_KEY = 'bodega_sales_v1';

export async function processSaleTransaction({
    cart,
    cartTotalUsd,
    cartTotalBs,
    cartSubtotalUsd,
    payments,
    changeBreakdown,
    selectedCustomerId,
    customers,
    products,
    effectiveRate,
    tasaCop,
    copEnabled,
    discountData,
    useAutoRate
}) {
    if (cart.length === 0) return { success: false, error: 'Carrito vacío' };

    const selectedCustomer = customers.find(c => c.id === selectedCustomerId);

    const invalidPayment = payments.find(p => typeof p.amountUsd !== 'number' || isNaN(p.amountUsd));
    if (invalidPayment) return { success: false, error: 'Pago sin monto válido en USD' };

    const totalPaidUsd = sumR(payments.map(p => p.amountUsd));
    const remainingUsd = round2(Math.max(0, subR(cartTotalUsd, totalPaidUsd)));
    const changeUsd = round2(Math.max(0, subR(totalPaidUsd, cartTotalUsd)));

    if (!selectedCustomer && remainingUsd > 0.01) {
        return { success: false, error: 'Se requiere cliente para ventas fiadas' };
    }

    if (isNaN(cartTotalUsd) || cartTotalUsd < 0 || isNaN(totalPaidUsd) || totalPaidUsd < 0) {
        return { success: false, error: 'Integridad matemática comprometida' };
    }

    if (cartTotalUsd <= 0.01) {
        return { success: false, error: 'No se pueden generar ventas de $0.00' };
    }

    const fiadoAmountUsd = remainingUsd > 0.01 ? remainingUsd : 0;
    
    // Preparar el Payload para la validación centralizada
    // Se envía currency y methodLabel para que el RPC pueda mapear cuentas contables
    // correctamente sin depender del methodId hardcodeado.
    const rpcPayload = {
      total: cartTotalUsd,
      cart: cart.map(i => ({ id: i._originalId || i.id, qty: i.qty, priceUsd: i.priceUsd })),
      payments: payments.map(p => ({
        methodId: p.methodId,
        amountUsd: p.amountUsd,
        currency: p.currency || 'USD',          // 'USD' | 'BS' | 'COP'
        methodLabel: p.methodLabel || p.methodId // Nombre legible: "Pago Móvil", "Binance", etc.
      })),
      fiadoUsd: fiadoAmountUsd
    };

    let saleMode = 'online';
    let finalSaleId = null;

    if (navigator.onLine) {
       try {
         // Intentar RPC Transaccional Atómica
         // NOTE: Supabase JS client (.rpc()) does not support AbortController/signal.
         // We use Promise.race as a client-side timeout. The server-side request may
         // continue to completion even after the client gives up — this is acceptable
         // because the offline queue will deduplicate via idempotency keys.
         const abortController = new AbortController();
         const rpcPromise = supabase.rpc('process_checkout', { payload: rpcPayload });
         const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
           abortController.abort();
           reject(new Error('TIMEOUT'));
         }, 3000));

         const { data, error } = await Promise.race([rpcPromise, timeoutPromise]);
         if (error) throw error;
         
         finalSaleId = data.sale_id;
       } catch (err) {
         console.warn("[Checkout] Fallo en RPC Supabase, cambiando a MODO OFFLINE", err);
         saleMode = 'offline';
       }
    } else {
       saleMode = 'offline';
    }

    if (saleMode === 'offline') {
       // Delegar a la cola de emergencia
       await offlineQueueService.addSaleToQueue(rpcPayload);
    }

    // ── GESTIÓN DE CACHÉ LOCAL (Para no bloquear al usuario) ──
    const sale = {
        id: finalSaleId || crypto.randomUUID(),
        tipo: fiadoAmountUsd > 0 ? 'VENTA_FIADA' : 'VENTA',
        status: saleMode === 'online' ? 'COMPLETADA' : 'PENDIENTE_SYNC',
        items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, priceUsd: i.priceUsd, costBs: i.costBs || 0, costUsd: i.costUsd || 0, isWeight: i.isWeight })),
        cartSubtotalUsd: cartSubtotalUsd,
        discountType: discountData?.type || null,
        discountValue: discountData?.value || 0,
        discountAmountUsd: discountData?.amountUsd || 0,
        totalUsd: cartTotalUsd,
        totalBs: cartTotalBs,
        totalCop: copEnabled && tasaCop > 0 ? cartTotalUsd * tasaCop : 0,
        payments,
        rate: effectiveRate,
        tasaCop: copEnabled ? tasaCop : 0,
        copEnabled: copEnabled,
        rateSource: useAutoRate ? 'BCV Auto' : 'Manual',
        timestamp: new Date().toISOString(),
        changeUsd: fiadoAmountUsd > 0 ? 0 : (changeBreakdown?.changeUsdGiven || 0),
        changeBs: fiadoAmountUsd > 0 ? 0 : (changeBreakdown?.changeBsGiven || 0),
        customerId: selectedCustomerId || null,
        customerName: selectedCustomer ? selectedCustomer.name : 'Consumidor Final',
        customerDocument: selectedCustomer?.documentId || null,
        customerPhone: selectedCustomer?.phone || null,
        fiadoUsd: fiadoAmountUsd
    };

    const existingSales = await storageService.getItem(SALES_KEY, []);
    const saleNumber = existingSales.reduce((mx, s) => Math.max(mx, s.saleNumber || 0), 0) + 1;
    const finalPersistedSale = Object.freeze({ ...sale, saleNumber });

    await storageService.setItem(SALES_KEY, [finalPersistedSale, ...existingSales]);

    // Audit log
    const user = useAuthStore.getState().usuarioActivo;
    const tipo = fiadoAmountUsd > 0 ? 'VENTA_FIADO' : 'VENTA_COMPLETADA';
    logEvent('VENTA', tipo, `Venta #${saleNumber} [${saleMode.toUpperCase()}] - $${cartTotalUsd.toFixed(2)} - ${cart.length} items - ${selectedCustomer?.name || 'Consumidor Final'}`, user, { saleId: finalPersistedSale.id, total: cartTotalUsd, items: cart.length });

    // Deduct stock in local cache immediately
    const updatedProducts = products.map(p => {
        const cartItemsForThisProduct = cart.filter(i => (i._originalId || i.id) === p.id);
        if (cartItemsForThisProduct.length > 0) {
            const totalDeducted = cartItemsForThisProduct.reduce((sum, item) => {
                if (item.isWeight) return sum + item.qty;
                if (item._mode === 'unit') {
                    const pkg = item._unitsPerPackage > 0 ? item._unitsPerPackage : 1;
                    return sum + (item.qty / pkg);
                }
                return sum + item.qty;
            }, 0);

            const allowNeg = localStorage.getItem('allow_negative_stock') === 'true';
            const newStock = (p.stock ?? 0) - totalDeducted;
            return { ...p, stock: allowNeg ? newStock : Math.max(0, newStock) };
        }
        return p;
    });

    await storageService.setItem('bodega_products_v1', updatedProducts);

    let updatedCustomer = null;
    let updatedCustomers = customers;

    if (selectedCustomer) {
        const amount_favor_used = payments.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + p.amountUsd, 0);

        const transaccionOpts = {
            usaSaldoFavor: amount_favor_used,
            esCredito: fiadoAmountUsd > 0.009,
            deudaGenerada: fiadoAmountUsd,
            vueltoParaMonedero: 0
        };

        updatedCustomer = procesarImpactoCliente(selectedCustomer, transaccionOpts);
        updatedCustomers = customers.map(c => c.id === selectedCustomer.id ? updatedCustomer : c);

        await storageService.setItem('bodega_customers_v1', updatedCustomers);
    }

    return {
        success: true,
        sale: finalPersistedSale,
        updatedProducts,
        updatedCustomers,
        syncMode: saleMode
    };
}

import { storageService } from './storageService';
import { procesarImpactoCliente } from './financialLogic';
import { logEvent } from '../services/auditService';
import { useAuthStore } from '../hooks/store/useAuthStore';
import { round2, subR, sumR, mulR } from './dinero';
import { supabase } from '../core/supabaseClient';
import { offlineQueueService } from '../services/offlineQueueService';
import { getActiveAccountId } from '../config/storageScope';
import { newOperationId, isResolvableConflictStatus, conflictSaleStatus } from '../services/offlineQueuePolicy';
import { getAuthHeaders } from '../services/authHeaders';
import { PrinterSerial } from '../services/PrinterSerial';
import { getLocalISODate, getLocalISOTime } from './dateHelpers';
import { saleLineStockQuantity } from './quantityRules.js';

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
    useAutoRate,
    rateMode,
    businessDate = null,
    businessTime = null
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
    // Fase 2 (fin): el ID del carrito viaja TAL CUAL (identidad canónica del
    // catálogo local). Nada se renombra aquí: un ID no vinculado se rechaza
    // en el servidor con 'unknown_product' explícito y resoluble — jamás se
    // crea un producto fantasma con un UUID distinto al catálogo.

    // Fase 1 (idempotencia): el operation_id se asigna ANTES del primer
    // intento online y viaja como queue_id en todos los caminos (online,
    // fallback offline y reintentos de la cola). Un reintento es la MISMA
    // operación: mismo payload, mismo ID — nunca una venta nueva.
    const operationId = newOperationId();

    const rpcPayload = {
      total: cartTotalUsd,
      // qty/priceUsd: lo cobrado (en la unidad vendida). stock_qty: lo que se
      // descuenta del inventario (6 uds de una caja de 12 → 0.5 caja).
      cart: cart.map(i => ({ id: i._originalId || i.id, qty: i.qty, stock_qty: saleLineStockQuantity(i), priceUsd: i.priceUsd, name: i.name || '' })),
      payments: payments.map(p => ({
        methodId: p.methodId,
        amountUsd: p.amountUsd,
        currency: p.currency || 'USD',          // 'USD' | 'BS' | 'COP'
        methodLabel: p.methodLabel || p.methodId // Nombre legible: "Pago Móvil", "Binance", etc.
      })),
      fiadoUsd: fiadoAmountUsd,
      queue_id: operationId,
      account_id: getActiveAccountId()
    };

    let saleMode = 'online';
    let finalSaleId = null;
    let conflictData = null;
    let catalogPending = false;

    if (navigator.onLine) {
       try {
         const authHeaders = await getAuthHeaders();
         const checkoutPromise = fetch('/api/checkout', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', ...authHeaders },
           body: JSON.stringify(rpcPayload),
           signal: AbortSignal.timeout(5000),
         }).then(r => r.json());

         const data = await checkoutPromise;
         if (data.error || data.code) throw new Error(data.message || data.error || 'RPC error');

         if (data.status === 'unknown_product') {
            // Producto aún no registrado en el catálogo del servidor (antes el
            // proxy lo creaba al vuelo). No se bloquea al cajero: la venta va a
            // la cola como pendiente y la cola registra el catálogo local y
            // reintenta la MISMA operación; solo si sigue sin vincularse queda
            // como conflicto visible.
            saleMode = 'offline';
            catalogPending = true;
         } else if (isResolvableConflictStatus(data.status)) {
            // Venta ya cobrada bloqueada por un conflicto funcional (Fase 2):
            // stock negativo prohibido o producto no vinculado. Conflicto
            // EXPLÍCITO y recuperable: se preserva en la cola como 'conflicted'
            // — nunca sincronizada ni descartada — con el mismo operation_id
            // para reintentar tras la resolución.
            conflictData = data;
            await offlineQueueService.addSaleToQueue(rpcPayload);
            await offlineQueueService.markQueueConflict(operationId, data);
            saleMode = 'conflict';
         } else {
            // data.sale_id es SIEMPRE el ID canónico: si el servidor ya conocía
            // esta operación (respuesta previa perdida), responde duplicate:true
            // con el sale_id de la venta existente, sin descontar de nuevo.
            finalSaleId = data.sale_id;
            if (data.duplicate) {
               console.info(`[Checkout] Operación ${operationId} ya procesada; venta canónica ${data.sale_id}.`);
            }
         }
       } catch (err) {
         console.warn("[Checkout] Fallo en /api/checkout, cambiando a MODO OFFLINE", err);
         saleMode = 'offline';
       }
    } else {
       saleMode = 'offline';
    }

    if (saleMode === 'offline') {
       // Timeout, corte de conexión o respuesta ambígua: se encola EXACTAMENTE
       // el mismo payload con el mismo operation_id (rpcPayload.queue_id). El
       // reintento posterior será idéntico para el servidor, que devolverá la
       // venta canónica si este primer intento ya la había procesado.
       await offlineQueueService.addSaleToQueue(rpcPayload);
       if (catalogPending) offlineQueueService.syncPendingSales().catch(() => {});
    }

    // ── GESTIÓN DE CACHÉ LOCAL (Para no bloquear al usuario) ──
    const casheaPayment = payments.find(p => p.methodId === 'cashea');
    const casheaUsd = casheaPayment ? round2(casheaPayment.amountUsd) : 0;

    // Cuando Cashea financia parte de la venta, la deuda del cliente es sólo
    // el monto que Cashea adelantó (casheaUsd), NO el fiadoAmountUsd completo.
    // fiadoAmountUsd sigue yendo al RPC para cuadrar la contabilidad de Supabase.
    const deudaParaCliente = casheaUsd > 0 ? casheaUsd : fiadoAmountUsd;
    const tipoVenta = casheaUsd > 0 ? 'VENTA_CASHEA' : (fiadoAmountUsd > 0 ? 'VENTA_FIADA' : 'VENTA');

    const sale = {
        // Identidad estable: el sale_id canónico del servidor cuando se conoce;
        // si no, el operation_id local (misma identidad a través de reintentos).
        id: finalSaleId || operationId,
        syncQueueId: operationId,
        tipo: tipoVenta,
        status: saleMode === 'online' ? 'COMPLETADA' : (saleMode === 'conflict' ? conflictSaleStatus(conflictData) : 'PENDIENTE_SYNC'),
        stockConflict: conflictData,
        items: cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, priceUsd: i.priceUsd, costBs: i.costBs || 0, costUsd: i.costUsd || 0, isWeight: i.isWeight })),
        cartSubtotalUsd: cartSubtotalUsd,
        discountType: discountData?.type || null,
        discountValue: discountData?.value || 0,
        discountAmountUsd: discountData?.amountUsd || 0,
        totalUsd: cartTotalUsd,
        totalBs: (typeof cartTotalBs === 'number' && !isNaN(cartTotalBs) && cartTotalBs >= 0)
            ? cartTotalBs
            : mulR(cartTotalUsd, effectiveRate || 0),
        totalCop: copEnabled && tasaCop > 0 ? mulR(cartTotalUsd, tasaCop) : 0,
        payments,
        rate: effectiveRate,
        tasaCop: copEnabled ? tasaCop : 0,
        copEnabled: copEnabled,
        rateSource: rateMode 
            ? (rateMode === 'bcv' ? 'BCV Auto' : (rateMode === 'euro' ? 'Euro Auto' : 'Manual')) 
            : (useAutoRate ? 'BCV Auto' : 'Manual'),
        timestamp: new Date().toISOString(),
        // The commercial date belongs to the open cash session, not blindly
        // to the calendar date. This keeps a shift crossing midnight intact.
        fechaComercial: businessDate || getLocalISODate(new Date()),
        horaComercial: businessTime || getLocalISOTime(new Date()),
        changeUsd: tipoVenta !== 'VENTA' ? 0 : (changeBreakdown?.changeUsdGiven || 0),
        changeBs: tipoVenta !== 'VENTA' ? 0 : (changeBreakdown?.changeBsGiven || 0),
        customerId: selectedCustomerId || null,
        customerName: selectedCustomer ? selectedCustomer.name : 'Consumidor Final',
        customerDocument: selectedCustomer?.documentId || null,
        customerPhone: selectedCustomer?.phone || null,
        fiadoUsd: fiadoAmountUsd,
        casheaUsd,
    };

    const existingSales = await storageService.getItem(SALES_KEY, []);
    const saleNumber = existingSales.reduce((mx, s) => Math.max(mx, s.saleNumber || 0), 0) + 1;
    const finalPersistedSale = Object.freeze({ ...sale, saleNumber });

    await storageService.setItem(SALES_KEY, [finalPersistedSale, ...existingSales]);

    // Audit log
    const user = useAuthStore.getState().usuarioActivo;
    const tipo = casheaUsd > 0 ? 'VENTA_CASHEA' : (fiadoAmountUsd > 0 ? 'VENTA_FIADO' : 'VENTA_COMPLETADA');
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
            esCredito: deudaParaCliente > 0.009,
            deudaGenerada: deudaParaCliente,
            esCashea: casheaUsd > 0,   // deuda va a casheaDeuda si es Cashea
            vueltoParaMonedero: 0
        };

        updatedCustomer = procesarImpactoCliente(selectedCustomer, transaccionOpts);
        updatedCustomers = customers.map(c => c.id === selectedCustomer.id ? updatedCustomer : c);

        await storageService.setItem('bodega_customers_v1', updatedCustomers);
    }

    // Apertura automática del cajón si está configurado y la impresora está conectada
    if (
        localStorage.getItem('printer_serial_auto_drawer') === 'true' &&
        PrinterSerial.isConnected()
    ) {
        PrinterSerial.openDrawer().catch(err =>
            console.warn('[Checkout] No se pudo abrir el cajón:', err)
        );
    }

    return {
        success: true,
        sale: finalPersistedSale,
        updatedProducts,
        updatedCustomers,
        syncMode: saleMode
    };
}

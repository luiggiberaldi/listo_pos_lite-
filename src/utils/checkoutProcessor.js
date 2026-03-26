import { storageService } from './storageService';
import { procesarImpactoCliente } from './financialLogic';

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
    const totalPaidUsd = payments.reduce((acc, p) => acc + p.amountUsd, 0);
    const remainingUsd = Math.max(0, Math.round((cartTotalUsd - totalPaidUsd) * 100) / 100);
    const changeUsd = Math.max(0, Math.round((totalPaidUsd - cartTotalUsd) * 100) / 100);

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
    const sale = {
        id: crypto.randomUUID(),
        tipo: fiadoAmountUsd > 0 ? 'VENTA_FIADA' : 'VENTA',
        status: 'COMPLETADA',
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

    Object.freeze(sale);

    const existingSales = await storageService.getItem(SALES_KEY, []);
    const saleNumber = existingSales.reduce((mx, s) => Math.max(mx, s.saleNumber || 0), 0) + 1;
    const finalPersistedSale = Object.freeze({ ...sale, saleNumber });

    await storageService.setItem(SALES_KEY, [finalPersistedSale, ...existingSales]);

    // Deduct stock
    const updatedProducts = products.map(p => {
        const cartItemsForThisProduct = cart.filter(i => (i._originalId || i.id) === p.id);
        if (cartItemsForThisProduct.length > 0) {
            const totalDeducted = cartItemsForThisProduct.reduce((sum, item) => {
                if (item.isWeight) return sum + item.qty;
                if (item._mode === 'unit') return sum + (item.qty / (item._unitsPerPackage || 1));
                return sum + item.qty;
            }, 0);

            const allowNeg = localStorage.getItem('allow_negative_stock') === 'true';
            const newStock = (p.stock ?? 0) - totalDeducted;
            return { ...p, stock: allowNeg ? newStock : Math.max(0, newStock) };
        }
        return p;
    });

    let updatedCustomer = null;
    let updatedCustomers = customers;

    // Update customer debt via centralized logic
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
        updatedCustomers
    };
}

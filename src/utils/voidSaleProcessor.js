import { storageService } from './storageService';

const SALES_KEY = 'bodega_sales_v1';
const CUSTOMERS_KEY = 'bodega_customers_v1';

/**
 * Handles the logic of voiding a transaction, reverting stock, and reverting customer balances.
 */
export async function processVoidSale(sale, currentSales, currentProducts) {
    if (!sale) throw new Error("Sale object is required to void.");

    // 1. Marcar venta como ANULADA
    const updatedSales = currentSales.map(s => {
        if (s.id === sale.id) return { ...s, status: 'ANULADA' };
        return s;
    });

    // 2. Revertir Stock
    let updatedProducts = [...currentProducts];
    if (sale.items && sale.items.length > 0) {
        updatedProducts = currentProducts.map(p => {
            // Un producto puede estar múltiples veces (como unidad y paquete)
            const itemsInSale = sale.items.filter(i => (i._originalId || i.id) === p.id);
            if (itemsInSale.length > 0) {
                const totalToRestore = itemsInSale.reduce((sum, item) => {
                    if (item.isWeight) return sum + item.qty;
                    if (item._mode === 'unit') return sum + (item.qty / (item._unitsPerPackage || 1));
                    return sum + item.qty;
                }, 0);
                return { ...p, stock: (p.stock || 0) + totalToRestore };
            }
            return p;
        });
    }

    // 3. Revertir Deuda/Saldo a Favor del Cliente
    const savedCustomers = await storageService.getItem(CUSTOMERS_KEY, []);
    let updatedCustomers = savedCustomers;
    
    const fiadoAmountUsd = sale.fiadoUsd || (sale.tipo === 'VENTA_FIADA' ? sale.totalUsd : 0) || 0;
    const favorUsed = sale.payments?.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + p.amountUsd, 0) || 0;
    const debtToReverse = fiadoAmountUsd + favorUsed;

    if (sale.customerId && debtToReverse > 0) {
        updatedCustomers = savedCustomers.map(c => {
            if (c.id === sale.customerId) {
                const newDeuda = Math.max(0, (c.deuda || 0) - debtToReverse);
                console.log(`[Anular] Cliente ${c.name}: deuda ${c.deuda} -> ${newDeuda} (revertido $${debtToReverse})`);
                return { ...c, deuda: newDeuda };
            }
            return c;
        });
    }

    // 4. Guardar todo
    await storageService.setItem(SALES_KEY, updatedSales);
    await storageService.setItem(CUSTOMERS_KEY, updatedCustomers);

    return { updatedSales, updatedProducts, updatedCustomers };
}

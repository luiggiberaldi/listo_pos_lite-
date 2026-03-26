import { storageService } from './storageService';
import { procesarImpactoCliente } from './financialLogic';

/**
 * Procesa la lógica de abonar o endeudar a un cliente desde el TransactionModal.
 * Guarda en `bodega_customers_v1` y añade un registro en `bodega_sales_v1`.
 */
export async function processCustomerTransaction({
    transactionAmount, 
    currencyMode, 
    type, 
    customer, 
    paymentMethod, 
    bcvRate, 
    tasaCop, 
    copEnabled
}) {
    // 1. Convert to float and USD
    const rawAmount = parseFloat(transactionAmount);
    let amountUsd = rawAmount;
    if (currencyMode === 'BS' && bcvRate > 0) amountUsd = rawAmount / bcvRate;
    if (currencyMode === 'COP' && tasaCop > 0) amountUsd = rawAmount / tasaCop;

    // 2. Financial quadrant logic
    let transaccionOpts = {};
    if (type === 'ABONO') {
        transaccionOpts = { costoTotal: 0, pagoReal: amountUsd, vueltoParaMonedero: amountUsd };
    } else if (type === 'CREDITO') {
        transaccionOpts = { esCredito: true, deudaGenerada: amountUsd };
    }

    const updatedCustomer = procesarImpactoCliente(customer, transaccionOpts);

    // 3. Update customer storage
    const customers = await storageService.getItem('bodega_customers_v1', []);
    const newCustomers = customers.map(c => c.id === customer.id ? updatedCustomer : c);
    await storageService.setItem('bodega_customers_v1', newCustomers);

    // 4. Update sales storage
    const sales = await storageService.getItem('bodega_sales_v1', []);
    const totalEnBs = currencyMode === 'BS' ? rawAmount : (rawAmount * bcvRate);
    const totalEnUsd = amountUsd;
    const totalEnCop = currencyMode === 'COP' ? rawAmount : (amountUsd * tasaCop);

    if (type === 'ABONO') {
        const cobroRecord = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            tipo: 'COBRO_DEUDA',
            clienteId: customer.id,
            clienteName: customer.name,
            totalBs: totalEnBs,
            totalUsd: totalEnUsd,
            ...(copEnabled && { totalCop: totalEnCop }),
            paymentMethod: paymentMethod,
            items: [{ name: `Abono de deuda: ${customer.name}`, qty: 1, priceUsd: totalEnUsd, costBs: 0 }]
        };
        sales.push(cobroRecord);
    } else if (type === 'CREDITO') {
        const fiadoRecord = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            tipo: 'VENTA_FIADA',
            clienteId: customer.id,
            clienteName: customer.name,
            totalBs: totalEnBs,
            totalUsd: totalEnUsd,
            ...(copEnabled && { totalCop: totalEnCop }),
            fiadoUsd: totalEnUsd,
            items: [{ name: `Credito manual: ${customer.name}`, qty: 1, priceUsd: totalEnUsd, costBs: 0 }]
        };
        sales.push(fiadoRecord);
    }

    await storageService.setItem('bodega_sales_v1', sales);

    return { updatedCustomer, newCustomers };
}

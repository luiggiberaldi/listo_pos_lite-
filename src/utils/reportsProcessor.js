import { FinancialEngine } from '../core/FinancialEngine';
import { getLocalISODate } from './dateHelpers';

export function calculateReportsData(allSales, from, to, bcvRate, products) {
    // Ventas de Mercancía (para Totales, Profit, Top Productos)
    const salesForStats = allSales.filter(s => {
        if (s.status === 'ANULADA' || (s.tipo !== 'VENTA' && s.tipo !== 'VENTA_FIADA')) return false;
        const dateStr = getLocalISODate(new Date(s.timestamp));
        return dateStr >= from && dateStr <= to;
    });

    // Flujo de Dinero (para Desglose de Pagos, incluye pagos de deudas)
    const salesForCashFlow = allSales.filter(s => {
        if (s.status === 'ANULADA') return false;
        if (s.tipo !== 'VENTA' && s.tipo !== 'VENTA_FIADA' && s.tipo !== 'COBRO_DEUDA' && s.tipo !== 'PAGO_PROVEEDOR') return false;
        const dateStr = getLocalISODate(new Date(s.timestamp));
        return dateStr >= from && dateStr <= to;
    });

    const historySales = allSales.filter(s => {
        if (s.tipo === 'AJUSTE_ENTRADA' || s.tipo === 'AJUSTE_SALIDA') return false;
        const dateStr = getLocalISODate(new Date(s.timestamp));
        return dateStr >= from && dateStr <= to;
    });

    const totalUsd = salesForStats.reduce((s, sale) => s + (sale.totalUsd || 0), 0);
    const totalBs = salesForStats.reduce((s, sale) => s + (sale.totalBs || 0), 0);
    const totalItems = salesForStats.reduce((s, sale) => s + (sale.items ? sale.items.reduce((is, i) => is + i.qty, 0) : 0), 0);
    const profit = FinancialEngine.calculateAggregateProfit(salesForStats, bcvRate, products);
    const paymentBreakdown = FinancialEngine.calculatePaymentBreakdown(salesForCashFlow);

    // Top productos
    const productMap = {};
    salesForStats.forEach(s => {
        s.items?.forEach(item => {
            if (!productMap[item.name]) productMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
            productMap[item.name].qty += item.qty;
            productMap[item.name].revenue += item.priceUsd * item.qty;
        });
    });
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    // Ventas por día para mini gráfica
    const map = {};
    salesForStats.forEach(s => {
        const day = s.timestamp ? getLocalISODate(new Date(s.timestamp)) : getLocalISODate(new Date());
        if (!map[day]) map[day] = { date: day, total: 0, count: 0 };
        map[day].total += s.totalUsd || 0;
        map[day].count++;
    });
    const salesByDay = Object.values(map).sort((a, b) => a.date.localeCompare(b.date));

    return {
        salesForStats,
        salesForCashFlow,
        historySales,
        totalUsd,
        totalBs,
        totalItems,
        profit,
        paymentBreakdown,
        topProducts,
        salesByDay
    };
}

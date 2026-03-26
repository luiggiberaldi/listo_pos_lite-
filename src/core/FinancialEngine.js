/**
 * FinancialEngine.js
 * 
 * Centralized, pure-function mathematical engine for POS calculations.
 * ALL financial logic across the app (profits, totals, discounts, breakdowns)
 * MUST route through these functions to guarantee 100% mathematical integrity
 * and shield against UI-side modifications.
 */

export class FinancialEngine {
    
    /**
     * Calculates the true net profit of a single sale.
     * Subtracts the global cart discount and evaluates margin per item.
     * 
     * @param {Object} sale - The sale object from database
     * @param {number} bcvRate - The active BCV rate for fallback comparisons
     * @param {Array} products - The global product dictionary to resolve unknown costs
     * @returns {number} Net Profit in Bs.
     */
    static calculateSaleProfit(sale, bcvRate, products) {
        if (!sale || !sale.items || sale.items.length === 0) return 0;
        
        const saleRate = sale.rate || bcvRate;
        
        // Sum the profit of each individual item (Revenue - Cost)
        const itemsProfit = sale.items.reduce((acc, item) => {
            let costBs = 0;
            
            if (item.costUsd) {
                costBs = item.costUsd * saleRate;
            } else if (item.costBs) {
                costBs = item.costBs;
            } else {
                // Fallback: Resolve cost dynamically from the products dictionary
                const p = products.find(p => p.id === item.id || p.id === item._originalId || p.name === item.name);
                if (p) {
                    costBs = p.costUsd ? p.costUsd * saleRate : (p.costBs || 0);
                    if (item.id && typeof item.id === 'string' && item.id.endsWith('_unit')) {
                        costBs = costBs / (p.unitsPerPackage || 1);
                    }
                }
            }
            
            const itemRevenueBs = item.priceUsd * item.qty * saleRate;
            return acc + (itemRevenueBs - (costBs * item.qty));
        }, 0);

        // Subtract the global cart discount spread (represented in Bs)
        const discountBs = (sale.discountAmountUsd || 0) * saleRate;
        
        return itemsProfit - discountBs;
    }

    /**
     * Aggregates total profit for an array of sales.
     */
    static calculateAggregateProfit(salesArray, bcvRate, products) {
        return salesArray.reduce((sum, sale) => {
            return sum + this.calculateSaleProfit(sale, bcvRate, products);
        }, 0);
    }

    /**
     * Calculates the breakdown of payments received across multiple sales,
     * deducting the change returned (`changeUsd` or `changeBs`) to find the True Net Receipts.
     * 
     * @param {Array} salesArray - Array of sales to aggregate
     * @returns {Object} A dictionary mapping methodId to total amounts.
     */
    static calculatePaymentBreakdown(salesArray) {
        const breakdown = {};

        salesArray.forEach(sale => {
            // ── APERTURA DE CAJA: add opening float to cash buckets (not revenue) ──
            if (sale.tipo === 'APERTURA_CAJA') {
                if (sale.openingUsd > 0) {
                    if (!breakdown['efectivo_usd']) breakdown['efectivo_usd'] = { total: 0, currency: 'USD', label: 'Efectivo $' };
                    breakdown['efectivo_usd'].total += sale.openingUsd;
                }
                if (sale.openingBs > 0) {
                    if (!breakdown['efectivo_bs']) breakdown['efectivo_bs'] = { total: 0, currency: 'BS', label: 'Efectivo Bs' };
                    breakdown['efectivo_bs'].total += sale.openingBs;
                }
                return; // Do NOT count opening as revenue
            }

            // Fiado sales go to their own bucket — tracked in USD directly since debts hold value in $
            if (sale.tipo === 'VENTA_FIADA') {
                if (!breakdown['fiado']) {
                    breakdown['fiado'] = { total: 0, currency: 'FIADO', label: 'Fiado (Por Cobrar)' };
                }
                breakdown['fiado'].total += (sale.totalUsd || 0);
                return; // Skip normal payment processing and change deduction
            }

            // Debt collection reduces the outstanding fiado balance for the period (using USD to prevent exchange rate drift)
            if (sale.tipo === 'COBRO_DEUDA') {
                if (!breakdown['fiado']) {
                    breakdown['fiado'] = { total: 0, currency: 'FIADO', label: 'Fiado (Por Cobrar)' };
                }
                breakdown['fiado'].total -= (sale.totalUsd || 0);
                // Continue execution below to register the actual cash/transfer received
            }

            if (!sale.payments || sale.payments.length === 0) {
                // V1 Legacy Sales
                const method = sale.paymentMethod || 'efectivo_bs';
                if (!breakdown[method]) {
                    breakdown[method] = { total: 0, currency: 'BS', label: method };
                }
                breakdown[method].total += (sale.totalBs || 0);
            } else {
                // Aggregate incoming payments (V2 sales)
                sale.payments.forEach(p => {
                    if (!breakdown[p.methodId]) {
                        breakdown[p.methodId] = { 
                            total: 0, 
                            currency: p.currency || 'BS', 
                            label: p.methodLabel 
                        };
                    }

                    // Fallbacks for older V2 sales that only had p.amount
                    const amountUsd = p.amountUsd !== undefined ? p.amountUsd : (p.currency === 'USD' ? p.amount : (p.amount / (sale.rate || 36)));
                    const amountBs = p.amountBs !== undefined ? p.amountBs : (p.currency === 'BS' ? p.amount : (p.amount * (sale.rate || 36)));

                    if (p.currency === 'USD') {
                        breakdown[p.methodId].total += amountUsd || 0;
                    } else if (p.currency === 'COP') {
                        // Store native COP amount: convert back from USD using sale's tasaCop
                        breakdown[p.methodId].total += (amountUsd * (sale.tasaCop || 1)) || 0;
                    } else {
                        breakdown[p.methodId].total += amountBs || 0;
                    }
                });
            }

            // Deduct outgoing change to find True Net Income
            // Anomaly detection: if change given is absurdly larger than the sale itself, it's a data entry error (e.g., typed COP into BS field).
            let safeChangeUsd = sale.changeUsd || 0;
            let safeChangeBs = sale.changeBs || 0;
            
            // Anomaly Shield: Protect against fat fingers (e.g. $2 paid with $1000 => change $998).
            // We cap anomalies at > $100 AND > 5x the sale, to still allow $100 bills on $1 sales (change $99).
            if (safeChangeUsd > 100 && safeChangeUsd > ((sale.totalUsd || 0) * 5)) safeChangeUsd = 0;
            if (safeChangeBs > (100 * (sale.rate || 36)) && safeChangeBs > ((sale.totalBs || 0) * 5)) safeChangeBs = 0;
            
            // If the sale was completely free/zero, any outgoing change is a glitch/anomaly
            if ((sale.totalUsd || 0) === 0 && (sale.totalBs || 0) === 0) {
                safeChangeUsd = 0;
                safeChangeBs = 0;
            }

            if (safeChangeUsd > 0) {
                if (!breakdown['efectivo_usd']) breakdown['efectivo_usd'] = { total: 0, currency: 'USD', label: 'Efectivo $' };
                breakdown['efectivo_usd'].total -= safeChangeUsd;
            }
            if (safeChangeBs > 0) {
                if (!breakdown['efectivo_bs']) breakdown['efectivo_bs'] = { total: 0, currency: 'BS', label: 'Efectivo Bs' };
                breakdown['efectivo_bs'].total -= safeChangeBs;
            }
        });

        // Round all totals strictly to 2 decimals to prevent floating point drifts and filter out zeroes
        const finalBreakdown = {};
        Object.keys(breakdown).forEach(k => {
            const roundedTotal = Math.round(breakdown[k].total * 100) / 100;
            if (roundedTotal !== 0) {
                finalBreakdown[k] = { ...breakdown[k], total: roundedTotal };
            }
        });

        return finalBreakdown;
    }

    /**
     * Generates standard Checkout Cart Totals (Gross -> Discount -> Net -> Bs / COP equivalent)
     * Used exclusively BEFORE persisting a sale.
     * 
     * @param {Array} cartItems - Array of live cart items
     * @param {Object} discountData - { type: 'percentage'|'fixed', value: number }
     * @param {number} bcvRate - Exchange rate
     * @param {number} copRate - USD to COP Exchange rate
     * @returns {Object} Complete financial summary for the receipt.
     */
    static buildCartTotals(cartItems, discountData, bcvRate, copRate = 0) {
        const subtotalUsd = cartItems.reduce((sum, item) => sum + (item.priceUsd * item.qty), 0);
        
        const subtotalBs = cartItems.reduce((sum, item) => {
            if (item.exactBs != null) {
                return sum + (item.exactBs * item.qty);
            }
            return sum + (item.priceUsd * item.qty * bcvRate);
        }, 0);
        
        let discountAmountUsd = 0;
        if (discountData && discountData.value > 0) {
            if (discountData.type === 'percentage') {
                discountAmountUsd = subtotalUsd * (discountData.value / 100);
            } else if (discountData.type === 'fixed') {
                discountAmountUsd = discountData.value;
            }
        }
        
        if (discountAmountUsd > subtotalUsd) discountAmountUsd = subtotalUsd;
        
        const totalUsd = Math.max(0, subtotalUsd - discountAmountUsd);
        
        const discountAmountBs = discountAmountUsd * bcvRate;
        const totalBs = Math.max(0, subtotalBs - discountAmountBs);
        
        const totalCop = copRate > 0 ? totalUsd * copRate : 0;

        return {
            subtotalUsd,
            subtotalBs,
            discountAmountUsd,
            discountAmountBs,
            totalUsd,
            totalBs,
            totalCop
        };
    }
}

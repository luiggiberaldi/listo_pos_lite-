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
            if (!sale.payments) return;

            // Aggregate incoming payments
            sale.payments.forEach(p => {
                if (!breakdown[p.methodId]) {
                    breakdown[p.methodId] = { 
                        total: 0, 
                        currency: p.currency || 'BS', 
                        label: p.methodLabel 
                    };
                }
                const amount = (p.currency === 'USD' ? p.amountUsd : p.amountBs) || 0;
                breakdown[p.methodId].total += amount;
            });

            // Deduct outgoing change to find True Net Income
            if (sale.changeUsd > 0 && breakdown['efectivo_usd']) {
                breakdown['efectivo_usd'].total -= sale.changeUsd;
            }
            if (sale.changeBs > 0 && breakdown['efectivo_bs']) {
                breakdown['efectivo_bs'].total -= sale.changeBs;
            }
        });

        // Round all totals strictly to 2 decimals to prevent floating point drifts
        Object.keys(breakdown).forEach(k => {
            breakdown[k].total = Math.round(breakdown[k].total * 100) / 100;
        });

        return breakdown;
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

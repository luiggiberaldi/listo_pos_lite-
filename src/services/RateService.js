import { round4 } from '../utils/dinero';

/**
 * Service responsible for determining appropriate exchange rates and contexts.
 * Decouples rate logic from UI/Chat components.
 * NOTE: USDT support removed — PreciosAlDía only uses BCV rates.
 */
export const RateService = {
    /**
     * Normalizes loose currency input to standard codes.
     * @param {string} c - Currency input (e.g. "bolivares", "dolares")
     * @returns {string} - 'VES', 'EUR', or 'USD'
     */
    normalizeCurrencyCode: (c) => {
        if (!c) return 'USD';
        const upper = c.toUpperCase();
        if (['BS', 'BOLIVARES', 'BOLÍVARES', 'VES', 'BOLIVAR'].includes(upper)) return 'VES';
        if (['USDT', 'TETHER', 'BINANCE', 'TETER', 'USD', 'DOLAR', 'DOLARES', 'DÓLAR', 'DÓLARES'].includes(upper)) return 'USD';
        if (['EUR', 'EURO'].includes(upper)) return 'EUR';
        return 'USD';
    },

    /**
     * Determines the rate to use, the name of the rate, and the target currency
     * based on the input currency and desired target.
     * 
     * @param {string} currency - Normalized Source Currency (VES, USD, EUR)
     * @param {string} target - Normalized Target Currency (or null/undefined)
     * @param {object} rates - The rates object containing { bcv, euro }
     * @returns {object} { rateUsed, rateName, target }
     */
    getExchangeContext: (currency, target, rates) => {
        let rateUsed = 0;
        let rateName = '';

        // Auto-detect target if not specified
        let effectiveTarget = target;
        if (!effectiveTarget || effectiveTarget === currency) {
            effectiveTarget = currency === 'VES' ? 'USD' : 'VES';
        }

        // Map USDT to USD for backward compat
        if (currency === 'USDT') currency = 'USD';
        if (effectiveTarget === 'USDT') effectiveTarget = 'USD';

        if (currency === 'USD') {
            if (effectiveTarget === 'EUR') {
                rateUsed = rates.euro.price > 0 ? round4(rates.bcv.price / rates.euro.price) : 0;
                rateName = 'Cross (USD → EUR)';
            } else {
                rateUsed = rates.bcv.price;
                rateName = 'Tasa BCV';
                effectiveTarget = 'VES';
            }
        } else if (currency === 'EUR') {
            if (effectiveTarget === 'USD') {
                rateUsed = rates.bcv.price > 0 ? round4(rates.euro.price / rates.bcv.price) : 0;
                rateName = 'EUR → USD (Implícito)';
                effectiveTarget = 'USD';
            } else {
                rateUsed = rates.euro.price;
                rateName = 'Tasa Euro BCV';
                effectiveTarget = 'VES';
            }
        } else if (currency === 'VES') {
            if (effectiveTarget === 'EUR') {
                rateUsed = rates.euro.price > 0 ? round4(1 / rates.euro.price) : 0;
                rateName = 'Compra EUR';
            } else {
                rateUsed = rates.bcv.price > 0 ? round4(1 / rates.bcv.price) : 0;
                rateName = 'Compra USD (BCV)';
                effectiveTarget = 'USD';
            }
        }

        return { rateUsed, rateName, target: effectiveTarget };
    }
};

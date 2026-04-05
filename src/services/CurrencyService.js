import { mulR, divR } from '../utils/dinero';

/**
 * Service responsible for monetary calculations and formatting rules.
 * Follows SRP: Only handles number crunching and string formatting related to currency.
 */
export const CurrencyService = {
    /**
     * Safely parses a string or number input into a float.
     * Handles comma/dot replacements and empty strings.
     * @param {string|number} val 
     * @returns {number}
     */
    safeParse: (val) => {
        if (!val || val === '.') return 0;
        if (typeof val === 'number') return val;
        return parseFloat(val.toString().replace(/,/g, '.'));
    },

    /**
     * Applies business rules for rounding based on currency type.
     * VES: Always CEIL to integer.
     * Others: Fixed to 2 decimals.
     * @param {number} value 
     * @param {string} currencyId 
     * @returns {string}
     */
    applyRoundingRule: (value, currencyId) => {
        // Business rule: VES cash amounts are always rounded UP (ceil) to the nearest
        // integer bolivar. This is intentional — Venezuelan cash transactions do not
        // use fractional amounts, and rounding up protects the merchant from shortfall.
        if (currencyId === 'VES') return Math.ceil(value).toString();
        // Ensure we handle cases where toFixed might be needed even for small numbers
        return value.toFixed(2);
    },

    /**
     * Calculates the exchange result.
     * @param {number} amount 
     * @param {number} rateFrom 
     * @param {number} rateTo 
     * @returns {number}
     */
    calculateExchange: (amount, rateFrom, rateTo) => {
        if (!rateTo || rateTo === 0 || !rateFrom) return 0;
        return divR(mulR(amount, rateFrom), rateTo);
    }
};

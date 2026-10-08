/**
 * Utilidades para cálculo, normalización y validación de ajustes de stock.
 */

/**
 * Normaliza una cantidad según la unidad del producto (decimales para kg/litro, enteros para unidades).
 * @param {number|string} value
 * @param {string} unit
 * @returns {number}
 */
export function normalizeStockQuantity(value, unit = 'unidad') {
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(num)) return 0;

    const isDecimal = ['kg', 'litro'].includes(unit);
    return isDecimal ? Math.round(num * 1000) / 1000 : Math.round(num);
}

/**
 * Calcula el stock final resultante según el modo ('add' o 'set').
 * @param {Object} params
 * @param {number} params.currentStock
 * @param {number|string} params.inputValue
 * @param {('add'|'set')} params.mode
 * @param {string} [params.unit]
 * @param {boolean} [params.allowNegative]
 * @returns {{ targetStock: number, delta: number }}
 */
export function computeStockAdjustment({
    currentStock = 0,
    inputValue = 0,
    mode = 'add',
    unit = 'unidad',
    allowNegative = false
}) {
    const current = normalizeStockQuantity(currentStock, unit);
    const amount = normalizeStockQuantity(inputValue, unit);

    let rawTarget = current;
    let rawDelta = 0;

    if (mode === 'add') {
        rawDelta = amount;
        rawTarget = current + rawDelta;
    } else {
        rawTarget = amount;
        rawDelta = rawTarget - current;
    }

    let finalTarget = normalizeStockQuantity(rawTarget, unit);
    if (!allowNegative && finalTarget < 0) {
        finalTarget = 0;
    }

    const finalDelta = normalizeStockQuantity(finalTarget - current, unit);

    return {
        targetStock: finalTarget,
        delta: finalDelta
    };
}

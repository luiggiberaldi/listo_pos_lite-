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

/**
 * Filtra los productos que coinciden con el alcance especificado para vaciado de stock.
 * @param {Array} products
 * @param {Object} options
 * @param {('all'|'category'|'selected')} [options.scope='all']
 * @param {string} [options.category='todos']
 * @param {Set|Array} [options.selectedIds]
 * @returns {Array}
 */
export function filterProductsByZeroScope(products = [], { scope = 'all', category = 'todos', selectedIds = new Set() } = {}) {
    if (!Array.isArray(products) || products.length === 0) return [];
    if (scope === 'selected') {
        const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
        return products.filter(p => idSet.has(p.id));
    }
    if (scope === 'category') {
        if (!category || category === 'todos') return [...products];
        return products.filter(p => p.category === category);
    }
    return [...products];
}

/**
 * Coloca las existencias en 0 de los productos según el alcance definido,
 * preservando intactos todos los demás campos (nombre, precio, costo, código, categoría, etc.).
 * @param {Array} products
 * @param {Object} options
 * @returns {{ updatedProducts: Array, affectedCount: number }}
 */
export function bulkZeroProductStock(products = [], { scope = 'all', category = 'todos', selectedIds = new Set() } = {}) {
    const targets = new Set(filterProductsByZeroScope(products, { scope, category, selectedIds }).map(p => p.id));
    let affectedCount = 0;

    const updatedProducts = products.map(p => {
        if (!targets.has(p.id)) return p;
        affectedCount++;
        const updated = {
            ...p,
            stock: 0,
        };
        if (p.stockInLotes !== undefined && p.stockInLotes !== null && p.stockInLotes !== '') {
            updated.stockInLotes = 0;
        }
        return updated;
    });

    return { updatedProducts, affectedCount };
}

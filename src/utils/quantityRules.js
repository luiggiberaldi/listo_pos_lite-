/**
 * Regla única de cantidades para operaciones de inventario (Fase 2 pre-Kardex).
 *
 * Esta es la referencia conceptual compartida entre cliente y servidor:
 *   - cantidades válidas (finitas),
 *   - normalización decimal/entera según unidad,
 *   - conversión de unidad de venta a unidad de inventario,
 *   - resultado del delta (modo delta vs modo conteo),
 *   - evaluación de la política de stock negativo.
 *
 * El servidor (RPC apply_inventory_operation) reimplemeta ESTA misma regla en
 * SQL; aquí vive la semántica autoritativa para el cliente y para los tests.
 */

const DECIMAL_UNITS = ['kg', 'litro'];

export function isDecimalUnit(unit = 'unidad') {
    return DECIMAL_UNITS.includes(unit);
}

/**
 * Normaliza una cantidad según la unidad del producto
 * (kg/litro: 3 decimales; unidad/paquete: enteros). Valores no numéricos → 0.
 */
export function normalizeStockQuantity(value, unit = 'unidad') {
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(num)) return 0;
    return isDecimalUnit(unit) ? Math.round(num * 1000) / 1000 : Math.round(num);
}

/**
 * Convierte una cantidad vendida a unidad de inventario:
 *  - item por peso (isWeight): suma directa;
 *  - item con _mode 'unit' (venta por paquete): qty ÷ unidadesPorPaquete;
 *  - resto: tal cual.
 */
export function toInventoryQuantity(qty, { isWeight = false, mode = 'product', unitsPerPackage = 1 } = {}) {
    const num = typeof qty === 'number' ? qty : parseFloat(qty);
    if (!Number.isFinite(num)) return 0;
    if (isWeight) return num;
    if (mode === 'unit') return num / (unitsPerPackage > 0 ? unitsPerPackage : 1);
    return num;
}

/**
 * Resuelve el delta de una operación:
 *  - modo 'delta': quantity ya es el cambio con signo;
 *  - modo 'count': quantity es el objetivo y el delta es objetivo − actual.
 *
 * Devuelve { delta, targetStock } ya normalizados según unidad.
 */
export function resolveDelta({ mode = 'delta', quantity, currentStock = 0, unit = 'unidad' }) {
    const current = normalizeStockQuantity(currentStock, unit);
    const amount = normalizeStockQuantity(quantity, unit);
    if (mode === 'count') {
        return { delta: normalizeStockQuantity(amount - current, unit), targetStock: amount };
    }
    return { delta: amount, targetStock: normalizeStockQuantity(current + amount, unit) };
}

/**
 * Política de stock negativo. El resultado de una operación jamás se "clampea"
 * en el servidor: si la política prohíbe negativos y el objetivo queda por
 * debajo de cero, la operación es un CONFLICTO explícito y recuperable
 * (nunca se aplica, nunca se descarta en silencio).
 */
export function checkNegativePolicy(targetStock, allowNegative = true) {
    if (!allowNegative && targetStock < 0) {
        return { ok: false, conflict: 'stock_conflict', targetStock };
    }
    return { ok: true, conflict: null, targetStock };
}

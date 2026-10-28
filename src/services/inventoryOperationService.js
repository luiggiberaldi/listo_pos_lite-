/**
 * Contrato único de operación de inventario (Fase 2 pre-Kardex) — cliente.
 *
 * Toda operación que cambia stock (ajuste, conteo, vaciado, anulación…)
 * se construye AQUÍ, con un operation_id asignado ANTES del primer intento
 * online y reutilizado tal cual en reintentos: un reintento es la MISMA
 * operación, nunca una nueva.
 *
 * El servidor (RPC apply_inventory_operation vía /api/inventory-operation)
 * responde siempre con un status explícito:
 *   applied | already_processed | stock_conflict | invalid
 * El estado 'stock_conflict' es explícito y recuperable: la operación NO se
 * aplicó, NUNCA se marca como sincronizada ni se descarta; queda pendiente de
 * resolución con el saldo actual del servidor en la respuesta.
 */

import { newOperationId, resolveOperationId } from './offlineQueuePolicy.js';
import {
    checkNegativePolicy,
    normalizeStockQuantity,
    resolveDelta,
    toInventoryQuantity,
} from '../utils/quantityRules.js';

export const INVENTORY_OPERATION_TYPES = [
    'VENTA',
    'AJUSTE_DIRECTO',
    'CONTEO',
    'VACIADO',
    'ANULACION',
    'APERTURA',
];

/**
 * Construye una operación de inventario con identidad estable.
 * El operation_id se asigna aquí — ANTES de cualquier intento online — y el
 * payload resultante viaja idéntico en fallback/offline/reintentos.
 */
export function buildInventoryOperation({
    productId,
    quantity,
    mode = 'delta',
    operationType = 'AJUSTE_DIRECTO',
    unitMode = 'unidad',
    reason = null,
    originRef = null,
    accountId = null,
    deviceId = null,
    actor = null,
}) {
    if (!productId) throw new Error('productId es obligatorio');
    if (!INVENTORY_OPERATION_TYPES.includes(operationType)) {
        throw new Error(`operation_type no soportado: ${operationType}`);
    }
    const amount = normalizeStockQuantity(quantity, unitMode);
    if (!Number.isFinite(amount) || amount === 0) {
        throw new Error('quantity debe ser numérica y distinta de cero');
    }

    return {
        operation_id: newOperationId(),
        product_id: productId,
        operation_type: operationType,
        mode,
        quantity: amount,
        unit_mode: unitMode,
        reason,
        origin_ref: originRef,
        account_id: accountId,
        device_id: deviceId,
        actor,
    };
}

/**
 * Envía una operación al contrato. Reintentar significa reenviar EXACTAMENTE
 * el mismo payload (mismo operation_id); el servidor responde already_processed
 * con el resultado canónico si este o un intento anterior ya la aplicó.
 */
export async function applyInventoryOperation(operation, { fetchImpl } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch no está disponible');
    const payload = { ...operation, operation_id: resolveOperationId(operation) };

    const res = await doFetch('/api/inventory-operation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.status) {
        return { status: 'error', httpStatus: res.status, message: data.error || `HTTP ${res.status}` };
    }
    return data;
}

/** Reintento idempotente: misma operación, mismo operation_id. */
export function retryInventoryOperation(operation, options) {
    return applyInventoryOperation(operation, options);
}

/**
 * Clasifica la respuesta del contrato para la UI/cola:
 *   applied | already_processed | stock_conflict | invalid | error
 */
export function classifyInventoryResult(result) {
    const status = result?.status;
    if (['applied', 'already_processed', 'stock_conflict', 'invalid'].includes(status)) {
        return status;
    }
    return 'error';
}

/** Preview local del delta (misma regla que el servidor reimplemeta en SQL). */
export function previewOperationDelta({ mode, quantity, currentStock, unitMode = 'unidad' }) {
    const { delta, targetStock } = resolveDelta({ mode, quantity, currentStock, unit: unitMode });
    return { delta, targetStock, policy: checkNegativePolicy(targetStock, true) };
}

/** Convierte una cantidad vendida a unidad de inventario (misma regla compartida). */
export function saleLineToInventoryQuantity(qty, line) {
    return toInventoryQuantity(qty, {
        isWeight: Boolean(line?.isWeight),
        mode: line?._mode === 'unit' ? 'unit' : 'product',
        unitsPerPackage: line?.unitsPerPackage || 1,
    });
}

/**
 * Ejecuta una operación de stock ya construida contra el contrato y la
 * resume en un único resultado para la UI:
 *   confirmed → applied / already_processed; el stock_after del SERVIDOR es
 *               la única ley (sin clamps locales).
 *   conflict  → stock_conflict: nada aplicado, requiere resolución.
 *   invalid   → payload/entidad inválida: nada aplicado.
 *   pending   → sin conexión o fallo transitorio: la operación CON SU
 *               operation_id queda lista para reintentarse; el llamador la
 *               marca como pendiente, nunca como confirmada.
 */
export async function applyStockOperation(operation, { fetchImpl } = {}) {
    let data;
    try {
        data = await applyInventoryOperation(operation, { fetchImpl });
    } catch (err) {
        return { outcome: 'pending', status: 'pending', operation, error: err?.message || String(err) };
    }
    const status = classifyInventoryResult(data);
    if (status === 'applied' || status === 'already_processed') {
        return {
            outcome: 'confirmed',
            status,
            stockAfter: Number(data.stock_after),
            delta: Number(data.delta),
            operation,
            result: data,
        };
    }
    if (status === 'stock_conflict' || status === 'invalid') {
        return { outcome: status === 'stock_conflict' ? 'conflict' : 'invalid', status, operation, result: data };
    }
    return { outcome: 'pending', status: 'error', operation, result: data };
}

/** Construye y ejecuta en un paso una operación de inventario. */
export async function runStockOperation(params, options = {}) {
    let operation;
    try {
        operation = buildInventoryOperation(params);
    } catch (err) {
        return { outcome: 'invalid', status: 'invalid', error: err?.message || String(err) };
    }
    return applyStockOperation(operation, options);
}

/**
 * Operaciones de vaciado masivo: UNA operación explícita por producto con su
 * delta REAL (−stock actual). Los productos ya en 0 no generan operación.
 */
export function buildBulkZeroOperations(products, { accountId = null, deviceId = null, actor = null } = {}) {
    const operations = [];
    for (const product of products || []) {
        const current = Number(product?.stock ?? 0);
        if (!Number.isFinite(current) || current === 0) continue;
        // Negar el stock YA normalizado (no normalizar el negativo): garantiza
        // que delta + stock_normalizado = 0 exacto a la precisión de la unidad.
        const delta = -normalizeStockQuantity(current, product?.unit);
        if (delta === 0) continue;
        operations.push({
            operation_id: newOperationId(),
            product_id: product.id,
            operation_type: 'VACIADO',
            mode: 'delta',
            quantity: delta,
            unit_mode: product?.unit || 'unidad',
            reason: 'VACIADO_MASIVO',
            origin_ref: null,
            account_id: accountId,
            device_id: deviceId,
            actor,
        });
    }
    return operations;
}

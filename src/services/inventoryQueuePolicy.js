/**
 * Política de la cola offline de operaciones de inventario (Fase 4 pre-Kardex).
 *
 * Módulo PURO (sin storage ni red): define la forma de la entrada, la máquina
 * de estados frente a la respuesta del contrato y la regla de reconciliación
 * del saldo devuelto. La persistencia y el envío viven en
 * `inventoryQueueService.js`.
 *
 * Invariantes:
 *   - La entrada nace con su operation_id ANTES de cualquier intento y el
 *     comando viaja idéntico en reintentos: un reintento es la MISMA operación.
 *   - 'applied' y 'already_processed' marcan la operación como sincronizada
 *     sin reaplicar el delta. Regla A7 del repo principal: el stock local ya
 *     tiene el cambio optimista y NO se sustituye por el stock_after del
 *     servidor (que se guarda aparte como diagnóstico).
 *   - Producto desconocido para el servidor ('invalid' + "producto
 *     desconocido"): el cambio queda solo local ('local_only'), igual que en
 *     el camino en línea; no es un conflicto sin salida.
 *   - Los conflictos funcionales ('stock_conflict', 'invalid') se conservan
 *     como 'conflicted': nunca auto-reintentados ni descartados en silencio;
 *     solo una resolución explícita reactiva el MISMO operation_id.
 *   - Solo lo transitorio reintenta con backoff acotado; al agotar intentos
 *     queda 'failed' (visible, descartable solo con acción explícita).
 */

import {
    MAX_QUEUE_ATTEMPTS,
    nextRetryAt,
    toConflictedState,
} from './offlineQueuePolicy.js';

export const INVENTORY_QUEUE_KEY = 'offline_inventory_queue';

/** Confirmados: el servidor aplicó la operación (nueva o ya procesada). */
export function isConfirmedInventoryStatus(status) {
    return status === 'applied' || status === 'already_processed';
}

/**
 * Conflictos funcionales: requieren explicación y una acción administrativa
 * (corregir stock/política o vincular el producto). No se curan solos con
 * reintentos, a diferencia de los errores transitorios.
 */
export function isFunctionalInventoryStatus(status) {
    return status === 'stock_conflict' || status === 'invalid';
}

/**
 * Construye la entrada de cola con identidad estable. El operation_id se
 * normaliza aquí (y se inyecta al comando) para que TODO reintento conserve la
 * MISMA identidad, incluso el alias legacy `queue_id`. Un comando sin ID lanza:
 * el ID DEBE existir antes del primer intento (invariante de la Fase 2).
 */
export function buildInventoryQueueEntry(operation, {
    accountId = null,
    deviceId = null,
    referenceStock = null,
    now = () => new Date().toISOString(),
} = {}) {
    const operationId = operation?.queue_id || operation?.operation_id;
    if (!operationId) {
        throw new Error('operation_id es obligatorio para encolar una operación de inventario');
    }
    const reference = Number(referenceStock);
    return {
        id: operationId,
        operation_id: operationId,
        account_id: accountId,
        device_id: deviceId,
        // Comando completo: delta/unidad, modo, tipo y motivo viajan tal cual.
        operation: { ...operation, operation_id: operationId },
        // Saldo local de referencia al momento de la operación.
        reference_stock: Number.isFinite(reference) ? reference : null,
        origin: operation?.operation_type || null,
        created_at: now(),
        sync_status: 'pending',
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        conflict: null,
        remote_status: null,
        remote_delta: null,
        remote_stock_after: null,
        synced_at: null,
    };
}

/**
 * Máquina de estados de la cola: traduce la respuesta del contrato al estado
 * de la entrada SIN tocar el comando (el operation_id viaja idéntico).
 *
 *   applied | already_processed → 'synced' + saldo devuelto registrado
 *   stock_conflict | invalid    → 'conflicted' (resolución explícita)
 *   cualquier otro              → transitorio: reintento con backoff acotado
 */
export function isUnknownProductResponse(data) {
    return data?.status === 'invalid' && /desconocido/i.test(String(data?.message || ''));
}

export function applyInventoryResultToEntry(entry, data, nowISO = new Date().toISOString()) {
    const status = data?.status;
    if (isUnknownProductResponse(data)) {
        return {
            ...entry,
            sync_status: 'synced',
            synced_at: nowISO,
            next_attempt_at: null,
            last_error: null,
            remote_status: 'local_only',
            remote_delta: null,
            remote_stock_after: null,
        };
    }
    if (isConfirmedInventoryStatus(status)) {
        return {
            ...entry,
            sync_status: 'synced',
            synced_at: nowISO,
            next_attempt_at: null,
            last_error: null,
            remote_status: status,
            remote_delta: Number(data.delta),
            remote_stock_after: Number(data.stock_after),
        };
    }
    if (isFunctionalInventoryStatus(status)) {
        return toConflictedState({ ...entry, next_attempt_at: null }, data);
    }
    // Transitorio (red caída, HTTP 5xx, respuesta ilegible): reintento con
    // backoff acotado. Al agotar intentos queda 'failed', nunca se descarta.
    const attempts = (entry.attempts || 0) + 1;
    return {
        ...entry,
        attempts,
        sync_status: attempts >= MAX_QUEUE_ATTEMPTS ? 'failed' : 'pending',
        next_attempt_at: attempts >= MAX_QUEUE_ATTEMPTS ? null : nextRetryAt(attempts),
        last_error: data?.message || data?.error || 'Error transitorio de sincronización',
    };
}

/**
 * Reconciliación tras la respuesta del servidor SIN reaplicar nada.
 *
 * Regla A7 (repo principal): el cambio ya se aplicó localmente de forma
 * optimista al encolarse, y el saldo de public.products todavía no es la
 * verdad del inventario por cuenta. Por eso el stock local NO se toca: solo
 * se marca la operación como sincronizada y el stock_after del servidor se
 * guarda aparte (stockServer) como diagnóstico. Idempotente: reconciliar dos
 * veces deja el mismo estado, así un reintento tras una respuesta perdida no
 * duplica nada.
 */
export function reconcileStockAfter(products, productId, stockAfter, { localOnly = false } = {}) {
    const server = Number(stockAfter);
    return products.map(p => {
        if (p.id !== productId) return p;
        return {
            ...p,
            stockSync: localOnly ? 'local_only' : 'synced',
            ...(stockAfter !== null && stockAfter !== undefined && Number.isFinite(server) ? { stockServer: server } : {}),
        };
    });
}

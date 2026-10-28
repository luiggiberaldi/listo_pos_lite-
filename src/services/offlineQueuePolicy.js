export const MAX_QUEUE_ATTEMPTS = 10;

// Fase 1 (idempotencia): el operation_id identifica la venta desde ANTES del
// primer intento online y se reutiliza tal cual en fallback/offline/reintentos.
export function newOperationId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Un payload que ya trae su operation_id (queue_id u operation_id) NUNCA
 * recibe otro distinto: el reintento debe ser la misma operación.
 */
export function resolveOperationId(payload, generateId = newOperationId) {
    return payload?.queue_id || payload?.operation_id || generateId();
}
// Fase 2 (conflicto de stock): una venta ya cobrada que encuentra el servidor
// con stock negativo prohibido se conserva como 'conflicted'. NUNCA se marca
// sincronizada ni se descarta; solo una resolución explícita la reactiva.
export function isConflictItem(item) {
    return item?.sync_status === 'conflicted';
}

export function toConflictedState(item, conflict) {
    return {
        ...item,
        sync_status: 'conflicted',
        conflict: conflict || null,
        last_error: conflict?.message || 'Conflicto de stock (requiere resolución)',
        next_attempt_at: null,
    };
}

/**
 * Recuperación explícita: solo una acción administrativa (corregir el stock o
 * la política) reactiva el reintento — con el MISMO operation_id.
 */
export function resolveConflictForRetry(item) {
    if (!isConflictItem(item)) return item;
    return { ...item, sync_status: 'pending', attempts: 0, next_attempt_at: null };
}

// Conflictos FUNCIONALES del servidor (nunca transitorios): 'stock_conflict'
// (política de negativos) y 'unknown_product' (producto no vinculado al
// catálogo). Ambos preservan la venta, no se marcan sincronizados ni se
// descartan, y requieren resolución explícita antes del reintento.
export function isResolvableConflictStatus(status) {
    return status === 'stock_conflict' || status === 'unknown_product';
}

// Estado local de la venta según el tipo de conflicto (visible en historial).
export function conflictSaleStatus(conflict) {
    return conflict?.status === 'unknown_product' ? 'CONFLICTO_CATALOGO' : 'CONFLICTO_STOCK';
}

export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 5 * 60 * 1000;

export function retryDelayMs(attempts) {
    const exponent = Math.max(0, Number(attempts) || 0);
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
}

export function nextRetryAt(attempts, now = Date.now()) {
    return new Date(now + retryDelayMs(attempts)).toISOString();
}

export function isQueueItemDue(item, now = Date.now()) {
    if (!item || item.sync_status !== 'pending') return false;
    if (!item.next_attempt_at) return true;
    const nextAttempt = Date.parse(item.next_attempt_at);
    return Number.isNaN(nextAttempt) || nextAttempt <= now;
}

export function belongsToAccount(item, accountId) {
    return Boolean(accountId) && item?.account_id === accountId;
}

export function pruneSyncedItems(queue, now = Date.now(), retentionMs = 24 * 60 * 60 * 1000) {
    return queue.filter(item => {
        if (item.sync_status !== 'synced' || !item.synced_at) return true;
        const syncedAt = Date.parse(item.synced_at);
        return Number.isNaN(syncedAt) || now - syncedAt < retentionMs;
    });
}

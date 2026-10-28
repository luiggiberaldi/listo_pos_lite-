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
import { getAuthHeaders } from './authHeaders.js';
import {
    checkNegativePolicy,
    normalizeSaleLineQuantity,
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
    operationId = null,
    // true para cantidades derivadas de líneas de venta (anulación): se
    // conserva la fracción exacta en vez de redondear por unidad.
    exactQuantity = false,
}) {
    if (!productId) throw new Error('productId es obligatorio');
    if (!INVENTORY_OPERATION_TYPES.includes(operationType)) {
        throw new Error(`operation_type no soportado: ${operationType}`);
    }
    const amount = exactQuantity
        ? normalizeSaleLineQuantity(quantity)
        : normalizeStockQuantity(quantity, unitMode);
    if (!Number.isFinite(amount) || amount === 0) {
        throw new Error('quantity debe ser numérica y distinta de cero');
    }

    return {
        // Identidad inyectable: los flujos con reintento en otra sesión
        // (anulación, importación) derivan un ID DETERMINISTA de su clave de
        // negocio para que un reenvío sea la MISMA operación en el servidor.
        operation_id: operationId || newOperationId(),
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
export async function applyInventoryOperation(operation, { fetchImpl, authHeaders } = {}) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetch no está disponible');
    const payload = { ...operation, operation_id: resolveOperationId(operation) };

    const auth = authHeaders || (fetchImpl ? {} : await getAuthHeaders());
    const res = await doFetch('/api/inventory-operation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
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
// ── Identidad determinista (UUIDv5) para operaciones con clave de negocio ──
//
// Un reintento — o una re-ejecución tras un cuelgue — debe ser la MISMA
// operación en el servidor. Derivar el operation_id de la clave de negocio
// (venta+producto, lote de importación+producto) lo garantiza sin depender de
// estado local: el servidor responde already_processed en vez de aplicar dos
// veces.

// Namespace propio (UUID fijo) para todas las operaciones del kardex.
const KARDEX_NAMESPACE = 'b7c4e2a1-5d3f-4c8e-9a6b-1e2d3c4b5a69';

function sha1Bytes(bytes) {
    const ml = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(ml / 4294967296));
    dv.setUint32(padded.length - 4, ml >>> 0);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80);
    for (let i = 0; i < padded.length; i += 64) {
        for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
        for (let j = 16; j < 80; j++) {
            const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
            w[j] = (x << 1) | (x >>> 31);
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let j = 0; j < 80; j++) {
            let f, k;
            if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0);
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h));
    return out;
}

function uuidToBytes(uuid) {
    const hex = String(uuid).replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

/**
 * UUIDv5 determinista: mismo nombre → mismo ID, siempre, en cualquier
 * dispositivo. El dominio (anulación, importación) lo provee el llamador.
 */
export function deterministicOperationId(name, namespace = KARDEX_NAMESPACE) {
    const nsBytes = uuidToBytes(namespace);
    const nameBytes = new TextEncoder().encode(String(name));
    const input = new Uint8Array(nsBytes.length + nameBytes.length);
    input.set(nsBytes);
    input.set(nameBytes, nsBytes.length);

    const hash = sha1Bytes(input).slice(0, 16); // UUIDv5: 16 primeros bytes del hash
    hash[6] = (hash[6] & 0x0f) | 0x50; // versión 5
    hash[8] = (hash[8] & 0x3f) | 0x80; // variante RFC 4122
    const hex = [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pliega el resultado de una operación sobre el array de productos.
 *
 * Regla A7 (repo principal): mientras public.products del servidor no tenga el
 * stock real por cuenta, el saldo del servidor NO se copia sobre el stock local
 * (ver src/sync/stockResolution.js). En todos los casos el stock local es el
 * saldo que declara el llamador (o el que ya tenía el producto):
 *   confirmed → marcado 'synced' (o 'local_only' si el servidor no conoce el
 *               producto); stock_after se guarda aparte como diagnóstico;
 *   resto     → marcado 'pending' (jamás como confirmado) y encolado aparte.
 */
export function foldStockOutcome(products, productId, outcome, optimisticStock = undefined) {
    return products.map(p => {
        if (p.id !== productId) return p;
        if (outcome?.outcome === 'confirmed') {
            return {
                ...p,
                ...(optimisticStock !== undefined ? { stock: Number(optimisticStock) } : {}),
                stockSync: outcome.status === 'local_only' ? 'local_only' : 'synced',
                ...(Number.isFinite(Number(outcome.stockAfter)) && outcome.stockAfter !== null && outcome.stockAfter !== undefined
                    ? { stockServer: Number(outcome.stockAfter) }
                    : {}),
            };
        }
        return {
            ...p,
            ...(optimisticStock !== undefined ? { stock: Number(optimisticStock) } : {}),
            stockSync: 'pending',
        };
    });
}

/**
 * Plan de importación de inventario conectado al contrato (Fase 3).
 *
 * La importación JAMÁS sobrescribe stock silenciosamente: el modo lo elige el
 * usuario y toda cantidad que se aplique viaja como operación explícita
 * (APERTURA, conteo) con operation_id determinístico por (lote, modo,
 * producto), de modo que reimportar el mismo lote responde already_processed.
 *
 * Modos:
 *   keep     — mantener saldos: solo metadatos; NINGUNA cantidad cambia.
 *   opening  — corte de apertura: la cantidad importada se aplica solo a
 *              productos sin saldo local (nuevos o en 0).
 *   replace  — reemplazar cantidades: toda diferencia se aplica (incluye
 *              poner en 0, vía delta negativo).
 *
 * Devuelve { operations, changes, ignored }: las operaciones a ejecutar y los
 * planes legibles para la advertencia previa a la confirmación.
 */
export function buildImportOpeningOperations({
    importedProducts,
    currentProducts = [],
    mode = 'keep',
    batchId,
    accountId = null,
    deviceId = null,
    actor = null,
}) {
    if (!batchId) throw new Error('batchId es obligatorio para el plan de importación');
    const currentById = new Map((currentProducts || []).map(p => [p.id, p]));
    const operations = [];
    const changes = [];
    const ignored = [];

    for (const imported of importedProducts || []) {
        if (!imported?.id) continue;
        const current = currentById.get(imported.id) || null;
        const unit = current?.unit || imported.unit || 'unidad';
        const target = normalizeStockQuantity(imported?.stock ?? 0, unit);
        const local = normalizeStockQuantity(current?.stock ?? 0, unit);
        const entry = { id: imported.id, name: imported.name || 'Producto', from: local, to: target };
        const noBalance = !current || local === 0;

        const shouldApply = mode === 'replace'
            ? target !== local
            : mode === 'opening'
                ? noBalance && target !== local
                : false;

        if (!shouldApply) {
            if (target !== local) ignored.push(entry);
            continue;
        }

        // Conteo directo al objetivo; el objetivo 0 (que buildInventoryOperation
        // rechaza como delta cero) viaja como delta negativo exacto.
        const operation = target === 0
            ? buildInventoryOperation({
                productId: imported.id, quantity: -local, mode: 'delta',
                operationType: 'APERTURA', unitMode: unit,
                reason: mode === 'replace' ? 'REEMPLAZO_CATALOGO' : 'CORTE_APERTURA',
                originRef: batchId, accountId, deviceId, actor,
                operationId: deterministicOperationId(`import:${batchId}:${mode}:${imported.id}`),
            })
            : buildInventoryOperation({
                productId: imported.id, quantity: target, mode: 'count',
                operationType: 'APERTURA', unitMode: unit,
                reason: mode === 'replace' ? 'REEMPLAZO_CATALOGO' : 'CORTE_APERTURA',
                originRef: batchId, accountId, deviceId, actor,
                operationId: deterministicOperationId(`import:${batchId}:${mode}:${imported.id}`),
            });
        operations.push(operation);
        changes.push(entry);
    }

    return { operations, changes, ignored };
}

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

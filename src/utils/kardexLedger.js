/**
 * Kardex (Fase 5) — lectura de la libreta de movimientos de un producto.
 *
 * La libreta vive en inventory_operations (servidor). Esta capa pura:
 *   - recorta la libreta desde la última APERTURA (corte de apertura o alta
 *     del producto): lo anterior no se atribuye al Kardex;
 *   - arma filas legibles (tipo, entra, sale, saldo);
 *   - comprueba la regla de aceptación: saldo final = apertura + suma de
 *     movimientos, y que cada movimiento parta del saldo anterior;
 *   - separa lo PENDIENTE del dispositivo (colas sin sincronizar), que nunca
 *     se mezcla con lo confirmado por el servidor.
 */

const EPSILON = 1e-4;

export const KARDEX_TYPE_LABELS = {
    APERTURA: 'Apertura',
    VENTA: 'Venta',
    ANULACION: 'Anulación',
    AJUSTE_DIRECTO: 'Ajuste',
    CONTEO: 'Conteo',
    VACIADO: 'Vaciado',
};

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function round4(value) {
    return Math.round(value * 10000) / 10000;
}

export function kardexTypeLabel(row) {
    if (row?.operation_type === 'APERTURA' && row?.reason === 'Alta de producto') return 'Alta';
    return KARDEX_TYPE_LABELS[row?.operation_type] || row?.operation_type || 'Movimiento';
}

/**
 * @param {Array} movements filas de inventory_operations del producto (cualquier orden)
 * @returns {{started:boolean, opening:object|null, rows:Array, balance:number|null,
 *            totalIn:number, totalOut:number, consistent:boolean, gaps:Array}}
 */
export function buildKardexView(movements = []) {
    const sorted = (Array.isArray(movements) ? movements : [])
        .filter(Boolean)
        .slice()
        .sort((a, b) => num(a.id) - num(b.id));

    let start = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].operation_type === 'APERTURA') { start = i; break; }
    }
    if (start < 0) {
        return { started: false, opening: null, rows: [], balance: null, totalIn: 0, totalOut: 0, consistent: true, gaps: [] };
    }

    const book = sorted.slice(start);
    const opening = book[0];
    const rows = [];
    const gaps = [];
    let totalIn = 0;
    let totalOut = 0;
    let previousAfter = null;

    for (const m of book) {
        const isOpening = m === opening;
        const delta = num(m.delta);
        const before = num(m.stock_before);
        const after = num(m.stock_after);
        if (!isOpening) {
            if (delta > 0) totalIn += delta;
            if (delta < 0) totalOut += -delta;
            // Cada movimiento debe partir del saldo con que terminó el anterior;
            // si no, algo cambió el stock sin dejar movimiento (hueco).
            if (previousAfter !== null && Math.abs(before - previousAfter) > EPSILON) {
                gaps.push({ id: m.id, expected: round4(previousAfter), found: round4(before) });
            }
        }
        rows.push({
            id: m.id,
            type: m.operation_type,
            label: kardexTypeLabel(m),
            createdAt: m.created_at,
            entra: !isOpening && delta > 0 ? round4(delta) : null,
            sale: !isOpening && delta < 0 ? round4(-delta) : null,
            saldo: round4(after),
            reason: m.reason || null,
            ref: m.origin_ref || null,
            actor: m.actor || null,
        });
        previousAfter = after;
    }

    const openingBalance = num(opening.stock_after);
    const balance = round4(previousAfter);
    const expected = round4(openingBalance + totalIn - totalOut);
    const consistent = gaps.length === 0 && Math.abs(expected - balance) <= EPSILON;

    return {
        started: true,
        opening: { ...opening, saldo: round4(openingBalance) },
        rows,
        balance,
        totalIn: round4(totalIn),
        totalOut: round4(totalOut),
        consistent,
        gaps,
    };
}

/**
 * Movimientos del producto que el dispositivo aún no confirmó con el servidor.
 * Nunca se suman al saldo confirmado: se muestran aparte.
 */
export function pendingKardexEntries(productId, { salesQueue = [], inventoryQueue = [] } = {}) {
    if (!productId) return [];
    const out = [];

    for (const entry of Array.isArray(inventoryQueue) ? inventoryQueue : []) {
        const op = entry?.operation;
        if (!op || op.product_id !== productId || entry.sync_status === 'synced') continue;
        const quantity = num(op.quantity);
        const isCount = op.mode === 'count';
        out.push({
            key: `inv:${entry.operation_id}`,
            source: 'inventario',
            type: op.operation_type,
            label: KARDEX_TYPE_LABELS[op.operation_type] || op.operation_type,
            createdAt: entry.created_at,
            status: entry.sync_status,
            // Un conteo fija el saldo: su diferencia solo se conoce en el servidor.
            countTo: isCount ? round4(quantity) : null,
            entra: !isCount && quantity > 0 ? round4(quantity) : null,
            sale: !isCount && quantity < 0 ? round4(-quantity) : null,
        });
    }

    for (const entry of Array.isArray(salesQueue) ? salesQueue : []) {
        if (!entry || entry.sync_status === 'synced') continue;
        const cart = Array.isArray(entry.payload?.cart) ? entry.payload.cart : [];
        cart.forEach((line, index) => {
            if (line?.id !== productId) return;
            const qty = line.stock_qty != null ? num(line.stock_qty) : num(line.qty);
            out.push({
                key: `venta:${entry.queue_id}:${index}`,
                source: 'venta',
                type: 'VENTA',
                label: 'Venta',
                createdAt: entry.created_at,
                status: entry.sync_status,
                countTo: null,
                entra: null,
                sale: round4(qty),
            });
        });
    }

    return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** Lista que se envía al corte de apertura: id canónico + stock que ve el usuario. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildOpeningPayload(products = []) {
    const out = [];
    for (const p of Array.isArray(products) ? products : []) {
        if (!p || !UUID_RE.test(String(p.id || ''))) continue;
        const stock = Number(p.stock);
        out.push({ id: p.id, stock: Number.isFinite(stock) ? round4(stock) : 0 });
    }
    return out;
}

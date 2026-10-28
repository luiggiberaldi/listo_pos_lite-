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
    // productId null → pendientes de todos los productos (pantalla Movimientos).
    const matches = id => (productId == null ? Boolean(id) : id === productId);
    const out = [];

    for (const entry of Array.isArray(inventoryQueue) ? inventoryQueue : []) {
        const op = entry?.operation;
        if (!op || !matches(op.product_id) || entry.sync_status === 'synced') continue;
        const quantity = num(op.quantity);
        const isCount = op.mode === 'count';
        out.push({
            key: `inv:${entry.operation_id}`,
            productId: op.product_id,
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
            if (!matches(line?.id) || !UUID_RE.test(String(line.id))) return;
            const qty = line.stock_qty != null ? num(line.stock_qty) : num(line.qty);
            out.push({
                key: `venta:${entry.queue_id}:${index}`,
                productId: line.id,
                ref: entry.queue_id,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Pantalla Movimientos ────────────────────────────────────────────────────

/** Filtros de tipo que ve el usuario → tipos del servidor. */
export const MOVEMENT_TYPE_FILTERS = [
    { id: 'todos', label: 'Todos los tipos', types: [] },
    { id: 'ventas', label: 'Ventas', types: ['VENTA'] },
    { id: 'anulaciones', label: 'Anulaciones', types: ['ANULACION'] },
    { id: 'ajustes', label: 'Ajustes y conteos', types: ['AJUSTE_DIRECTO', 'CONTEO', 'VACIADO'] },
    { id: 'aperturas', label: 'Saldos iniciales', types: ['APERTURA'] },
];

export const DATE_PRESETS = [
    { id: 'hoy', label: 'Hoy' },
    { id: 'ayer', label: 'Ayer' },
    { id: '7dias', label: '7 días' },
    { id: 'mes', label: 'Este mes' },
    { id: 'todo', label: 'Todo' },
];

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Rango [from, to) en hora LOCAL del dispositivo, como ISO para el servidor.
 * custom: { from: 'AAAA-MM-DD', to: 'AAAA-MM-DD' } (ambos días incluidos).
 */
export function dateRangeFor(preset, now = new Date(), custom = null) {
    const today = startOfDay(now);
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    let from = null;
    let to = null;
    if (preset === 'hoy') { from = today; to = addDays(today, 1); }
    else if (preset === 'ayer') { from = addDays(today, -1); to = today; }
    else if (preset === '7dias') { from = addDays(today, -6); to = addDays(today, 1); }
    else if (preset === 'mes') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = addDays(today, 1); }
    else if (preset === 'custom' && custom) {
        const parse = s => { const [y, m, d] = String(s || '').split('-').map(Number); return y && m && d ? new Date(y, m - 1, d) : null; };
        from = parse(custom.from);
        const end = parse(custom.to);
        to = end ? addDays(end, 1) : null;
    }
    return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null };
}

/** Índice id de venta / id de operación → número de venta local (#0001023). */
export function buildSaleNumberIndex(sales = []) {
    const index = new Map();
    for (const s of Array.isArray(sales) ? sales : []) {
        if (!s?.saleNumber) continue;
        if (s.id) index.set(String(s.id), s.saleNumber);
        if (s.syncQueueId) index.set(String(s.syncQueueId), s.saleNumber);
    }
    return index;
}

export const formatSaleNumber = n => `#${String(n).padStart(7, '0')}`;

/** Cantidad en unidades + equivalente en cajas para productos por lote. */
export function formatUnits(value, product) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = round4(Number(value));
    const text = n.toLocaleString('es-VE', { maximumFractionDigits: 3 });
    const upp = Number(product?.unitsPerPackage) || 0;
    const isLote = product?.packagingType === 'lote' || product?.unit === 'paquete';
    if (isLote && upp > 1) {
        const boxes = Math.round((n / upp) * 100) / 100;
        return `${text} uds (${boxes.toLocaleString('es-VE', { maximumFractionDigits: 2 })} ${boxes === 1 ? 'caja' : 'cajas'})`;
    }
    const unit = product?.unit === 'kg' || product?.unit === 'litro' ? ` ${product.unit === 'kg' ? 'kg' : 'L'}` : '';
    return `${text}${unit}`;
}

/** Texto de detalle de un movimiento: "Venta #0001023", "Conteo físico", … */
export function describeMovement(row, { saleNumbers = new Map() } = {}) {
    const label = kardexTypeLabel(row);
    const ref = row?.origin_ref ? String(row.origin_ref) : null;
    const saleNo = ref && saleNumbers.get(ref);
    if (row?.operation_type === 'VENTA') return saleNo ? `Venta ${formatSaleNumber(saleNo)}` : 'Venta';
    if (row?.operation_type === 'ANULACION') return saleNo ? `Anulación de venta ${formatSaleNumber(saleNo)}` : 'Anulación de venta';
    if (row?.operation_type === 'APERTURA') {
        return row?.reason === 'Alta de producto' ? 'Saldo inicial (producto nuevo)' : 'Saldo inicial (inicio del Kardex)';
    }
    const reason = row?.reason ? String(row.reason).trim() : '';
    const redundant = !reason || reason.toLowerCase() === label.toLowerCase()
        || reason.toLowerCase() === String(row?.operation_type || '').toLowerCase();
    return redundant ? label : `${label} · ${reason}`;
}

/** Agrupa filas (ya ordenadas) por día local: [{ day: 'AAAA-MM-DD', rows }]. */
export function groupByDay(rows = []) {
    const groups = [];
    for (const r of rows) {
        const d = new Date(r.created_at || r.createdAt);
        const day = Number.isNaN(d.getTime()) ? 'sin-fecha'
            : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const last = groups[groups.length - 1];
        if (last && last.day === day) last.rows.push(r);
        else groups.push({ day, rows: [r] });
    }
    return groups;
}

/** CSV para Excel (separador ';', BOM UTF-8, decimales con coma). */
export function movementsToCsv(rows = [], { productsById = new Map(), saleNumbers = new Map() } = {}) {
    const cell = v => {
        const s = v == null ? '' : String(v);
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const dec = v => (v == null || v === '' ? '' : String(round4(Number(v))).replace('.', ','));
    const lines = [['Fecha', 'Hora', 'Producto', 'Movimiento', 'Entra', 'Sale', 'Saldo', 'Usuario'].join(';')];
    for (const r of rows) {
        const d = new Date(r.created_at);
        const delta = num(r.delta);
        const isOpening = r.operation_type === 'APERTURA';
        lines.push([
            d.toLocaleDateString('es-VE'),
            d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false }),
            productsById.get(r.product_id)?.name || 'Producto eliminado',
            describeMovement(r, { saleNumbers }),
            !isOpening && delta > 0 ? dec(delta) : '',
            !isOpening && delta < 0 ? dec(-delta) : '',
            dec(r.stock_after),
            r.actor || '',
        ].map(cell).join(';'));
    }
    return String.fromCharCode(0xFEFF) + lines.join('\r\n'); // BOM: Excel reconoce los acentos
}

/** Lista que se envía al corte de apertura: id canónico + stock que ve el usuario. */
export function buildOpeningPayload(products = []) {
    const out = [];
    for (const p of Array.isArray(products) ? products : []) {
        if (!p || !UUID_RE.test(String(p.id || ''))) continue;
        const stock = Number(p.stock);
        out.push({ id: p.id, stock: Number.isFinite(stock) ? round4(stock) : 0 });
    }
    return out;
}

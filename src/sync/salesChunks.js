/**
 * Ventas en sync_documents partidas por día.
 *
 * Antes el historial de ventas (30 días) viajaba como UN documento: cada venta
 * reescribía ~600 KB de JSONB en Supabase y eso agotaba el presupuesto de
 * disco (Disk IO Budget). Ahora cada día es su propio documento
 * ("bodega_sales_v1@2026-10-28") y una venta solo reescribe el de ese día.
 *
 * En el equipo nada cambia: las ventas siguen guardadas juntas en
 * 'bodega_sales_v1'. Solo la copia de la nube se reparte.
 */

export const SALES_KEY = 'bodega_sales_v1';
export const SALES_CHUNK_PREFIX = `${SALES_KEY}@`;
// Días que viajan a la nube (igual que antes). Los trozos más viejos se
// quedan en el servidor hasta que la limpieza semanal los borra.
export const SALES_SYNC_WINDOW_DAYS = 30;
const NO_DATE = 'sin-fecha';

export const isSalesChunkId = (docId) => typeof docId === 'string' && docId.startsWith(SALES_CHUNK_PREFIX);
export const salesChunkId = (day) => `${SALES_CHUNK_PREFIX}${day}`;
export const dayOfChunkId = (docId) => (isSalesChunkId(docId) ? docId.slice(SALES_CHUNK_PREFIX.length) : null);

const pad = (n) => String(n).padStart(2, '0');
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Día al que pertenece una venta. Usa la fecha comercial (la del turno) si
 * existe, así una venta de un turno que cruzó la medianoche no cambia de
 * trozo según el equipo.
 */
export function saleDay(sale) {
    const commercial = sale?.fechaComercial || sale?.businessDate;
    if (typeof commercial === 'string' && ISO_DAY.test(commercial)) return commercial;
    const t = Date.parse(sale?.timestamp || sale?.createdAt || sale?.updatedAt || '');
    return Number.isNaN(t) ? NO_DATE : localDay(new Date(t));
}

/** Primer día que todavía viaja a la nube. */
export function windowStartDay(now = new Date(), days = SALES_SYNC_WINDOW_DAYS) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - days);
    return localDay(d);
}

const saleTime = (s) => {
    const t = Date.parse(s?.timestamp || s?.createdAt || s?.updatedAt || '');
    return Number.isNaN(t) ? 0 : t;
};
const saleKey = (s) => String(s?.id ?? '');

/**
 * Orden fijo dentro de un día (hora y luego id). Cada caja guarda sus ventas
 * en su propio orden; sin esto, dos cajas veían "distinto" el mismo día y se
 * lo re-subían una a la otra sin parar.
 */
function sortDay(sales) {
    return sales.sort((a, b) => (saleTime(a) - saleTime(b)) || (saleKey(a) < saleKey(b) ? -1 : saleKey(a) > saleKey(b) ? 1 : 0));
}

/**
 * Agrupa las ventas por día, en orden fijo dentro de cada día. Los días
 * anteriores a la ventana no se incluyen (las ventas sin fecha sí, como antes).
 */
export function splitSalesByDay(sales, { now = new Date(), days = SALES_SYNC_WINDOW_DAYS } = {}) {
    const chunks = new Map();
    if (!Array.isArray(sales)) return chunks;
    const start = windowStartDay(now, days);
    for (const sale of sales) {
        const day = saleDay(sale);
        if (day !== NO_DATE && day < start) continue;
        if (!chunks.has(day)) chunks.set(day, []);
        chunks.get(day).push(sale);
    }
    for (const list of chunks.values()) sortDay(list);
    return chunks;
}

/**
 * Trozos que hay que subir: solo los días cuyo contenido cambió respecto de
 * lo que la nube ya tiene (lastHashes: docId → hash).
 */
export function changedSalesChunks(sales, lastHashes, hashFn, opts) {
    const out = [];
    for (const [day, payload] of splitSalesByDay(sales, opts)) {
        const docId = salesChunkId(day);
        const hash = hashFn(payload);
        if (lastHashes?.[docId] !== hash) out.push({ docId, day, payload, hash });
    }
    return out;
}

/** Ventas de un día dentro del arreglo local, en el mismo orden que su trozo. */
export function salesOfDay(sales, day) {
    return Array.isArray(sales) ? sortDay(sales.filter(s => saleDay(s) === day)) : [];
}

/**
 * Numeración de ventas por caja (Fase B: B6).
 *
 * Antes cada venta tomaba "el número más alto que conozco + 1": dos cajas
 * vendiendo a la vez (o una sin internet) sacaban el mismo número. Ahora cada
 * caja tiene su código (A, B, C… asignado por el servidor en account_devices)
 * y su propio contador: la venta 101 de la caja B es "B-00101".
 * Las ventas viejas (sin código) conservan su número de siempre.
 */

export const REGISTER_CODE_KEY = 'pos_register_code';
export const SALE_COUNTER_KEY = 'pos_sale_counter';

// Código provisional mientras el servidor no asigna la letra (sin internet o
// migración pendiente): 3 caracteres sacados del id del dispositivo, así nunca
// choca con las letras A…ZZ del servidor ni con otra caja.
export function fallbackRegisterCode(deviceId) {
    const clean = String(deviceId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return clean.slice(-3).padStart(3, '0');
}

export function isValidRegisterCode(code) {
    return typeof code === 'string' && /^[A-Z0-9]{1,3}$/.test(code);
}

/**
 * Siguiente número para esta caja: el mayor entre el contador guardado y las
 * ventas de esta misma caja que ya conozco, más uno.
 */
export function nextSaleNumber(sales, registerCode, storedCounter) {
    let max = 0;
    if (storedCounter && storedCounter.code === registerCode) max = Number(storedCounter.n) || 0;
    for (const s of Array.isArray(sales) ? sales : []) {
        if (s?.registerCode !== registerCode) continue;
        const n = Number(s.saleNumber) || 0;
        if (n > max) max = n;
    }
    return max + 1;
}

/** "B-00101" para ventas con caja, "0001023" para las de antes. Sin "#". */
export function formatSaleNumber(sale) {
    if (!sale || sale.saleNumber === undefined || sale.saleNumber === null || sale.saleNumber === '') return '';
    if (sale.registerCode) return `${sale.registerCode}-${String(sale.saleNumber).padStart(5, '0')}`;
    return String(sale.saleNumber).padStart(7, '0');
}

/** Etiqueta con "#", o el inicio del id si la venta no tiene número. */
export function saleNumberLabel(sale) {
    const n = formatSaleNumber(sale);
    return n ? `#${n}` : `#${String(sale?.id || '').substring(0, 6).toUpperCase()}`;
}

/** ¿La búsqueda del usuario coincide con el número de la venta? */
export function matchesSaleNumber(sale, query) {
    const q = String(query || '').toLowerCase().replace(/^#/, '');
    if (!q || !sale?.saleNumber) return false;
    return formatSaleNumber(sale).toLowerCase().includes(q) || String(sale.saleNumber).includes(q);
}

// ── Estado local de la caja (localStorage, por cuenta) ──────────────────────

export function readRegisterCode({ storage = globalThis.localStorage, scopedKey = k => k } = {}) {
    try {
        const saved = storage?.getItem(scopedKey(REGISTER_CODE_KEY));
        if (isValidRegisterCode(saved)) return saved;
    } catch { /* sin acceso */ }
    let deviceId = '';
    try { deviceId = storage?.getItem('pda_device_id') || ''; } catch { /* sin acceso */ }
    return fallbackRegisterCode(deviceId);
}

export function readSaleCounter({ storage = globalThis.localStorage, scopedKey = k => k } = {}) {
    try { return JSON.parse(storage?.getItem(scopedKey(SALE_COUNTER_KEY)) || 'null'); } catch { return null; }
}

export function writeSaleCounter(code, n, { storage = globalThis.localStorage, scopedKey = k => k } = {}) {
    try { storage?.setItem(scopedKey(SALE_COUNTER_KEY), JSON.stringify({ code, n })); } catch { /* sin cuota */ }
}

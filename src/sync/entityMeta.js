import { canonicalStringify } from './syncHash.js';

/**
 * Metadatos de versión por registro (Fase B: B1, B2, B3).
 *
 * Cada producto, cliente, venta, etc. lleva:
 *   updatedAt — cuándo cambió por última vez (reloj del dispositivo)
 *   rev       — contador de versiones (sube en cada cambio)
 *   updatedBy — dispositivo que hizo el cambio
 *   deletedAt — si existe, el registro está BORRADO (lápida): no se muestra,
 *               pero viaja a las otras cajas para que no "resucite".
 *
 * Se aplican en UN solo lugar (storageService.setItem): se compara la lista
 * nueva con la guardada y solo los registros que cambiaron se marcan. Así
 * ninguna pantalla puede olvidarse de hacerlo.
 */

export const META_FIELDS = ['updatedAt', 'rev', 'updatedBy', 'deletedAt'];

// Listas sincronizadas cuyos registros llevan metadatos y lápidas. Las mismas
// que se mezclan registro por registro al llegar de la nube (incluye inventario).
export const ENTITY_KEYS = [
    'bodega_products_v1',
    'bodega_customers_v1',
    'bodega_sales_v1',
    'bodega_cierres_v1',
    'bodega_payment_methods_v1',
    'bodega_accounts_v2',
    'my_categories_v1',
    'bodega_suppliers_v1',
    'bodega_supplier_invoices_v1',
];
export const TOMBSTONE_TTL_DAYS = 90;
// Vaciar de golpe una lista con al menos tantos registros se trata como
// sospechoso (p. ej. una carga fallida que guarda []), salvo permiso explícito.
export const MASS_DELETE_MIN = 10;

export function entityId(item) {
    const id = item?.id ?? item?.cierreId;
    return id === null || id === undefined ? null : String(id);
}

export const isTombstone = (item) => Boolean(item?.deletedAt);

/** Registros vivos (lo que ven las pantallas). */
export function alive(arr) {
    return Array.isArray(arr) ? arr.filter(item => !isTombstone(item)) : arr;
}

function contentOf(item) {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };
    for (const f of META_FIELDS) delete copy[f];
    return copy;
}

export function sameContent(a, b) {
    return canonicalStringify(contentOf(a)) === canonicalStringify(contentOf(b));
}

export function touch(entity, { deviceId = 'unknown', now = new Date().toISOString(), prev } = {}) {
    const base = prev || entity;
    const { deletedAt: _drop, ...rest } = entity;
    return { ...rest, updatedAt: now, updatedBy: deviceId, rev: (Number(base?.rev) || 0) + 1 };
}

export function tombstone(entity, { deviceId = 'unknown', now = new Date().toISOString() } = {}) {
    return { ...entity, updatedAt: now, updatedBy: deviceId, rev: (Number(entity?.rev) || 0) + 1, deletedAt: now };
}

/**
 * Compara la lista guardada (con lápidas) con la que la app quiere guardar
 * (normalmente solo vivos) y devuelve la lista a persistir:
 *  - igual contenido → conserva sus metadatos (no sube de versión);
 *  - cambiado o nuevo → touch();
 *  - desaparecido → lápida;
 *  - lápidas viejas (> TTL) se purgan.
 * Si la app vacía de golpe una lista grande sin `allowMassDelete`, NO se
 * borra nada: devuelve { blocked: true } y la lista anterior intacta.
 */
export function stampChanges(prevRaw, nextList, {
    deviceId = 'unknown',
    now = new Date().toISOString(),
    allowMassDelete = false,
    ttlDays = TOMBSTONE_TTL_DAYS,
} = {}) {
    const prev = Array.isArray(prevRaw) ? prevRaw : [];
    if (!Array.isArray(nextList)) return { list: nextList, blocked: false, changed: true };

    const prevById = new Map();
    for (const item of prev) {
        const id = entityId(item);
        if (id !== null) prevById.set(id, item);
    }

    const nextLiveCount = nextList.filter(item => !isTombstone(item)).length;
    const prevLiveCount = prev.filter(item => !isTombstone(item)).length;
    if (!allowMassDelete && nextLiveCount === 0 && prevLiveCount >= MASS_DELETE_MIN) {
        return { list: prev, blocked: true, changed: false };
    }

    const out = [];
    const seen = new Set();
    let changed = false;
    for (const item of nextList) {
        const id = entityId(item);
        if (id === null) { out.push(item); continue; }
        if (seen.has(id)) continue; // ids duplicados: gana el primero
        seen.add(id);
        const before = prevById.get(id);
        if (isTombstone(item)) {
            // La app (o una cola interna) ya entrega una lápida: se respeta.
            if (before && isTombstone(before) && sameContent(before, item)) out.push(before);
            else { out.push(item.rev ? item : tombstone(item, { deviceId, now })); changed = true; }
            continue;
        }
        if (before && !isTombstone(before) && sameContent(before, item)) {
            out.push(before); // sin cambios: mismos metadatos
        } else {
            out.push(touch(item, { deviceId, now, prev: before }));
            changed = true;
        }
    }

    const cutoff = Date.parse(now) - ttlDays * 24 * 60 * 60 * 1000;
    for (const [id, before] of prevById) {
        if (seen.has(id)) continue;
        if (isTombstone(before)) {
            const t = Date.parse(before.deletedAt);
            if (Number.isNaN(t) || t >= cutoff) out.push(before); // lápida vigente
            else changed = true; // purga
        } else {
            out.push(tombstone(before, { deviceId, now }));
            changed = true;
        }
    }
    return { list: out, blocked: false, changed };
}

function versionTime(item) {
    return item?.updatedAt || item?.timestamp || item?.createdAt || '';
}

/** true si `b` gana sobre `a` (regla determinista, igual en todas las cajas). */
export function newer(a, b) {
    const ta = Date.parse(versionTime(a));
    const tb = Date.parse(versionTime(b));
    const na = Number.isNaN(ta) ? -Infinity : ta;
    const nb = Number.isNaN(tb) ? -Infinity : tb;
    if (na !== nb) return nb > na;
    const ra = Number(a?.rev) || 0;
    const rb = Number(b?.rev) || 0;
    if (ra !== rb) return rb > ra;
    // A igual versión, una lápida gana: un borrado no debe perderse por empate.
    if (isTombstone(a) !== isTombstone(b)) return isTombstone(b);
    const ua = String(a?.updatedBy || '');
    const ub = String(b?.updatedBy || '');
    if (ua !== ub) return ub > ua;
    return canonicalStringify(b) > canonicalStringify(a);
}

/**
 * Une la copia local y la de la nube registro por registro: gana la versión
 * más nueva de cada uno (B3). Una lápida más nueva que la versión viva gana,
 * así un borrado hecho en otra caja no resucita. Registros sin id se conservan
 * de ambos lados sin duplicar.
 */
export function mergeEntities(localArr, cloudArr, { localOnlyFields = [] } = {}) {
    if (!Array.isArray(localArr) || !Array.isArray(cloudArr)) return cloudArr;
    const byId = new Map();
    const order = [];
    const noId = [];
    const noIdSeen = new Set();
    const addNoId = (item) => {
        const k = canonicalStringify(item);
        if (!noIdSeen.has(k)) { noIdSeen.add(k); noId.push(item); }
    };
    for (const item of localArr) {
        const id = entityId(item);
        if (id === null) { addNoId(item); continue; }
        if (!byId.has(id)) order.push(id);
        byId.set(id, item);
    }
    for (const item of cloudArr) {
        const id = entityId(item);
        if (id === null) { addNoId(item); continue; }
        const existing = byId.get(id);
        if (!existing) { byId.set(id, item); order.push(id); continue; }
        const cloudWins = hasVersion(existing) || hasVersion(item)
            ? newer(existing, item)
            // Datos anteriores a la Fase B (sin versión en ninguna copia): regla de
            // siempre, la nube gana salvo que la copia local sea más reciente.
            : !(Date.parse(versionTime(existing)) > Date.parse(versionTime(item)));
        if (cloudWins) byId.set(id, keepLocalOnlyFields(existing, item, localOnlyFields));
    }
    return [...order.map(id => byId.get(id)), ...noId];
}

const hasVersion = (item) => Boolean(item?.rev);

// Campos que nunca viajan a la nube (p. ej. la foto del producto, que se quita
// antes de subir): si gana la versión de la nube se conserva el valor local.
function keepLocalOnlyFields(local, winner, fields) {
    if (!fields.length || isTombstone(winner)) return winner;
    let out = winner;
    for (const f of fields) {
        if (local?.[f] !== undefined && winner?.[f] === undefined) out = { ...out, [f]: local[f] };
    }
    return out;
}

export function getDeviceId(storage = globalThis.localStorage) {
    try { return storage?.getItem('pda_device_id') || 'unknown'; } catch { return 'unknown'; }
}

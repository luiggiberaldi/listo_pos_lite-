/**
 * Cursor del polling de sync_documents (A2).
 *
 * El cursor es el MAYOR updated_at asignado por el servidor (trigger de la
 * migración 009), nunca la hora local: con relojes desfasados entre equipos la
 * hora local descartaba cambios de otro dispositivo.
 */

// Compara dos timestamps del servidor. Postgres devuelve microsegundos y recorta
// ceros finales ("…00.5+00:00"), JS usa milisegundos con "Z": se compara por
// instante y, a igual milisegundo, por texto (los microsegundos desempatan).
export function compareIso(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta < tb ? -1 : 1;
    if (a === b) return 0;
    return String(a) < String(b) ? -1 : 1;
}

export function maxIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return compareIso(b, a) > 0 ? b : a;
}

export function shiftIso(iso, deltaMs) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : new Date(t + deltaMs).toISOString();
}

/** Desde dónde pedir metadatos: el cursor menos un margen para commits fuera de orden. */
export function cursorQueryFrom(cursor, marginMs) {
    return cursor ? shiftIso(cursor, -marginMs) : null;
}

/**
 * Clasifica los metadatos recibidos (doc_id + updated_at).
 * - Lo que subió este mismo equipo (ownUpdatedAt) o ya se aplicó (seenUpdatedAt)
 *   no se vuelve a descargar.
 * - El resto son cambios de OTRO dispositivo (foreignIds).
 * Devuelve el cursor candidato y las marcas de "visto" de los pushes propios.
 */
export function classifyChangedMeta(metaRows, { cursor = null, ownUpdatedAt = {}, seenUpdatedAt = {} } = {}) {
    let newCursor = cursor;
    const foreignIds = [];
    const ownSeen = {};
    for (const meta of metaRows || []) {
        newCursor = maxIso(newCursor, meta.updated_at);
        if (ownUpdatedAt[meta.doc_id] === meta.updated_at) {
            ownSeen[meta.doc_id] = meta.updated_at;
            continue;
        }
        if (seenUpdatedAt[meta.doc_id] === meta.updated_at) continue;
        foreignIds.push(meta.doc_id);
    }
    return { foreignIds, newCursor, ownSeen };
}

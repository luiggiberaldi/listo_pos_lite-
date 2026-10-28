/**
 * Huella del payload para deduplicar pushes.
 *
 * Antes solo se miraba longitud + 300 caracteres, de modo que un cambio que no
 * alteraba la longitud y caía fuera de esas ventanas (ej. stock 12 -> 13) se
 * consideraba "sin cambios" y NUNCA se subía a la nube.
 *
 * Ahora se recorre el string completo con dos hashes FNV-1a/djb2 independientes
 * (64 bits efectivos) más la longitud. Es síncrono y no depende del navegador.
 */
export function computePushHash(serialized) {
    const s = typeof serialized === 'string' ? serialized : String(serialized ?? '');
    let h1 = 0x811c9dc5;
    let h2 = 5381;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193);
        h2 = (Math.imul(h2, 33) ^ c) | 0;
    }
    return `${s.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

/**
 * JSON canónico (llaves ordenadas). Postgres jsonb reordena las llaves de los
 * objetos, así que el JSON que vuelve de la nube nunca coincide byte a byte con
 * el local; sin canonizar, la deduplicación por hash jamás reconocía lo que la
 * nube ya tenía y todo se re-subía en cada arranque.
 */
export function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/** Huella de un payload (string crudo u objeto) independiente del orden de llaves. */
export function hashPayload(value) {
    if (typeof value === 'string') return computePushHash(value);
    return computePushHash(canonicalStringify(value));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { clearDirty, isRealChange, localIsNewer, markDirty, readCleanHashes, readDirty, setCleanHash } from '../src/sync/dirtyKeys.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    size: () => m.size,
  };
}

const A = 'account:aaa:_sync_dirty_keys';
const B = 'account:bbb:_sync_dirty_keys';

test('abrir sin internet y vender 3 veces: la llave queda pendiente, no se descarta', () => {
  const s = memoryStorage();
  markDirty(s, A, 'bodega_sales_v1', '2026-10-27T12:00:01.000Z');
  markDirty(s, A, 'bodega_sales_v1', '2026-10-27T12:00:02.000Z');
  markDirty(s, A, 'bodega_products_v1', '2026-10-27T12:00:03.000Z');
  // Persistido: sobrevive a "recargar" (otra lectura del mismo storage).
  assert.deepEqual(readDirty(s, A), {
    bodega_sales_v1: '2026-10-27T12:00:02.000Z',
    bodega_products_v1: '2026-10-27T12:00:03.000Z',
  });
});

test('la marca solo se borra si nadie volvió a cambiar la llave mientras se subía', () => {
  const s = memoryStorage();
  const ts1 = markDirty(s, A, 'bodega_sales_v1', '2026-10-27T12:00:01.000Z');
  markDirty(s, A, 'bodega_sales_v1', '2026-10-27T12:00:09.000Z'); // venta nueva durante el push
  assert.equal(clearDirty(s, A, 'bodega_sales_v1', ts1), false);
  assert.ok(readDirty(s, A).bodega_sales_v1, 'la venta nueva sigue pendiente');
  assert.equal(clearDirty(s, A, 'bodega_sales_v1', '2026-10-27T12:00:09.000Z'), true);
  assert.deepEqual(readDirty(s, A), {});
  assert.equal(s.size(), 0, 'sin pendientes no queda basura en storage');
});

test('las marcas son por cuenta: otra cuenta no hereda pendientes', () => {
  const s = memoryStorage();
  markDirty(s, A, 'bodega_customers_v1', '2026-10-27T12:00:01.000Z');
  assert.deepEqual(readDirty(s, B), {});
  assert.equal(clearDirty(s, B, 'bodega_customers_v1'), false);
  assert.ok(readDirty(s, A).bodega_customers_v1);
});

test('un valor corrupto en storage no rompe el sync', () => {
  const s = memoryStorage();
  s.setItem(A, '{no es json');
  assert.deepEqual(readDirty(s, A), {});
  s.setItem(A, '["lista"]');
  assert.deepEqual(readDirty(s, A), {});
  markDirty(s, A, 'theme', '2026-10-27T12:00:01.000Z');
  assert.deepEqual(readDirty(s, A), { theme: '2026-10-27T12:00:01.000Z' });
});

test('el cambio local pendiente gana solo si es posterior a la versión de la nube', () => {
  assert.equal(localIsNewer('2026-10-27T12:00:10.000Z', '2026-10-27T12:00:05.123456+00:00'), true);
  assert.equal(localIsNewer('2026-10-27T12:00:01.000Z', '2026-10-27T12:00:05+00:00'), false);
  assert.equal(localIsNewer(undefined, '2026-10-27T12:00:05+00:00'), false);
  assert.equal(localIsNewer('2026-10-27T12:00:01.000Z', null), true);
});

test('re-guardar lo mismo que tiene la nube no es un cambio (auto-guardado al abrir)', () => {
  assert.equal(isRealChange({ hash: 'h1', cleanHash: 'h1', ready: false }), false);
  assert.equal(isRealChange({ hash: 'h1', cleanHash: 'h1', ready: true }), false);
});

test('antes del pull y sin huella previa no se marca: datos viejos nunca le ganan a la nube', () => {
  assert.equal(isRealChange({ hash: 'h1', cleanHash: undefined, ready: false }), false);
  assert.equal(isRealChange({ hash: 'h1', cleanHash: undefined, ready: true }), true);
});

test('un cambio real sin internet (huella distinta) queda pendiente aunque no haya pull', () => {
  assert.equal(isRealChange({ hash: 'h2', cleanHash: 'h1', ready: false }), true);
});

test('la huella de la nube se guarda por cuenta y no reescribe si no cambió', () => {
  const s = memoryStorage();
  let writes = 0;
  const counted = { ...s, setItem: (k, v) => { writes++; s.setItem(k, v); } };
  setCleanHash(counted, 'account:aaa:_sync_clean_hash', 'theme', 'h1');
  setCleanHash(counted, 'account:aaa:_sync_clean_hash', 'theme', 'h1');
  assert.equal(writes, 1);
  assert.deepEqual(readCleanHashes(s, 'account:aaa:_sync_clean_hash'), { theme: 'h1' });
  assert.deepEqual(readCleanHashes(s, 'account:bbb:_sync_clean_hash'), {});
});

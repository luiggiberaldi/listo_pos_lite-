import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSetString, mergeEntities } from '../src/sync/entityMeta.js';
import { CATALOG_BATCH_SIZE, pushChangedCatalog } from '../src/services/catalogSyncService.js';

const cats = [
  { id: 'todos', label: 'Todos' },
  { id: 'motor', label: 'Motor' },
  { id: 'frenos', label: 'Frenos' },
];

test('misma lista en distinto orden → misma huella (sin ida y vuelta entre cajas)', () => {
  const otraCaja = [cats[2], cats[0], cats[1]];
  assert.equal(canonicalSetString(cats), canonicalSetString(otraCaja));
  // Lo que hace el motor al recibir de la nube: mezcla y conserva el orden local.
  const merged = mergeEntities(otraCaja, cats);
  assert.deepEqual(merged.map(c => c.id), ['frenos', 'todos', 'motor']);
  assert.equal(canonicalSetString(merged), canonicalSetString(cats), 'no hay nada que re-subir');
});

test('un cambio real sí cambia la huella', () => {
  const editada = [cats[0], { id: 'motor', label: 'Motor y caja' }, cats[2]];
  assert.notEqual(canonicalSetString(editada), canonicalSetString(cats));
  assert.notEqual(canonicalSetString([...cats, { id: 'nueva', label: 'Nueva' }]), canonicalSetString(cats));
});

function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function fakeServer({ reject = [] } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.products);
    const rejected = body.products.filter(p => reject.includes(p.id)).map(p => ({ id: p.id, reason: 'x' }));
    return { json: async () => ({ status: 'ok', created: [], updated: [], rejected }) };
  };
  return { calls, fetchImpl };
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (n, extra = {}) => ({ id: uuid(n), name: `P${n}`, priceUsdt: 1, stock: 5, ...extra });

test('catálogo: la primera vez sube todo en tandas; después solo lo que cambió', async () => {
  const storage = memoryStorage();
  const products = Array.from({ length: CATALOG_BATCH_SIZE + 20 }, (_, i) => product(i));
  const first = fakeServer();
  const r1 = await pushChangedCatalog(products, { storage, fetchImpl: first.fetchImpl });
  assert.equal(r1.status, 'ok');
  assert.deepEqual(first.calls.map(c => c.length), [CATALOG_BATCH_SIZE, 20]);

  // Una venta solo cambia el stock: no se reenvía nada.
  const afterSale = products.map((p, i) => (i === 3 ? { ...p, stock: 4 } : p));
  const second = fakeServer();
  const r2 = await pushChangedCatalog(afterSale, { storage, fetchImpl: second.fetchImpl });
  assert.equal(r2.sent, 0);
  assert.equal(second.calls.length, 0);

  // Cambio de precio y producto nuevo: solo esos dos.
  const edited = [...afterSale.map((p, i) => (i === 7 ? { ...p, priceUsdt: 2 } : p)), product(9999)];
  const third = fakeServer();
  await pushChangedCatalog(edited, { storage, fetchImpl: third.fetchImpl });
  assert.deepEqual(third.calls.flat().map(p => p.id).sort(), [uuid(7), uuid(9999)].sort());
});

test('catálogo: lo rechazado o lo que falló se reintenta la próxima vez', async () => {
  const storage = memoryStorage();
  const products = [product(1), product(2)];
  await pushChangedCatalog(products, { storage, ...fakeServer({ reject: [uuid(2)] }) });
  const again = fakeServer();
  await pushChangedCatalog(products, { storage, fetchImpl: again.fetchImpl });
  assert.deepEqual(again.calls.flat().map(p => p.id), [uuid(2)]);

  const failing = { fetchImpl: async () => ({ json: async () => ({ status: 'error' }) }) };
  const storage2 = memoryStorage();
  const r = await pushChangedCatalog(products, { storage: storage2, ...failing });
  assert.equal(r.status, 'error');
  const retry = fakeServer();
  await pushChangedCatalog(products, { storage: storage2, fetchImpl: retry.fetchImpl });
  assert.equal(retry.calls.flat().length, 2);
});

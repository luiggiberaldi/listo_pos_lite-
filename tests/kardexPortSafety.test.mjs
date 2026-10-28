// Salvaguardas del port de staging/ al repo (pre-Kardex, 2026-10-28):
// compatibilidad con clientes anteriores, cuenta tomada del token, catálogo
// autenticado, líneas libres en las migraciones y salida automática para
// productos aún no registrados en el servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { resyncLocalCatalog } from '../src/services/catalogSyncService.js';

const ENV = { SUPABASE_SERVICE_KEY: 'service-key', ASSETS: { fetch: () => new Response('asset') } };
const UUID = '0b6c1f9e-2a4d-4c3b-9f1e-1234567890ab';

function req(path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://listo-pos-lite.vercel.app${path}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return calls;
}

const authed = (rpcResult = { success: true, sale_id: 's1' }) => url => {
  if (url.includes('/auth/v1/user')) return Response.json({ id: 'user-real' });
  if (url.includes('/rest/v1/sales?')) return Response.json([]);
  if (url.includes('/rest/v1/products')) return new Response(null, { status: 201 });
  return Response.json(rpcResult);
};

// queue_id distinto por prueba: el Worker recuerda en memoria las operaciones ya procesadas.
const checkoutBody = (cart, queueId) => ({ total: 2, cart, payments: [{ methodId: 'efectivo_usd', amountUsd: 2 }], queue_id: queueId, account_id: 'user-ajeno' });

test('checkout de cliente NUEVO (con stock_qty): sin upsert de productos y cuenta del token', async () => {
  const calls = stubFetch(authed());
  const res = await worker.fetch(req('/api/checkout', {
    token: 'ok', body: checkoutBody([{ id: UUID, qty: 1, stock_qty: 1, priceUsd: 2 }], '1b6c1f9e-2a4d-4c3b-9f1e-000000000001'),
  }), ENV);
  assert.equal(res.status, 200);
  assert.equal(calls.filter(c => c.url.endsWith('/rest/v1/products')).length, 0, 'no crea productos fantasma');
  const rpc = calls.find(c => c.url.includes('/rpc/process_checkout'));
  const payload = JSON.parse(rpc.init.body).payload;
  assert.equal(payload.account_id, 'user-real', 'la política de negativos se elige por la cuenta del token');
  assert.equal(payload.cart[0].stock_qty, 1, 'stock_qty se reenvía a la RPC');
});

test('checkout de cliente ANTERIOR (sin stock_qty): conserva el upsert legacy para no perder la venta', async () => {
  const calls = stubFetch(authed());
  const res = await worker.fetch(req('/api/checkout', {
    token: 'ok', body: checkoutBody([{ id: UUID, qty: 1, priceUsd: 2, name: 'Café' }], '1b6c1f9e-2a4d-4c3b-9f1e-000000000002'),
  }), ENV);
  assert.equal(res.status, 200);
  const upsert = calls.find(c => c.url.endsWith('/rest/v1/products'));
  assert.ok(upsert, 'el cliente viejo mantiene el registro previo de productos');
  assert.deepEqual(JSON.parse(upsert.init.body).map(p => p.id), [UUID]);
});

test('catalog-sync exige sesión y llama a sync_product_catalog', async () => {
  let calls = stubFetch(() => Response.json({}));
  let res = await worker.fetch(req('/api/catalog-sync', { body: { products: [{ id: UUID, name: 'X' }] } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);

  calls = stubFetch(url => url.includes('/auth/v1/user') ? Response.json({ id: 'user-real' }) : Response.json({ status: 'ok' }));
  res = await worker.fetch(req('/api/catalog-sync', { token: 'ok', body: { products: [{ id: UUID, name: 'X' }] } }), ENV);
  assert.equal(res.status, 200);
  assert.ok(calls.some(c => c.url.includes('/rpc/sync_product_catalog')));
});

test('resyncLocalCatalog sube el catálogo local y solo confirma con status ok', async () => {
  const pushed = [];
  const ok = await resyncLocalCatalog({
    loadProducts: async () => [{ id: UUID, name: 'Café', stock: 3 }],
    push: async products => { pushed.push(products); return { status: 'ok' }; },
  });
  assert.equal(ok, true);
  assert.equal(pushed.length, 1);

  assert.equal(await resyncLocalCatalog({ loadProducts: async () => [], push: async () => ({ status: 'ok' }) }), false);
  assert.equal(await resyncLocalCatalog({
    loadProducts: async () => [{ id: UUID, name: 'X' }],
    push: async () => { throw new Error('red caída'); },
  }), false, 'un fallo de red no rompe la cola');
});

for (const file of ['011_checkout_linked_products_and_catalog_sync.sql', '012_checkout_inventory_quantity.sql']) {
  test(`${file}: las líneas libres (Venta Libre / IDs legacy) no bloquean la venta`, () => {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    assert.ok(!sql.includes("'reason', 'id no-UUID'"), 'un id no-UUID ya no es unknown_product');
    assert.match(sql, /VALUES \(new_sale_id, NULL, v_qty, v_unit_price, v_qty \* v_unit_price\)/, 'se registra sin producto');
    assert.match(sql, /CONTINUE WHEN item->>'id' IS NULL OR item->>'id' !~\*/, 'fuera de la validación de negativos');
    assert.match(sql, /'untracked_lines', v_untracked/);
  });
}

test('migraciones 010-012: sin operaciones destructivas', () => {
  for (const file of ['010_checkout_negative_stock_policy.sql', '011_checkout_linked_products_and_catalog_sync.sql', '012_checkout_inventory_quantity.sql']) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE)\b/i, file);
  }
});

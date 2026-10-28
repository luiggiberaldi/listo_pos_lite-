import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ENV = { SUPABASE_SERVICE_KEY: 'service-key', ASSETS: { fetch: () => new Response('asset') } };

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

test('checkout sin token responde 401 y NO toca la base de datos', async () => {
  const calls = stubFetch(() => Response.json({}));
  const res = await worker.fetch(req('/api/checkout', { body: { total: 1, cart: [] } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('inventory-operation sin token responde 401 y NO toca la base de datos', async () => {
  const calls = stubFetch(() => Response.json({}));
  const res = await worker.fetch(req('/api/inventory-operation', { body: { operation_id: 'x' } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('token invalido responde 401', async () => {
  stubFetch((url) => url.includes('/auth/v1/user') ? new Response('{}', { status: 401 }) : Response.json({}));
  const res = await worker.fetch(req('/api/checkout', { token: 'malo', body: { total: 1, cart: [] } }), ENV);
  assert.equal(res.status, 401);
});

test('inventory-operation con token valido fuerza account_id del token (ignora el del payload)', async () => {
  const calls = stubFetch((url) => url.includes('/auth/v1/user')
    ? Response.json({ id: 'user-real' })
    : Response.json({ status: 'applied' }));
  const res = await worker.fetch(
    req('/api/inventory-operation', { token: 'ok', body: { operation_id: 'op-1', account_id: 'user-ajeno' } }), ENV);
  assert.equal(res.status, 200);
  const rpc = calls.find(c => c.url.includes('/rpc/apply_inventory_operation'));
  assert.ok(rpc, 'debe llamar a la RPC');
  assert.equal(JSON.parse(rpc.init.body).payload.account_id, 'user-real');
});

test('CORS permite la cabecera Authorization', async () => {
  stubFetch(() => Response.json({}));
  const res = await worker.fetch(new Request('https://listo-pos-lite.vercel.app/api/checkout', {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }), ENV);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

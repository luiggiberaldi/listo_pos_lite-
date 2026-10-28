import test from 'node:test';
import assert from 'node:assert/strict';
import { computePushHash } from '../src/sync/syncHash.js';

function makeProducts(n = 500) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p-${i}`, name: `Producto ${i}`, price: 1.5, stock: 12, category: 'viveres',
  }));
}

test('el hash cambia con cualquier edicion de un producto, en cualquier posicion', () => {
  const base = makeProducts();
  const baseHash = computePushHash(JSON.stringify(base));
  let missed = 0;
  for (let i = 0; i < base.length; i++) {
    const copy = structuredClone(base);
    copy[i].stock = 13; // misma longitud de texto: el caso que el hash viejo no detectaba
    if (computePushHash(JSON.stringify(copy)) === baseHash) missed++;
  }
  assert.equal(missed, 0, `cambios de stock no detectados: ${missed}`);
});

test('el hash detecta cambios de precio y nombre de la misma longitud', () => {
  const base = makeProducts();
  const baseHash = computePushHash(JSON.stringify(base));
  const copy = structuredClone(base);
  copy[250].price = 1.6;
  assert.notEqual(computePushHash(JSON.stringify(copy)), baseHash);
  const copy2 = structuredClone(base);
  copy2[250].name = 'Producto 2X0';
  assert.notEqual(computePushHash(JSON.stringify(copy2)), baseHash);
});

test('el hash es estable para el mismo contenido', () => {
  const a = JSON.stringify(makeProducts(50));
  assert.equal(computePushHash(a), computePushHash(String(a)));
});

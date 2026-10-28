import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalStock, isUnknownProductResult } from '../src/sync/stockResolution.js';

test('delta: aplica sobre el stock LOCAL, no sobre el saldo del servidor', () => {
  // producto con 40 uds locales, servidor con saldo basura (2): +5 debe dar 45
  assert.equal(resolveLocalStock({ currentStock: 40, operation: { mode: 'delta', quantity: 5 }, status: 'applied' }), 45);
});

test('count: el conteo fija el valor absoluto', () => {
  assert.equal(resolveLocalStock({ currentStock: 40, operation: { mode: 'count', quantity: 12 }, status: 'applied' }), 12);
});

test('already_processed no vuelve a aplicar el delta (reintento idempotente)', () => {
  assert.equal(resolveLocalStock({ currentStock: 45, operation: { mode: 'delta', quantity: 5 }, status: 'already_processed' }), 45);
});

test('kg usa 3 decimales y unidad enteros', () => {
  assert.equal(resolveLocalStock({ currentStock: 1.1, operation: { mode: 'delta', quantity: 0.2 }, status: 'applied', unit: 'kg' }), 1.3);
  assert.equal(resolveLocalStock({ currentStock: 3, operation: { mode: 'delta', quantity: -1 }, status: 'applied', unit: 'unidad' }), 2);
});

test('producto desconocido en el servidor se reconoce para aplicarlo localmente', () => {
  assert.equal(isUnknownProductResult({ outcome: 'invalid', result: { message: 'producto desconocido' } }), true);
  assert.equal(isUnknownProductResult({ outcome: 'invalid', result: { message: 'quantity no es numérica' } }), false);
  assert.equal(isUnknownProductResult({ outcome: 'conflict' }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  deterministicOperationId,
  buildInventoryOperation,
  foldStockOutcome,
} from '../src/services/inventoryOperationService.js';
import {
  computeRestockByProduct,
  buildVoidRestockOperations,
} from '../src/utils/voidSaleCore.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Identidad determinista (UUIDv5) ──

test('deterministicOperationId implementa UUIDv5 (verificado contra node:crypto)', () => {
  // Oráculo independiente: UUIDv5 = SHA-1(namespace + nombre), primeros 16
  // bytes, con versión 5 y variante RFC 4122.
  const ns = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
  const input = Buffer.concat([
    Buffer.from(ns.replace(/-/g, ''), 'hex'),
    Buffer.from('www.example.com', 'utf8'),
  ]);
  const h = crypto.createHash('sha1').update(input).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h].map(b => b.toString(16).padStart(2, '0')).join('');
  const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  assert.equal(deterministicOperationId('www.example.com', ns), expected);
  assert.match(expected, /-5[0-9a-f]{3}-[89ab]/i, 'versión 5 y variante RFC 4122');
});

test('deterministicOperationId es estable, única por nombre y con forma de UUID', () => {
  const a = deterministicOperationId('void:sale_1:p1');
  const b = deterministicOperationId('void:sale_1:p1');
  const c = deterministicOperationId('void:sale_1:p2');

  assert.equal(a, b, 'el mismo nombre produce SIEMPRE el mismo ID');
  assert.notEqual(a, c, 'nombres distintos producen IDs distintos');
  assert.match(a, UUID_RE);
});

// ── Cálculo de restitución ──

test('computeRestockByProduct suma peso, paquetes y unidades con la fórmula del checkout', () => {
  const sale = {
    id: 'sale_1',
    items: [
      { id: 'p1', qty: 2 },                                                    // producto simple
      { id: 'p2', qty: 3.2, isWeight: true },                                  // peso: suma directa
      { id: 'p3', qty: 4, _mode: 'unit', _unitsPerPackage: 2 },                // paquete: 4/2 = 2
      { id: 'p1', qty: 1 },                                                    // mismo producto otra línea
      { id: 'p9', _originalId: 'p8', qty: 5 },                                 // identidad original
    ],
  };
  const restock = computeRestockByProduct(sale);

  assert.equal(restock.get('p1'), 3);
  assert.equal(restock.get('p2'), 3.2);
  assert.equal(restock.get('p3'), 2);
  assert.equal(restock.get('p8'), 5, 'el _originalId manda sobre el id de la línea');
});

// ── Operaciones de restitución ──

test('buildVoidRestockOperations genera UNA operación ANULACION por producto con origin_ref', () => {
  const sale = {
    id: 'sale_42',
    items: [
      { id: 'p1', qty: 2 },
      { id: 'p2', qty: 3, isWeight: true },
    ],
  };
  const products = [
    { id: 'p1', name: 'Café', stock: 4, unit: 'unidad' },
    { id: 'p2', name: 'Carne', stock: 1.5, unit: 'kg' },
    { id: 'p3', name: 'Otro', stock: 9, unit: 'unidad' },
  ];

  const ops = buildVoidRestockOperations(sale, products, { accountId: 'acc', actor: 'u1' });

  assert.equal(ops.length, 2, 'solo los productos presentes en la venta y el catálogo');
  const [op1, op2] = ops;

  assert.equal(op1.operation_type, 'ANULACION');
  assert.equal(op1.origin_ref, 'sale_42', 'asociada a la venta original');
  assert.equal(op1.mode, 'delta');
  assert.equal(op1.quantity, 2);
  assert.equal(op1.product_id, 'p1');
  assert.equal(op1.reason, 'ANULACION_VENTA');
  assert.equal(op1.account_id, 'acc');
  assert.equal(op1.actor, 'u1');

  assert.equal(op2.product_id, 'p2');
  assert.equal(op2.quantity, 3, 'peso viaja tal cual (kg: 3 decimales)');
  assert.equal(op2.unit_mode, 'kg');
});

test('la identidad de la restitución es determinista: re-ejecutar NO repone dos veces', () => {
  const sale = { id: 'sale_7', items: [{ id: 'p1', qty: 2 }, { id: 'p2', qty: 1 }] };
  const products = [
    { id: 'p1', name: 'A', stock: 0, unit: 'unidad' },
    { id: 'p2', name: 'B', stock: 0, unit: 'unidad' },
  ];

  const first = buildVoidRestockOperations(sale, products);
  const retry = buildVoidRestockOperations(sale, products);

  assert.deepEqual(
    retry.map(o => o.operation_id),
    first.map(o => o.operation_id),
    'un reintento o una re-ejecución tras un cuelgue reenvía los MISMOS IDs'
  );
  assert.notEqual(first[0].operation_id, first[1].operation_id);

  // La restitución es el espejo exacto del descuento: sin redondear a paquetes.
  const unitSale = { id: 'sale_8', items: [{ id: 'p3', qty: 3, _mode: 'unit', _unitsPerPackage: 2 }] };
  const unitProducts = [{ id: 'p3', name: 'Pack', stock: 0, unit: 'paquete' }];
  const [op] = buildVoidRestockOperations(unitSale, unitProducts);
  assert.equal(op.quantity, 1.5, '3 uds de un paquete de 2 reponen 1.5 paquetes, no 2');
});

test('venta parcial de paquete: la anulación repone la fracción exacta que se descontó', () => {
  const products = [{ id: 'p3', name: 'Caja x12', stock: 4, unit: 'paquete' }];

  const half = { id: 'sale_half', items: [{ id: 'p3', qty: 6, _mode: 'unit', _unitsPerPackage: 12 }] };
  const [opHalf] = buildVoidRestockOperations(half, products);
  assert.equal(opHalf.quantity, 0.5, '6 de 12 uds → 0.5 paquete (antes reponía 1)');

  const third = { id: 'sale_third', items: [{ id: 'p3', qty: 4, _mode: 'unit', _unitsPerPackage: 12 }] };
  const ops = buildVoidRestockOperations(third, products);
  assert.equal(ops.length, 1, '4 de 12 uds sí genera restitución (antes se redondeaba a 0 y se perdía)');
  assert.equal(ops[0].quantity, 0.3333, 'precisión del servidor: numeric(15,4)');

  // Restitución local optimista y operación del servidor coinciden.
  const local = computeRestockByProduct(half).get('p3');
  assert.equal(opHalf.quantity, local);

  // Paquetes completos siguen siendo enteros.
  const whole = { id: 'sale_whole', items: [{ id: 'p3', qty: 24, _mode: 'unit', _unitsPerPackage: 12 }] };
  assert.equal(buildVoidRestockOperations(whole, products)[0].quantity, 2);
});

test('los ajustes manuales siguen redondeando por unidad', () => {
  const op = buildInventoryOperation({ productId: 'p3', quantity: 1.6, unitMode: 'paquete' });
  assert.equal(op.quantity, 2);
});

test('sin producto en el catálogo o sin cantidad restaurable no se genera operación', () => {
  const sale = {
    id: 'sale_9',
    items: [
      { id: 'desaparecido', qty: 4 },
      { id: 'p1', qty: 0 },
    ],
  };
  const products = [{ id: 'p1', name: 'A', stock: 1, unit: 'unidad' }];
  assert.deepEqual(buildVoidRestockOperations(sale, products), []);
});

// ── Plegado de resultados del contrato ──

test('foldStockOutcome (A7): confirmed marca synced sin copiar el saldo del servidor; lo demás queda pending', () => {
  const products = [
    { id: 'p1', name: 'A', stock: 5, stockSync: 'pending' },
    { id: 'p2', name: 'B', stock: 1 },
  ];

  const confirmed = foldStockOutcome(products, 'p1', { outcome: 'confirmed', stockAfter: 7.5 });
  assert.equal(confirmed[0].stock, 5, 'el stock local se conserva (ya incluye la restitución)');
  assert.equal(confirmed[0].stockSync, 'synced');
  assert.equal(confirmed[0].stockServer, 7.5, 'el saldo del servidor queda como diagnóstico');

  const withTarget = foldStockOutcome(products, 'p1', { outcome: 'confirmed', stockAfter: 2 }, 9);
  assert.equal(withTarget[0].stock, 9, 'confirmado con objetivo declarado (importación)');

  const localOnly = foldStockOutcome(products, 'p1', { outcome: 'confirmed', status: 'local_only' });
  assert.equal(localOnly[0].stockSync, 'local_only');
  assert.equal(localOnly[0].stockServer, undefined);

  const pending = foldStockOutcome(products, 'p1', { outcome: 'pending' }, 9);
  assert.equal(pending[0].stock, 9, 'optimista declarado por el llamador');
  assert.equal(pending[0].stockSync, 'pending', 'jamás confirmado sin el servidor');

  const conflicted = foldStockOutcome(products, 'p1', { outcome: 'conflict' });
  assert.equal(conflicted[0].stock, 5, 'sin optimista declarado conserva el saldo');
  assert.equal(conflicted[0].stockSync, 'pending');

  assert.deepEqual(confirmed[1], products[1], 'los demás productos no se tocan');
});

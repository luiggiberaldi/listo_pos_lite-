import test from 'node:test';
import assert from 'node:assert/strict';

import { saleLineStockQuantity } from '../src/utils/quantityRules.js';
import { buildVoidRestockOperations, computeRestockByProduct } from '../src/utils/voidSaleCore.js';

test('stock_qty: venta suelta de una caja se envía en cajas, no en unidades', () => {
  assert.equal(saleLineStockQuantity({ qty: 6, _mode: 'unit', _unitsPerPackage: 12 }), 0.5);
  assert.equal(saleLineStockQuantity({ qty: 4, _mode: 'unit', _unitsPerPackage: 12 }), 0.3333);
  assert.equal(saleLineStockQuantity({ qty: 24, _mode: 'unit', _unitsPerPackage: 12 }), 2);
});

test('stock_qty: productos normales y por peso no cambian', () => {
  assert.equal(saleLineStockQuantity({ qty: 3 }), 3);
  assert.equal(saleLineStockQuantity({ qty: 1.25, isWeight: true }), 1.25);
  assert.equal(saleLineStockQuantity({ qty: 2, _mode: 'unit', _unitsPerPackage: 0 }), 2, 'sin tamaño de paquete válido → 1');
});

test('stock_qty del checkout = restitución de la anulación (descontar y reponer se cancelan)', () => {
  const items = [
    { id: 'p1', qty: 6, _mode: 'unit', _unitsPerPackage: 12 },
    { id: 'p2', qty: 1.25, isWeight: true },
    { id: 'p3', qty: 4, _mode: 'unit', _unitsPerPackage: 12 },
  ];
  const products = [
    { id: 'p1', stock: 5, unit: 'paquete' },
    { id: 'p2', stock: 5, unit: 'kg' },
    { id: 'p3', stock: 5, unit: 'paquete' },
  ];
  const ops = buildVoidRestockOperations({ id: 'sale_x', items }, products);
  for (const item of items) {
    const op = ops.find(o => o.product_id === item.id);
    assert.equal(op.quantity, saleLineStockQuantity(item), `${item.id}: reponer = descontar`);
  }
  // El descuento local usa la misma fórmula (antes de la precisión del servidor).
  const local = computeRestockByProduct({ items });
  assert.equal(local.get('p1'), saleLineStockQuantity(items[0]));
});

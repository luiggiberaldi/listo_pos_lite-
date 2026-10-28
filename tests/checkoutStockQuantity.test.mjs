import test from 'node:test';
import assert from 'node:assert/strict';

import { saleLineStockQuantity, lineUnitsPerPackage } from '../src/utils/quantityRules.js';
import { buildVoidRestockOperations, computeRestockByProduct } from '../src/utils/voidSaleCore.js';

// Producto por lote tal como lo guarda productProcessor: stock en UNIDADES.
const caja12 = { id: 'p1', unit: 'paquete', packagingType: 'lote', unitsPerPackage: 12, stock: 60 };
// Líneas tal como las arma SalesView (spread del producto + metadatos del carrito).
const suelta = n => ({ ...caja12, id: 'p1_unit', _originalId: 'p1', _mode: 'unit', _unitsPerPackage: 12, qty: n });
const cajas = n => ({ ...caja12, id: 'p1', _originalId: 'p1', _mode: 'package', _unitsPerPackage: 12, qty: n });

test('stock_qty: unidades sueltas descuentan unidades y cajas descuentan cajas × 12', () => {
  assert.equal(saleLineStockQuantity(suelta(7)), 7, '7 sueltas → 7 (antes 0.5833)');
  assert.equal(saleLineStockQuantity(cajas(1)), 12, '1 caja → 12 (antes 1)');
  assert.equal(saleLineStockQuantity(cajas(2)), 24);
});

test('stock_qty: productos normales y por peso no cambian', () => {
  assert.equal(saleLineStockQuantity({ qty: 3, unit: 'unidad', _mode: 'package', _unitsPerPackage: 1 }), 3);
  assert.equal(saleLineStockQuantity({ qty: 1.25, isWeight: true, unit: 'kg' }), 1.25);
  assert.equal(lineUnitsPerPackage({ unit: 'unidad', unitsPerPackage: 12 }), 1, 'solo los lotes tienen caja');
});

test('venta nueva: descontar y anular se cancelan exactamente', () => {
  const items = [suelta(7), cajas(1)];
  // Lo que guarda checkoutProcessor en la venta.
  const saleItems = items.map(i => ({ id: i.id, _originalId: i._originalId, _mode: i._mode, stockQty: saleLineStockQuantity(i), qty: i.qty }));
  const descontado = items.reduce((s, i) => s + saleLineStockQuantity(i), 0);
  assert.equal(descontado, 19);
  assert.equal(computeRestockByProduct({ items: saleItems }, [caja12]).get('p1'), 19);
  const [op] = buildVoidRestockOperations({ id: 'v1', items: saleItems }, [caja12]);
  assert.equal(op.quantity, 19);
});

test('venta vieja (sin stockQty): repone lo que descontó la regla anterior, sin inventar stock', () => {
  // Así guardaba la línea suelta la versión anterior: id …_unit, sin _originalId ni _mode.
  const vieja = { id: 'v-old', items: [{ id: 'p1_unit', qty: 6 }, { id: 'p1', qty: 1 }] };
  // Antes: 6 sueltas descontaban 0.5 y 1 caja descontaba 1 → total 1.5.
  assert.equal(computeRestockByProduct(vieja, [caja12]).get('p1'), 1.5);
  const ops = buildVoidRestockOperations(vieja, [caja12]);
  assert.equal(ops.length, 1, 'la línea suelta ya no se pierde por su id …_unit');
  assert.equal(ops[0].product_id, 'p1');
  assert.equal(ops[0].quantity, 1.5);
});

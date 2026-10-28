import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImportOpeningOperations,
  deterministicOperationId,
} from '../src/services/inventoryOperationService.js';

const CURRENT = [
  { id: 'p1', name: 'Café', stock: 3, unit: 'unidad' },
  { id: 'p2', name: 'Agua', stock: 5, unit: 'unidad' },
  { id: 'p4', name: 'Vacio', stock: 0, unit: 'unidad' },
];

const IMPORTED = [
  { id: 'p1', name: 'Café importado', stock: 7, unit: 'unidad' },
  { id: 'p2', name: 'Agua', stock: 0, unit: 'unidad' },
  { id: 'p3', name: 'Nuevo', stock: 4, unit: 'unidad' },
  { id: 'p4', name: 'Vacio', stock: 6, unit: 'unidad' },
];

function plan(mode) {
  return buildImportOpeningOperations({
    importedProducts: IMPORTED,
    currentProducts: CURRENT,
    mode,
    batchId: '123456',
  });
}

test('keep: mantener saldos — NINGUNA cantidad cambia, solo se listan las diferencias', () => {
  const { operations, changes, ignored } = plan('keep');

  assert.equal(operations.length, 0, 'el modo keep jamás genera operaciones de stock');
  assert.equal(changes.length, 0);
  // p1 (3→7), p2 (5→0), p3 (nuevo 0→4), p4 (0→6): diferencias conservadas
  // con el saldo local.
  assert.deepEqual(ignored.map(e => e.id).sort(), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(ignored.find(e => e.id === 'p1'), { id: 'p1', name: 'Café importado', from: 3, to: 7 });
});

test('opening: corte de apertura solo para productos sin saldo local', () => {
  const { operations, changes, ignored } = plan('opening');

  // p3 (nuevo) y p4 (local 0) reciben su saldo de apertura; p1/p2 tienen saldo.
  assert.deepEqual(operations.map(o => o.product_id).sort(), ['p3', 'p4']);
  assert.deepEqual(changes.map(e => e.id).sort(), ['p3', 'p4']);
  assert.deepEqual(ignored.map(e => e.id).sort(), ['p1', 'p2']);

  for (const op of operations) {
    assert.equal(op.operation_type, 'APERTURA');
    assert.equal(op.mode, 'count', 'el saldo de apertura viaja como conteo al objetivo');
    assert.equal(op.reason, 'CORTE_APERTURA');
    assert.equal(op.origin_ref, '123456', 'asociado al lote de importación');
    assert.match(op.operation_id, /^[0-9a-f-]{36}$/i);
  }
  assert.equal(operations.find(o => o.product_id === 'p4').quantity, 6);
});

test('replace: toda diferencia se aplica vía el contrato, incluye volver a 0', () => {
  const { operations, changes, ignored } = plan('replace');

  assert.equal(operations.length, 4);
  assert.equal(changes.length, 4);
  assert.equal(ignored.length, 0);

  const byProduct = new Map(operations.map(o => [o.product_id, o]));
  assert.equal(byProduct.get('p1').mode, 'count');
  assert.equal(byProduct.get('p1').quantity, 7);
  assert.equal(byProduct.get('p1').reason, 'REEMPLAZO_CATALOGO');

  // Objetivo 0: el contrato exige cantidad ≠ 0, viaja como delta negativo exacto.
  const zero = byProduct.get('p2');
  assert.equal(zero.mode, 'delta');
  assert.equal(zero.quantity, -5);
  assert.equal(zero.operation_type, 'APERTURA');

  assert.equal(byProduct.get('p3').quantity, 4);
});

test('la identidad del lote es determinista: reimportar el mismo lote es idempotente', () => {
  const first = plan('replace');
  const retry = plan('replace');

  assert.deepEqual(
    retry.operations.map(o => o.operation_id),
    first.operations.map(o => o.operation_id),
    'mismo lote + modo + producto → MISMOS operation_id (already_processed en el reintento)'
  );

  const otherMode = plan('opening');
  const replaceIds = new Set(first.operations.map(o => o.operation_id));
  for (const op of otherMode.operations) {
    assert.equal(replaceIds.has(op.operation_id), false, 'modos distintos no colisionan con los IDs');
  }
  assert.equal(
    otherMode.operations[0]?.operation_id,
    deterministicOperationId('import:123456:opening:p3')
  );
});

test('el plan exige lote y respeta las unidades del producto', () => {
  assert.throws(
    () => buildImportOpeningOperations({ importedProducts: [], currentProducts: [], mode: 'keep' }),
    /batchId/
  );

  const { operations } = buildImportOpeningOperations({
    importedProducts: [{ id: 'k1', name: 'Queso', stock: 2.5, unit: 'kg' }],
    currentProducts: [{ id: 'k1', name: 'Queso', stock: 1, unit: 'kg' }],
    mode: 'replace',
    batchId: 'abc',
  });
  assert.equal(operations[0].quantity, 2.5, 'kg conserva 3 decimales');
  assert.equal(operations[0].unit_mode, 'kg');
});

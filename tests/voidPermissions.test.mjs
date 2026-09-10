import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVoidModalMessage,
  buildVoidModalTitle,
  canVoidSale,
  getVoidOptionsForSale,
  isPostClosureReversal,
  isVoidBlockedByClosure,
} from '../src/utils/voidPermissions.js';

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

test('gating matrix: only an admin with the toggle can void a closed sale', () => {
  const closed = { id: 's-1', tipo: 'VENTA', cajaCerrada: true };
  const open = { id: 's-2', tipo: 'VENTA', cajaCerrada: false };

  // Cerrada:
  assert.equal(canVoidSale(closed, { isAdmin: true, allowAfterCierre: false }), false);
  assert.equal(canVoidSale(closed, { isAdmin: true, allowAfterCierre: true }), true);
  assert.equal(canVoidSale(closed, { isAdmin: false, allowAfterCierre: true }), false);
  // Abierta:
  assert.equal(canVoidSale(open, { isAdmin: true, allowAfterCierre: false }), true);
  assert.equal(canVoidSale(open, { isAdmin: false, allowAfterCierre: true }), false);
});

test('gating: reversos, already-voided sales and missing sales can never be voided', () => {
  const reverso = { id: 'v-1', tipo: 'ANULACION_VENTA', cajaCerrada: false };
  const relatedVoid = { id: 's-1', tipo: 'VENTA', relatedVoidId: 'v-1' };
  const voidedAt = { id: 's-2', tipo: 'VENTA', voidedAt: '2026-09-10T00:00:00.000Z' };
  const anulada = { id: 's-3', tipo: 'VENTA', status: 'ANULADA' };

  for (const sale of [reverso, relatedVoid, voidedAt, anulada]) {
    assert.equal(canVoidSale(sale, { isAdmin: true, allowAfterCierre: true }), false);
  }
  assert.equal(canVoidSale(null, { isAdmin: true, allowAfterCierre: true }), false);
});

test('isVoidBlockedByClosure is driven by the closure stamp', () => {
  assert.equal(isVoidBlockedByClosure({ cajaCerrada: true }), true);
  assert.equal(isVoidBlockedByClosure({ cajaCerrada: false }), false);
  assert.equal(isVoidBlockedByClosure({}), false);
  assert.equal(isVoidBlockedByClosure(null), false);
});

test('options mapping: open sales get no overrides; closed sales read the toggles', () => {
  const open = { cajaCerrada: false };
  const closed = { cajaCerrada: true };

  assert.deepEqual(getVoidOptionsForSale(open, makeStore()), {});

  // Defaults conservadores: sin claves => skip everything.
  assert.deepEqual(getVoidOptionsForSale(closed, makeStore()), {
    skipRestock: true,
    skipRevertMoney: true,
  });

  // Toggles en true => revertir todo.
  const permissive = makeStore({ void_cierre_restock: 'true', void_cierre_revert_money: 'true' });
  assert.deepEqual(getVoidOptionsForSale(closed, permissive), {
    skipRestock: false,
    skipRevertMoney: false,
  });

  // Solo restock activado.
  const restockOnly = makeStore({ void_cierre_restock: 'true' });
  assert.deepEqual(getVoidOptionsForSale(closed, restockOnly), {
    skipRestock: false,
    skipRevertMoney: true,
  });
});

test('modal honesty: pre-cierre message promises stock and money reverts', () => {
  const message = buildVoidModalMessage({ cajaCerrada: false }, {});
  assert.match(message, /Devolverá el stock a la bodega/);
  assert.match(message, /Revertirá deudas o saldos a favor/);
  assert.doesNotMatch(message, /NO se modifican/);
});

test('modal honesty: post-cierre message matches the active settings (4 combos)', () => {
  const sale = { cajaCerrada: true };

  const bothOff = buildVoidModalMessage(sale, { restock: false, revertMoney: false });
  assert.match(bothOff, /NO tocará el inventario/);
  assert.match(bothOff, /NO tocará deudas/);

  const restockOnly = buildVoidModalMessage(sale, { restock: true, revertMoney: false });
  assert.match(restockOnly, /Devolverá el stock de los productos/);
  assert.match(restockOnly, /NO tocará deudas/);

  const moneyOnly = buildVoidModalMessage(sale, { restock: false, revertMoney: true });
  assert.match(moneyOnly, /NO tocará el inventario/);
  assert.match(moneyOnly, /Revertirá deudas y saldos a favor/);

  const bothOn = buildVoidModalMessage(sale, { restock: true, revertMoney: true });
  assert.match(bothOn, /Devolverá el stock de los productos/);
  assert.match(bothOn, /Revertirá deudas y saldos a favor/);
});

test('modal honesty: post-cierre message always discloses closure immutability', () => {
  const sale = { cajaCerrada: true };
  for (const opts of [
    { restock: false, revertMoney: false },
    { restock: true, revertMoney: false },
    { restock: false, revertMoney: true },
    { restock: true, revertMoney: true },
  ]) {
    const message = buildVoidModalMessage(sale, opts);
    assert.match(message, /NO se modifican/);
    assert.match(message, /corrección histórica/);
  }
});

test('isPostClosureReversal: solo reversos de ventas ya cerradas por caja', () => {
  const ventaCerrada = { id: 's-1', tipo: 'VENTA', cajaCerrada: true };
  const ventaAbierta = { id: 's-2', tipo: 'VENTA', cajaCerrada: false };

  const reversoPostCierre = { tipo: 'ANULACION_VENTA', originSaleId: 's-1' };
  const reversoNormal = { tipo: 'ANULACION_VENTA', originSaleId: 's-2' };
  const reversoHuerfano = { tipo: 'ANULACION_VENTA', originSaleId: 's-404' };

  assert.equal(isPostClosureReversal(reversoPostCierre, [ventaCerrada, ventaAbierta]), true);
  assert.equal(isPostClosureReversal(reversoNormal, [ventaCerrada, ventaAbierta]), false);
  assert.equal(isPostClosureReversal(reversoHuerfano, [ventaCerrada, ventaAbierta]), false);
  assert.equal(isPostClosureReversal(ventaCerrada, [ventaCerrada]), false);
  assert.equal(isPostClosureReversal(null, []), false);
  assert.equal(isPostClosureReversal(reversoPostCierre, null), false);
});

test('modal title prefers the sale number and pads it', () => {
  assert.equal(buildVoidModalTitle({ saleNumber: 42, id: 'abc123def' }), 'Anular venta #0000042');
  assert.equal(buildVoidModalTitle({ id: 'abc123def' }), 'Anular venta #ABC123');
  assert.equal(buildVoidModalTitle(null), 'Anular venta');
});

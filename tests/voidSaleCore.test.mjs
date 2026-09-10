import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoidMutation } from '../src/utils/voidSaleCore.js';
import { ALLOW_VOID_AFTER_CIERRE_KEY, VOID_CIERRE_RESTOCK_KEY, VOID_CIERRE_REVERT_MONEY_KEY } from '../src/utils/voidPermissions.js';

const NOW = new Date('2026-09-10T14:30:00.000Z');

function makeProduct(id, stock) {
  return { id, name: `Producto ${id}`, stock };
}

function makeSale(overrides = {}) {
  return {
    id: 'sale-1',
    saleNumber: 42,
    tipo: 'VENTA',
    status: 'COMPLETADA',
    timestamp: '2026-09-09T22:10:00.000Z',
    fechaComercial: '2026-09-09',
    totalUsd: 10,
    totalBs: 7643.49,
    rate: 764.3486,
    items: [
      { id: 'p-1', name: 'Harina', qty: 2, priceUsd: 3, costUsd: 1 },
      { id: 'p-2', name: 'Café', qty: 1, priceUsd: 4, costUsd: 2 },
    ],
    payments: [{ methodId: 'efectivo_usd', amount: 10, amountUsd: 10, amountBs: 7643.49 }],
    ...overrides,
  };
}

function baseState() {
  return {
    sales: [makeSale()],
    products: [makeProduct('p-1', 5), makeProduct('p-2', 3)],
    customers: [{ id: 'c-1', name: 'Luisa', deuda: 20, favor: 0, saldo_favor: 0 }],
  };
}

test('pre-cierre void: restocks inventory (including weight and unit-mode items)', () => {
  const state = baseState();
  state.products.push({ id: 'p-3', name: 'Queso', stock: 1 });
  const sale = makeSale({
    items: [
      { id: 'p-1', name: 'Harina', qty: 2, priceUsd: 3, costUsd: 1 },
      { id: 'p-3', name: 'Queso', qty: 0.5, priceUsd: 6, costUsd: 3, isWeight: true },
      { id: 'p-2', name: 'Café', qty: 6, priceUsd: 4, costUsd: 2, _mode: 'unit', _unitsPerPackage: 3 },
    ],
  });
  state.sales = [sale];

  const { updatedProducts, voidTransaction } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: [],
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const byId = Object.fromEntries(updatedProducts.map(p => [p.id, p]));
  assert.equal(byId['p-1'].stock, 7); // 5 + 2
  assert.equal(byId['p-3'].stock, 1.5); // weight adds qty as-is
  assert.equal(byId['p-2'].stock, 5); // 3 + 6/3 units
  assert.equal(voidTransaction.items[0].qty, -2);
});

test('pre-cierre void: reverts fiado debt and stamps the original sale', () => {
  const state = baseState();
  const sale = makeSale({
    tipo: 'VENTA_FIADA',
    fiadoUsd: 10,
    customerId: 'c-1',
    customerName: 'Luisa',
  });
  state.sales = [sale];

  const { updatedSales, updatedCustomers, voidTransaction } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const original = updatedSales.find(s => s.id === 'sale-1');
  assert.equal(original.voidedAt, NOW.toISOString());
  assert.equal(original.voidedBy, 'u-9');
  assert.equal(typeof original.relatedVoidId, 'string');

  const customer = updatedCustomers.find(c => c.id === 'c-1');
  assert.equal(customer.deuda, 10); // 20 - 10 fiado
  assert.equal(customer.favor, 0);
  assert.equal(voidTransaction.tipo, 'ANULACION_VENTA');
  assert.equal(voidTransaction.totalUsd, -10);
  assert.equal(voidTransaction.totalBs, -7643.49);
  assert.equal(voidTransaction.cierreId, null);
  assert.equal(voidTransaction.cajaCerrada, false);
  assert.equal(voidTransaction.payments[0].amountUsd, -10);
});

test('pre-cierre void: restores saldo a favor consumed by the sale (field healing)', () => {
  const state = baseState();
  const sale = makeSale({
    payments: [
      { methodId: 'efectivo_usd', amount: 4, amountUsd: 4, amountBs: 3000 },
      { methodId: 'saldo_favor', amount: 6, amountUsd: 6, amountBs: 4600 },
    ],
    customerId: 'c-1',
  });
  state.sales = [sale];
  state.customers = [{ id: 'c-1', name: 'Luisa', deuda: 0, favor: 0, saldo_favor: 0 }];

  const { updatedCustomers } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const customer = updatedCustomers.find(c => c.id === 'c-1');
  // El favor consumido se devuelve en el campo canónico `favor` (y espejo legacy).
  assert.equal(customer.favor, 6);
  assert.equal(customer.saldo_favor, 6);
  assert.equal(customer.deuda, 0);
});

test('post-cierre with both settings off: stock and customers untouched, reversal still recorded', () => {
  const state = baseState();
  const sale = makeSale({ cajaCerrada: true, cierreId: 555 });
  state.sales = [sale];

  const { updatedSales, updatedProducts, updatedCustomers } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: { skipRestock: true, skipRevertMoney: true },
    user: { id: 'u-9' },
    now: NOW,
  });

  assert.equal(updatedProducts[0].stock, 5);
  assert.equal(updatedProducts[1].stock, 3);
  const customer = updatedCustomers.find(c => c.id === 'c-1');
  assert.equal(customer.deuda, 20);
  const original = updatedSales.find(s => s.id === 'sale-1');
  assert.ok(original.relatedVoidId);
  assert.equal(updatedSales.filter(s => s.tipo === 'ANULACION_VENTA').length, 1);
});

test('post-cierre with both settings on: restock and money revert applied', () => {
  const state = baseState();
  const sale = makeSale({ cajaCerrada: true, cierreId: 555, tipo: 'VENTA_FIADA', fiadoUsd: 10, customerId: 'c-1' });
  state.sales = [sale];

  const { updatedProducts, updatedCustomers } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: { skipRestock: false, skipRevertMoney: false },
    user: { id: 'u-9' },
    now: NOW,
  });

  assert.equal(updatedProducts[0].stock, 7);
  const customer = updatedCustomers.find(c => c.id === 'c-1');
  assert.equal(customer.deuda, 10);
});

test('status-quo pin: voiding a closed sale keeps the ORIGINAL commercial date, not the open session', () => {
  const state = baseState();
  const sale = makeSale({ cajaCerrada: true, cierreId: 555, fechaComercial: '2026-09-09' });
  state.sales = [sale];

  const { voidTransaction } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: [],
    options: {},
    user: { id: 'u-9' },
    sessionDate: '2026-09-10', // sesión abierta HOY; no debe usarse
    now: NOW,
  });

  assert.equal(voidTransaction.fechaComercial, '2026-09-09');
});

test('netting invariant: sale + reversal sum to ~0 under closure/reports filters', () => {
  const state = baseState();
  const sale = makeSale({ cajaCerrada: true, cierreId: 555 });
  state.sales = [sale];

  const { updatedSales } = buildVoidMutation({
    sale,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: [],
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const statsTypes = ['VENTA', 'VENTA_FIADA', 'VENTA_CASHEA', 'ANULACION_VENTA'];
  const inScope = updatedSales.filter(s => statsTypes.includes(s.tipo) && s.fechaComercial === '2026-09-09');
  const totalUsd = inScope.reduce((sum, s) => sum + (s.totalUsd || 0), 0);
  const totalBs = inScope.reduce((sum, s) => sum + (s.totalBs || 0), 0);
  const totalItems = inScope.reduce((sum, s) => sum + (s.items || []).reduce((is, i) => is + i.qty, 0), 0);
  assert.ok(Math.abs(totalUsd) < 1e-9);
  assert.ok(Math.abs(totalBs) < 1e-9);
  assert.ok(Math.abs(totalItems) < 1e-9);
});

test('M1: voiding a plain-cash COBRO_DEUDA restores the customer debt', () => {
  const state = baseState();
  const abono = {
    id: 'abono-1',
    tipo: 'COBRO_DEUDA',
    status: 'COMPLETADA',
    timestamp: '2026-09-09T20:00:00.000Z',
    fechaComercial: '2026-09-09',
    clienteId: 'c-1',
    clienteName: 'Luisa',
    totalUsd: 15,
    totalBs: 11465,
    items: [{ name: 'Abono de deuda: Luisa', qty: 1, priceUsd: 15, costBs: 0 }],
    payments: [{ methodId: 'efectivo_usd', amount: 15, amountUsd: 15, amountBs: 11465 }],
  };
  state.sales = [abono];
  state.customers = [{ id: 'c-1', name: 'Luisa', deuda: 5, favor: 0 }];

  const { updatedCustomers } = buildVoidMutation({
    sale: abono,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const customer = updatedCustomers.find(c => c.id === 'c-1');
  assert.equal(customer.deuda, 20); // 5 + 15 abono revertido
});

test('M1: voiding a saldo_favor-labeled COBRO_DEUDA does not double-credit favor', () => {
  // Los abonos se procesan vía `vueltoParaMonedero` (deuda primero) y NUNCA
  // consumen el saldo a favor del cliente (financialLogic Q2/Q3). Su reverso
  // solo devuelve la deuda; acreditar favor además duplicaría el saldo.
  const state = baseState();
  const abono = {
    id: 'abono-2',
    tipo: 'COBRO_DEUDA',
    status: 'COMPLETADA',
    timestamp: '2026-09-09T20:00:00.000Z',
    fechaComercial: '2026-09-09',
    clienteId: 'c-1',
    clienteName: 'Luisa',
    totalUsd: 15,
    totalBs: 11465,
    items: [{ name: 'Abono de deuda: Luisa', qty: 1, priceUsd: 15, costBs: 0 }],
    payments: [{ methodId: 'saldo_favor', amount: 15, amountUsd: 15, amountBs: 11465 }],
  };
  state.sales = [abono];
  state.customers = [{ id: 'c-1', name: 'Luisa', deuda: 5, favor: 0 }];

  const { updatedCustomers } = buildVoidMutation({
    sale: abono,
    currentSales: state.sales,
    currentProducts: state.products,
    currentCustomers: state.customers,
    options: {},
    user: { id: 'u-9' },
    now: NOW,
  });

  const customer = updatedCustomers.find(c => c.id === 'c-1');
  assert.equal(customer.deuda, 20); // 5 + 15 abono revertido
  assert.equal(customer.favor, 0); // el abono original no consumió favor
});

test('double-void guard: throwing on already-voided sales and on reversos', () => {
  const state = baseState();
  const voided = makeSale({ relatedVoidId: 'void_123', voidedAt: NOW.toISOString() });
  assert.throws(
    () => buildVoidMutation({
      sale: voided,
      currentSales: [voided],
      currentProducts: [],
      currentCustomers: [],
      options: {},
      now: NOW,
    }),
    /ya fue anulada/
  );

  const reverso = makeSale({ id: 'void_123', tipo: 'ANULACION_VENTA' });
  assert.throws(
    () => buildVoidMutation({
      sale: reverso,
      currentSales: [reverso],
      currentProducts: [],
      currentCustomers: [],
      options: {},
      now: NOW,
    }),
    /ANULACION_VENTA/
  );
});

test('core throws when the sale is not in the provided history', () => {
  const state = baseState();
  assert.throws(
    () => buildVoidMutation({
      sale: makeSale({ id: 'missing' }),
      currentSales: state.sales,
      currentProducts: [],
      currentCustomers: [],
      options: {},
      now: NOW,
    }),
    /no está en el historial/
  );
});

test('settings keys keep their stable localStorage names', () => {
  assert.equal(ALLOW_VOID_AFTER_CIERRE_KEY, 'allow_void_after_cierre');
  assert.equal(VOID_CIERRE_RESTOCK_KEY, 'void_cierre_restock');
  assert.equal(VOID_CIERRE_REVERT_MONEY_KEY, 'void_cierre_revert_money');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SALES_KEY, changedSalesChunks, dayOfChunkId, isSalesChunkId, saleDay, salesChunkId, salesOfDay, splitSalesByDay, windowStartDay,
} from '../src/sync/salesChunks.js';
import { hashPayload } from '../src/sync/syncHash.js';
import { mergeEntities } from '../src/sync/entityMeta.js';

const NOW = new Date(2026, 9, 28, 15, 0, 0); // 28-oct-2026, hora local
const at = (day, hh = 12, mm = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
};
const sale = (id, day, hh = 12, extra = {}) => ({ id, timestamp: at(day, hh), total: 10, ...extra });

test('ids de trozo: bodega_sales_v1@AAAA-MM-DD', () => {
  assert.equal(salesChunkId('2026-10-28'), 'bodega_sales_v1@2026-10-28');
  assert.ok(isSalesChunkId('bodega_sales_v1@2026-10-28'));
  assert.ok(!isSalesChunkId(SALES_KEY));
  assert.ok(!isSalesChunkId('bodega_products_v1'));
  assert.equal(dayOfChunkId('bodega_sales_v1@2026-10-28'), '2026-10-28');
  assert.equal(dayOfChunkId('bodega_products_v1'), null);
});

test('el día sale de la hora local de la venta; la fecha comercial manda si existe', () => {
  assert.equal(saleDay(sale('a', '2026-10-27', 23)), '2026-10-27');
  assert.equal(saleDay({ id: 'b', timestamp: at('2026-10-28', 0, 30), fechaComercial: '2026-10-27' }), '2026-10-27');
  assert.equal(saleDay({ id: 'c' }), 'sin-fecha');
});

test('agrupa por día y deja fuera lo anterior a la ventana de 30 días', () => {
  const sales = [
    sale('hoy1', '2026-10-28', 9),
    sale('ayer', '2026-10-27'),
    sale('hoy2', '2026-10-28', 10),
    sale('viejo', '2026-09-01'),
    { id: 'sinFecha' },
  ];
  const chunks = splitSalesByDay(sales, { now: NOW });
  assert.deepEqual([...chunks.keys()].sort(), ['2026-10-27', '2026-10-28', 'sin-fecha']);
  assert.deepEqual(chunks.get('2026-10-28').map(s => s.id), ['hoy1', 'hoy2']);
  assert.equal(windowStartDay(NOW), '2026-09-28');
});

test('mismo día en distinto orden en cada caja → mismo trozo (no hay ida y vuelta)', () => {
  const a = [sale('s1', '2026-10-28', 9), sale('s2', '2026-10-28', 10)];
  const b = [a[1], a[0]];
  const ca = splitSalesByDay(a, { now: NOW }).get('2026-10-28');
  const cb = splitSalesByDay(b, { now: NOW }).get('2026-10-28');
  assert.equal(hashPayload(ca), hashPayload(cb));
  assert.equal(hashPayload(salesOfDay(b, '2026-10-28')), hashPayload(ca));
});

test('una venta nueva solo cambia el trozo de su día', () => {
  const sales = [sale('v1', '2026-10-20'), sale('v2', '2026-10-27'), sale('v3', '2026-10-28')];
  const first = changedSalesChunks(sales, {}, hashPayload, { now: NOW });
  assert.equal(first.length, 3, 'la primera vez se suben todos los días');

  const known = Object.fromEntries(first.map(c => [c.docId, c.hash]));
  const again = changedSalesChunks(sales, known, hashPayload, { now: NOW });
  assert.equal(again.length, 0, 'sin cambios no se sube nada');

  const withNew = [sale('v4', '2026-10-28', 16), ...sales];
  const changed = changedSalesChunks(withNew, known, hashPayload, { now: NOW });
  assert.deepEqual(changed.map(c => c.docId), ['bodega_sales_v1@2026-10-28']);
  assert.deepEqual(changed[0].payload.map(s => s.id), ['v3', 'v4']);
});

test('anular una venta vieja (dentro de la ventana) solo cambia ese día', () => {
  const sales = [sale('v1', '2026-10-20'), sale('v2', '2026-10-28')];
  const known = Object.fromEntries(changedSalesChunks(sales, {}, hashPayload, { now: NOW }).map(c => [c.docId, c.hash]));
  const voided = [{ ...sales[0], status: 'ANULADA' }, sales[1]];
  const changed = changedSalesChunks(voided, known, hashPayload, { now: NOW });
  assert.deepEqual(changed.map(c => c.docId), ['bodega_sales_v1@2026-10-20']);
});

test('dos cajas: los trozos de la otra se mezclan sin perder ventas locales', () => {
  const local = [sale('caja1-a', '2026-10-28', 9), sale('caja1-viejo', '2026-10-25')];
  const chunkFromOther = [sale('caja2-a', '2026-10-28', 11)];
  const merged = mergeEntities(local, chunkFromOther);
  assert.deepEqual(merged.map(s => s.id).sort(), ['caja1-a', 'caja1-viejo', 'caja2-a']);
  // El día quedó distinto al trozo de la nube → hay que re-subirlo con ambas ventas.
  const day = salesOfDay(merged, '2026-10-28');
  assert.notEqual(hashPayload(day), hashPayload(chunkFromOther));
  assert.deepEqual(day.map(s => s.id), ['caja1-a', 'caja2-a']);
});

test('entrada no válida no rompe', () => {
  assert.equal(splitSalesByDay(null).size, 0);
  assert.deepEqual(changedSalesChunks('x', {}, hashPayload), []);
  assert.deepEqual(salesOfDay(undefined, '2026-10-28'), []);
});

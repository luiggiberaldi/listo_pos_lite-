import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedMeta, compareIso, cursorQueryFrom, maxIso } from '../src/sync/syncCursor.js';

test('el cursor es el mayor updated_at del servidor, no la hora local', () => {
  const meta = [
    { doc_id: 'bodega_products_v1', updated_at: '2026-10-27T12:00:05.123456+00:00' },
    { doc_id: 'tasa_cop', updated_at: '2026-10-27T12:00:01+00:00' },
  ];
  const { newCursor } = classifyChangedMeta(meta, { cursor: '2026-10-27T11:59:00+00:00' });
  assert.equal(newCursor, '2026-10-27T12:00:05.123456+00:00');
});

test('reloj de un equipo desfasado ±10 min: su cambio igual se descarga', () => {
  // B tiene el reloj 10 min atrasado, pero updated_at lo fija el trigger del
  // servidor (migración 009), así que su cambio queda después del cursor de A.
  const cursorA = '2026-10-27T12:00:00+00:00';
  const from = cursorQueryFrom(cursorA, 5000);
  const cambioDeB = { doc_id: 'bodega_customers_v1', updated_at: '2026-10-27T12:00:30.5+00:00' };
  assert.ok(compareIso(cambioDeB.updated_at, from) >= 0, 'el filtro .gte lo incluye');
  const { foreignIds } = classifyChangedMeta([cambioDeB], { cursor: cursorA });
  assert.deepEqual(foreignIds, ['bodega_customers_v1']);
});

test('el margen cubre commits que confirman fuera de orden', () => {
  assert.equal(cursorQueryFrom('2026-10-27T12:00:10.000Z', 5000), '2026-10-27T12:00:05.000Z');
  assert.equal(cursorQueryFrom(null, 5000), null);
});

test('no se vuelve a bajar lo que subió este equipo ni lo ya aplicado', () => {
  const meta = [
    { doc_id: 'propio', updated_at: '2026-10-27T12:00:01+00:00' },
    { doc_id: 'visto', updated_at: '2026-10-27T12:00:02+00:00' },
    { doc_id: 'ajeno', updated_at: '2026-10-27T12:00:03+00:00' },
    { doc_id: 'visto_cambiado', updated_at: '2026-10-27T12:00:04+00:00' },
  ];
  const r = classifyChangedMeta(meta, {
    ownUpdatedAt: { propio: '2026-10-27T12:00:01+00:00' },
    seenUpdatedAt: { visto: '2026-10-27T12:00:02+00:00', visto_cambiado: '2026-10-27T11:00:00+00:00' },
  });
  assert.deepEqual(r.foreignIds, ['ajeno', 'visto_cambiado']);
  assert.deepEqual(r.ownSeen, { propio: '2026-10-27T12:00:01+00:00' });
  assert.equal(r.newCursor, '2026-10-27T12:00:04+00:00');
});

test('compara formatos mixtos de Postgres y JS por instante', () => {
  // Texto: '+' < '.' y 'Z' > '+' engañan a la comparación de strings.
  assert.equal(maxIso('2026-10-27T12:00:00.500Z', '2026-10-27T12:00:00.4+00:00'), '2026-10-27T12:00:00.500Z');
  assert.equal(maxIso('2026-10-27T12:00:01Z', '2026-10-27T12:00:00.999999+00:00'), '2026-10-27T12:00:01Z');
  // Mismo milisegundo: los microsegundos desempatan.
  assert.equal(compareIso('2026-10-27T12:00:00.123456+00:00', '2026-10-27T12:00:00.123455+00:00'), 1);
  assert.equal(maxIso(null, 'x'), 'x');
  assert.equal(maxIso('x', null), 'x');
});

test('sin metadatos el cursor no retrocede', () => {
  const { newCursor, foreignIds } = classifyChangedMeta([], { cursor: '2026-10-27T12:00:00+00:00' });
  assert.equal(newCursor, '2026-10-27T12:00:00+00:00');
  assert.deepEqual(foreignIds, []);
});

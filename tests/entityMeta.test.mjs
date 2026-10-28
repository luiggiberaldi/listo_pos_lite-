import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alive, mergeEntities, newer, stampChanges, MASS_DELETE_MIN,
} from '../src/sync/entityMeta.js';

const T1 = '2026-10-28T10:00:00.000Z';
const T2 = '2026-10-28T10:05:00.000Z';
const T3 = '2026-10-28T10:10:00.000Z';

test('B1: solo el registro que cambió recibe fecha, versión y dispositivo', () => {
  const first = stampChanges([], [{ id: 'a', price: 1 }, { id: 'b', price: 2 }], { deviceId: 'caja-A', now: T1 }).list;
  assert.equal(first[0].rev, 1);
  assert.equal(first[0].updatedBy, 'caja-A');
  const second = stampChanges(first, [{ ...first[0] }, { ...first[1], price: 3 }], { deviceId: 'caja-B', now: T2 }).list;
  assert.equal(second[0].updatedAt, T1, 'sin cambios: conserva su versión');
  assert.equal(second[0].rev, 1);
  assert.equal(second[1].updatedAt, T2);
  assert.equal(second[1].rev, 2);
  assert.equal(second[1].updatedBy, 'caja-B');
});

test('B1: re-guardar lo mismo (otro orden de llaves) no sube la versión', () => {
  const first = stampChanges([], [{ id: 'a', name: 'X', price: 1 }], { now: T1 }).list;
  const again = stampChanges(first, [{ price: 1, name: 'X', id: 'a' }], { now: T2 });
  assert.equal(again.changed, false);
  assert.equal(again.list[0].rev, 1);
});

test('B2: lo que desaparece queda como lápida, oculta para las pantallas', () => {
  const first = stampChanges([], [{ id: 'a' }, { id: 'b' }], { now: T1 }).list;
  const out = stampChanges(first, alive(first).filter(x => x.id !== 'b'), { deviceId: 'caja-A', now: T2 }).list;
  const b = out.find(x => x.id === 'b');
  assert.equal(b.deletedAt, T2);
  assert.equal(b.rev, 2);
  assert.deepEqual(alive(out).map(x => x.id), ['a']);
  // Guardar de nuevo sin 'b' no re-borra ni cambia la lápida.
  const again = stampChanges(out, alive(out), { now: T3 });
  assert.equal(again.list.find(x => x.id === 'b').deletedAt, T2);
});

test('B2: las lápidas de más de 90 días se purgan', () => {
  const old = [{ id: 'x', deletedAt: '2026-06-01T00:00:00.000Z', rev: 3 }, { id: 'y', rev: 1 }];
  const out = stampChanges(old, [{ id: 'y', rev: 1 }], { now: T1 }).list;
  assert.deepEqual(out.map(x => x.id), ['y']);
});

test('B2: vaciar de golpe una lista grande se bloquea (carga fallida que guarda [])', () => {
  const many = Array.from({ length: MASS_DELETE_MIN }, (_, i) => ({ id: String(i) }));
  const prev = stampChanges([], many, { now: T1 }).list;
  const res = stampChanges(prev, [], { now: T2 });
  assert.equal(res.blocked, true);
  assert.equal(alive(res.list).length, MASS_DELETE_MIN, 'no se borró nada');
  const allowed = stampChanges(prev, [], { now: T2, allowMassDelete: true });
  assert.equal(alive(allowed.list).length, 0);
  // Borrar el último de una lista chica sí está permitido.
  const one = stampChanges([], [{ id: 'z' }], { now: T1 }).list;
  assert.equal(stampChanges(one, [], { now: T2 }).blocked, false);
});

test('B3: un borrado en otra caja NO resucita con la copia vieja', () => {
  const local = [{ id: 'c1', name: 'Cliente', updatedAt: T1, rev: 1 }];
  const cloud = [{ id: 'c1', name: 'Cliente', updatedAt: T2, rev: 2, deletedAt: T2 }];
  const merged = mergeEntities(local, cloud);
  assert.equal(merged[0].deletedAt, T2);
  assert.deepEqual(alive(merged), []);
});

test('B3: si el cambio local es más nuevo que el borrado, gana el local', () => {
  const local = [{ id: 'c1', name: 'Editado', updatedAt: T3, rev: 3 }];
  const cloud = [{ id: 'c1', name: 'Cliente', updatedAt: T2, rev: 2, deletedAt: T2 }];
  assert.equal(mergeEntities(local, cloud)[0].name, 'Editado');
});

test('B3: gana la versión más nueva de cada registro, de cualquier lado', () => {
  const local = [{ id: 'p1', stock: 5, updatedAt: T3, rev: 2 }, { id: 'p2', stock: 1, updatedAt: T1, rev: 1 }];
  const cloud = [{ id: 'p1', stock: 9, updatedAt: T1, rev: 1 }, { id: 'p2', stock: 7, updatedAt: T2, rev: 2 }];
  const merged = mergeEntities(local, cloud);
  assert.equal(merged.find(x => x.id === 'p1').stock, 5);
  assert.equal(merged.find(x => x.id === 'p2').stock, 7);
});

test('B3: empate exacto se resuelve igual en ambas cajas (no "gana la nube")', () => {
  const a = { id: 'p', stock: 1, updatedAt: T1, rev: 1, updatedBy: 'caja-A' };
  const b = { id: 'p', stock: 2, updatedAt: T1, rev: 1, updatedBy: 'caja-B' };
  assert.equal(mergeEntities([a], [b])[0].updatedBy, 'caja-B');
  assert.equal(mergeEntities([b], [a])[0].updatedBy, 'caja-B');
  // Empate total de metadatos: desempate por contenido, determinista.
  const c = { id: 'p', stock: 3, updatedAt: T1, rev: 1, updatedBy: 'caja-A' };
  assert.deepEqual(mergeEntities([a], [c]), mergeEntities([c], [a]));
});

test('B3: venta anulada en una caja no vuelve a "COMPLETADA" con la copia vieja', () => {
  const vieja = { id: 'v1', status: 'COMPLETADA', timestamp: T1 };
  const anulada = { id: 'v1', status: 'ANULADA', timestamp: T1, updatedAt: T2, rev: 1 };
  assert.equal(mergeEntities([vieja], [anulada])[0].status, 'ANULADA');
  assert.equal(mergeEntities([anulada], [vieja])[0].status, 'ANULADA');
});

test('B3: producto creado en A y otro creado en B → ambos', () => {
  const merged = mergeEntities([{ id: 'nuevoA', updatedAt: T1, rev: 1 }], [{ id: 'nuevoB', updatedAt: T2, rev: 1 }]);
  assert.deepEqual(merged.map(x => x.id).sort(), ['nuevoA', 'nuevoB']);
});

test('B3: datos viejos sin metadatos usan timestamp/createdAt y no se pierden', () => {
  assert.equal(newer({ id: 1, createdAt: T1 }, { id: 1, createdAt: T2 }), true);
  const merged = mergeEntities([{ id: 'k', cierreId: undefined }], [{ cierreId: 'cierre-1' }]);
  assert.equal(merged.length, 2);
});

test('B3: datos sin versión en ambas copias → la nube gana (regla anterior)', () => {
  const local = [{ id: 'p', stock: 3 }];
  const cloud = [{ id: 'p', stock: 8 }];
  assert.equal(mergeEntities(local, cloud)[0].stock, 8);
  // ...salvo que la copia local sea claramente más reciente
  assert.equal(mergeEntities([{ id: 'p', stock: 3, createdAt: T2 }], [{ id: 'p', stock: 8, createdAt: T1 }])[0].stock, 3);
});

test('B3: la foto local se conserva aunque gane la versión de la nube (que no trae fotos)', () => {
  const local = [{ id: 'p', name: 'A', image: 'data:img', updatedAt: T1, rev: 1 }];
  const cloud = [{ id: 'p', name: 'B', updatedAt: T2, rev: 2 }];
  const merged = mergeEntities(local, cloud, { localOnlyFields: ['image'] });
  assert.equal(merged[0].name, 'B');
  assert.equal(merged[0].image, 'data:img');
});

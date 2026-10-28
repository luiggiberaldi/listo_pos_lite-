import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackRegisterCode, formatSaleNumber, matchesSaleNumber, nextSaleNumber,
  readRegisterCode, readSaleCounter, saleNumberLabel, writeSaleCounter,
} from '../src/utils/saleNumbering.js';

const memoryStorage = (init = {}) => {
  const data = { ...init };
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};

test('B6: 2 cajas venden 50 ventas cada una a la vez → 100 números únicos', () => {
  const ventas = [];
  const cajas = ['A', 'B'].map(code => ({ code, storage: memoryStorage() }));
  for (let i = 0; i < 50; i++) {
    for (const caja of cajas) {
      // Cada caja solo ve sus propias ventas (peor caso: sin internet).
      const propias = ventas.filter(v => v.registerCode === caja.code);
      const n = nextSaleNumber(propias, caja.code, readSaleCounter({ storage: caja.storage }));
      writeSaleCounter(caja.code, n, { storage: caja.storage });
      ventas.push({ saleNumber: n, registerCode: caja.code });
    }
  }
  const etiquetas = new Set(ventas.map(formatSaleNumber));
  assert.equal(etiquetas.size, 100);
  assert.ok(etiquetas.has('A-00050') && etiquetas.has('B-00001'));
});

test('B6: el contador sigue aunque la venta anterior aún no esté en la lista', () => {
  const storage = memoryStorage();
  writeSaleCounter('A', 7, { storage });
  assert.equal(nextSaleNumber([], 'A', readSaleCounter({ storage })), 8);
  // Contador de otra letra (provisional) no cuenta para la letra nueva.
  assert.equal(nextSaleNumber([], 'B', readSaleCounter({ storage })), 1);
  // Ventas sincronizadas de esta caja (p. ej. tras reinstalar) suben el contador.
  assert.equal(nextSaleNumber([{ registerCode: 'A', saleNumber: 30 }, { saleNumber: 99 }], 'A', null), 31);
});

test('B6: las ventas viejas conservan su número de siempre', () => {
  assert.equal(formatSaleNumber({ saleNumber: 1023 }), '0001023');
  assert.equal(formatSaleNumber({ saleNumber: 101, registerCode: 'B' }), 'B-00101');
  assert.equal(saleNumberLabel({ id: 'abcdef123' }), '#ABCDEF');
  assert.equal(formatSaleNumber({}), '');
});

test('B6: código provisional sin letra del servidor', () => {
  assert.equal(fallbackRegisterCode('a1b2-c3d4-e5f6'), '5F6');
  assert.equal(fallbackRegisterCode(''), '000');
  assert.equal(readRegisterCode({ storage: memoryStorage({ pda_device_id: 'xyz-9k2' }) }), '9K2');
  assert.equal(readRegisterCode({ storage: memoryStorage({ pda_device_id: 'xyz-9k2', pos_register_code: 'C' }) }), 'C');
});

test('B6: buscar por número encuentra "B-00101", "101" y "#0001023"', () => {
  assert.ok(matchesSaleNumber({ saleNumber: 101, registerCode: 'B' }, 'b-00101'));
  assert.ok(matchesSaleNumber({ saleNumber: 101, registerCode: 'B' }, '101'));
  assert.ok(matchesSaleNumber({ saleNumber: 1023 }, '#0001023'));
  assert.ok(!matchesSaleNumber({ saleNumber: 5 }, '7'));
});

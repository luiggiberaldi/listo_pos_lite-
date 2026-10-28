import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProductPayload } from '../src/utils/productProcessor.js';

const base = { name: 'x', priceUsd: '1', costUsd: '0.5', category: 'otros', lowStockAlert: '5' };

test('granel conserva los decimales del stock (37.25 kg no se trunca a 37)', () => {
    const p = buildProductPayload({ ...base, packagingType: 'granel', granelUnit: 'kg', stock: '37.25' }, 100);
    assert.equal(p.stock, 37.25);
});

test('unidades sueltas y lotes siguen siendo enteros', () => {
    assert.equal(buildProductPayload({ ...base, packagingType: 'suelto', stock: '7' }, 100).stock, 7);
    assert.equal(buildProductPayload({ ...base, packagingType: 'lote', unitsPerPackage: '12', stockInLotes: '4' }, 100).stock, 48);
});

test('stock vacío o inválido queda en 0', () => {
    assert.equal(buildProductPayload({ ...base, packagingType: 'granel', granelUnit: 'kg', stock: 'abc' }, 100).stock, 0);
    assert.equal(buildProductPayload({ ...base, packagingType: 'suelto', stock: '' }, 100).stock, 0);
});

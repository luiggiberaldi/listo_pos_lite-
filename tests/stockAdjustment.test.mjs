import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeStockQuantity,
    computeStockAdjustment
} from '../src/utils/stockUtils.js';

test('normalizeStockQuantity: redondea enteros para unidades y paquetes', () => {
    assert.equal(normalizeStockQuantity(5, 'unidad'), 5);
    assert.equal(normalizeStockQuantity('12', 'unidad'), 12);
    assert.equal(normalizeStockQuantity(10.6, 'paquete'), 11);
    assert.equal(normalizeStockQuantity('invalid', 'unidad'), 0);
    assert.equal(normalizeStockQuantity(null, 'unidad'), 0);
});

test('normalizeStockQuantity: preserva hasta 3 decimales limpios para kg y litros', () => {
    assert.equal(normalizeStockQuantity(1.2345, 'kg'), 1.235);
    assert.equal(normalizeStockQuantity('2.5', 'litro'), 2.5);
    assert.equal(normalizeStockQuantity(0.1 + 0.2, 'kg'), 0.3); // evita 0.30000000000000004
});

test('computeStockAdjustment (modo add): suma mercancía entrante correctamente', () => {
    // 10 unidades + 24 unidades = 34
    const resUnidades = computeStockAdjustment({
        currentStock: 10,
        inputValue: 24,
        mode: 'add',
        unit: 'unidad'
    });
    assert.equal(resUnidades.targetStock, 34);
    assert.equal(resUnidades.delta, 24);

    // 2.250 kg + 1.500 kg = 3.750 kg
    const resKg = computeStockAdjustment({
        currentStock: 2.250,
        inputValue: 1.5,
        mode: 'add',
        unit: 'kg'
    });
    assert.equal(resKg.targetStock, 3.75);
    assert.equal(resKg.delta, 1.5);
});

test('computeStockAdjustment (modo set): fija el conteo físico exacto', () => {
    // Conteo físico sube: de 12 a 50
    const resAumento = computeStockAdjustment({
        currentStock: 12,
        inputValue: 50,
        mode: 'set',
        unit: 'unidad'
    });
    assert.equal(resAumento.targetStock, 50);
    assert.equal(resAumento.delta, 38);

    // Conteo físico baja (merma/ajuste): de 50 a 42
    const resBaja = computeStockAdjustment({
        currentStock: 50,
        inputValue: 42,
        mode: 'set',
        unit: 'unidad'
    });
    assert.equal(resBaja.targetStock, 42);
    assert.equal(resBaja.delta, -8);
});

test('computeStockAdjustment: respeta la regla de stock negativo', () => {
    // Sin permitir negativos: fijar en -10 debe truncar en 0
    const bloqueado = computeStockAdjustment({
        currentStock: 5,
        inputValue: -10,
        mode: 'set',
        unit: 'unidad',
        allowNegative: false
    });
    assert.equal(bloqueado.targetStock, 0);
    assert.equal(bloqueado.delta, -5);

    // Permitiendo negativos: fijar en -10 debe mantenerse en -10
    const permitido = computeStockAdjustment({
        currentStock: 5,
        inputValue: -10,
        mode: 'set',
        unit: 'unidad',
        allowNegative: true
    });
    assert.equal(permitido.targetStock, -10);
    assert.equal(permitido.delta, -15);
});

test('computeStockAdjustment: inputs vacíos o inválidos no corrompen el stock', () => {
    const resVacio = computeStockAdjustment({
        currentStock: 15,
        inputValue: '',
        mode: 'add',
        unit: 'unidad'
    });
    assert.equal(resVacio.targetStock, 15);
    assert.equal(resVacio.delta, 0);
});

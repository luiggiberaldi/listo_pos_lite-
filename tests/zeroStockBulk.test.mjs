import test from 'node:test';
import assert from 'node:assert/strict';

import {
    filterProductsByZeroScope,
    bulkZeroProductStock
} from '../src/utils/stockUtils.js';

const sampleProducts = [
    { id: 'p1', name: 'Arroz 1kg', category: 'viveres', stock: 25, priceUsdt: 1.2, costUsd: 0.9, unit: 'kg' },
    { id: 'p2', name: 'Harina PAN', category: 'viveres', stock: 10, stockInLotes: 2, priceUsdt: 1.1, costUsd: 0.8, unit: 'unidad' },
    { id: 'p3', name: 'Refresco 2L', category: 'bebidas', stock: 15, priceUsdt: 2.0, costUsd: 1.5, unit: 'unidad' },
    { id: 'p4', name: 'Jugo Naranja', category: 'bebidas', stock: 8, stockInLotes: 1, priceUsdt: 1.5, costUsd: 1.0, unit: 'unidad' },
    { id: 'p5', name: 'Jabón', category: 'limpieza', stock: 30, priceUsdt: 0.8, costUsd: 0.5, unit: 'unidad' },
];

test('filterProductsByZeroScope: filtra correctamente según el alcance (all, category, selected)', () => {
    // Alcance: Todo el inventario
    const all = filterProductsByZeroScope(sampleProducts, { scope: 'all' });
    assert.equal(all.length, 5);

    // Alcance: Categoría 'bebidas'
    const bebidas = filterProductsByZeroScope(sampleProducts, { scope: 'category', category: 'bebidas' });
    assert.equal(bebidas.length, 2);
    assert.deepEqual(bebidas.map(p => p.id), ['p3', 'p4']);

    // Alcance: Categoría 'todos' (retorna todos)
    const catTodos = filterProductsByZeroScope(sampleProducts, { scope: 'category', category: 'todos' });
    assert.equal(catTodos.length, 5);

    // Alcance: Selección manual con Set
    const selectedSet = new Set(['p1', 'p5']);
    const selected = filterProductsByZeroScope(sampleProducts, { scope: 'selected', selectedIds: selectedSet });
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(p => p.id), ['p1', 'p5']);

    // Alcance: Entradas inválidas
    assert.deepEqual(filterProductsByZeroScope([], { scope: 'all' }), []);
    assert.deepEqual(filterProductsByZeroScope(null), []);
});

test('bulkZeroProductStock: vacía existencias de todo el inventario preservando catálogo', () => {
    const { updatedProducts, affectedCount } = bulkZeroProductStock(sampleProducts, { scope: 'all' });

    assert.equal(affectedCount, 5);
    assert.equal(updatedProducts.length, 5);

    // Todos los stocks deben ser 0
    updatedProducts.forEach(p => {
        assert.equal(p.stock, 0);
    });

    // p2 y p4 tenían stockInLotes, deben ser 0
    const p2 = updatedProducts.find(p => p.id === 'p2');
    assert.equal(p2.stockInLotes, 0);
    assert.equal(p2.name, 'Harina PAN');
    assert.equal(p2.priceUsdt, 1.1);
    assert.equal(p2.costUsd, 0.8);

    // p1 no tenía stockInLotes, no debe crearse propiedad indefinida
    const p1 = updatedProducts.find(p => p.id === 'p1');
    assert.equal(p1.stockInLotes, undefined);
    assert.equal('stockInLotes' in p1, false, 'No debe existir la propiedad stockInLotes si no estaba definida');
    assert.equal(p1.name, 'Arroz 1kg');
    assert.equal(p1.priceUsdt, 1.2);
});

test('bulkZeroProductStock: vacía existencias solo de la categoría seleccionada', () => {
    const { updatedProducts, affectedCount } = bulkZeroProductStock(sampleProducts, {
        scope: 'category',
        category: 'bebidas'
    });

    assert.equal(affectedCount, 2);

    // p3 y p4 (bebidas) deben estar en 0
    const p3 = updatedProducts.find(p => p.id === 'p3');
    const p4 = updatedProducts.find(p => p.id === 'p4');
    assert.equal(p3.stock, 0);
    assert.equal(p4.stock, 0);
    assert.equal(p4.stockInLotes, 0);

    // p1, p2, p5 deben mantener su stock original
    const p1 = updatedProducts.find(p => p.id === 'p1');
    const p2 = updatedProducts.find(p => p.id === 'p2');
    const p5 = updatedProducts.find(p => p.id === 'p5');
    assert.equal(p1.stock, 25);
    assert.equal(p2.stock, 10);
    assert.equal(p2.stockInLotes, 2);
    assert.equal(p5.stock, 30);
});

test('bulkZeroProductStock: vacía existencias solo de los IDs seleccionados', () => {
    const { updatedProducts, affectedCount } = bulkZeroProductStock(sampleProducts, {
        scope: 'selected',
        selectedIds: new Set(['p1', 'p2'])
    });

    assert.equal(affectedCount, 2);

    // p1 y p2 quedan en 0
    const p1 = updatedProducts.find(p => p.id === 'p1');
    const p2 = updatedProducts.find(p => p.id === 'p2');
    assert.equal(p1.stock, 0);
    assert.equal(p2.stock, 0);
    assert.equal(p2.stockInLotes, 0);

    // Los demás quedan intactos
    const p3 = updatedProducts.find(p => p.id === 'p3');
    assert.equal(p3.stock, 15);
});

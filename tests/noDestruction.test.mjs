import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSnapshots, parseEnvFile } from '../scripts/no-destruction.mjs';

function makeSnapshot(overrides = {}) {
    return {
        projectRef: 'proj-test',
        host: 'proj-test.supabase.co',
        createdAt: '2026-10-26T12:00:00.000Z',
        counts: {
            sales: 100,
            sale_items: 250,
            journal_entries: 400,
            inventory_adjustments: 10,
            products: 50,
        },
        samples: {
            sales: [
                { id: 'sale-1', total: '10.00', created_at: '2026-10-20T10:00:00.000Z' },
                { id: 'sale-2', total: '5.50', created_at: '2026-10-21T11:00:00.000Z' },
            ],
            products: [{ id: 'prod-1' }, { id: 'prod-2' }],
        },
        ...overrides,
    };
}

test('crecimiento normal (tráfico en vivo) no marca violaciones', () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
        counts: { sales: 105, sale_items: 260, journal_entries: 415, inventory_adjustments: 10, products: 51 },
    });
    const { violations, warnings } = compareSnapshots(before, after);
    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
});

test('una venta muestreada que desaparece es violación de destrucción', () => {
    const before = makeSnapshot();
    const after = makeSnapshot();
    after.samples.sales = after.samples.sales.filter(row => row.id !== 'sale-1');
    const { violations } = compareSnapshots(before, after);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /sale-1/);
});

test('alterar el total o la fecha de una venta muestreada es violación', () => {
    const before = makeSnapshot();
    const after = makeSnapshot();
    after.samples.sales[0].total = '999.00';
    const { violations } = compareSnapshots(before, after);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /alterada/);
});

test('bajar el conteo de una tabla de solo-creación es violación', () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
        counts: { sales: 99, sale_items: 250, journal_entries: 400, inventory_adjustments: 10, products: 50 },
    });
    const { violations } = compareSnapshots(before, after);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /"sales" perdió filas: 100 → 99/);
});

test('productos eliminados: violación sin tolerancia, advertencia dentro de ella', () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
        counts: { sales: 100, sale_items: 250, journal_entries: 400, inventory_adjustments: 10, products: 49 },
    });
    after.samples.products = [{ id: 'prod-2' }];

    const strict = compareSnapshots(before, after, { productTolerance: 0 });
    assert.equal(strict.violations.length, 2); // producto muestrado + conteo

    const tolerant = compareSnapshots(before, after, { productTolerance: 1 });
    assert.equal(tolerant.violations.length, 0);
    assert.equal(tolerant.warnings.length, 2);
});

test('comparar snapshots de proyectos distintos es violación', () => {
    const before = makeSnapshot();
    const after = makeSnapshot({ projectRef: 'otro-proyecto', host: 'otro-proyecto.supabase.co' });
    const { violations } = compareSnapshots(before, after);
    assert.match(violations[0], /Proyectos distintos/);
});

test('parseEnvFile ignora comentarios y descarta comillas', () => {
    const parsed = parseEnvFile('# comentario\nVITE_SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_KEY="abc-123"\n\nOTRA=cosa\n');
    assert.deepEqual(parsed, {
        VITE_SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_SERVICE_KEY: 'abc-123',
        OTRA: 'cosa',
    });
});

test('inventory_operations (contrato de inventario) es de solo-creación', () => {
    const baseCounts = {
        sales: 100,
        sale_items: 250,
        journal_entries: 400,
        inventory_adjustments: 10,
        products: 50,
        inventory_operations: 3,
    };
    const before = makeSnapshot({ counts: baseCounts });

    const grown = makeSnapshot({ counts: { ...baseCounts, inventory_operations: 7 } });
    assert.deepEqual(compareSnapshots(before, grown).violations, []);

    const shrunk = makeSnapshot({ counts: { ...baseCounts, inventory_operations: 2 } });
    const { violations } = compareSnapshots(before, shrunk);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /"inventory_operations" perdió filas: 3 → 2/);
});

test('una tabla ausente antes de su migración no bloquea la comparación', () => {
    const before = makeSnapshot(); // sin inventory_operations (migración pendiente)
    const after = makeSnapshot({
        counts: { ...makeSnapshot().counts, inventory_operations: 4 },
    });
    const { violations, warnings } = compareSnapshots(before, after);
    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
});

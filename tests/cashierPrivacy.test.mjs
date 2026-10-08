import test from 'node:test';
import assert from 'node:assert/strict';

import {
    shouldUseBlindClose,
    getCloseButtonSubtitle,
    getCloseNotificationPayload,
    formatCashierHeroData,
} from '../src/utils/cashierPrivacyUtils.js';

test('shouldUseBlindClose: fuerza cierre ciego incondicionalmente para cualquier usuario no administrador', () => {
    assert.equal(shouldUseBlindClose({ isAdmin: false }), true);
    assert.equal(shouldUseBlindClose({ isAdmin: true }), false);
});

test('getCloseButtonSubtitle: oculta cifras monetarias a cajeros y muestra etiqueta de cierre ciego', () => {
    // Caso Cajero - 0 ventas
    const cajeroZero = getCloseButtonSubtitle({
        isAdmin: false,
        todaySalesCount: 0,
        todayTotalUsd: 1250.5,
    });
    assert.equal(cajeroZero, '0 ventas · Cierre ciego');
    assert.ok(!cajeroZero.includes('$'), 'No debe contener el símbolo $');
    assert.ok(!cajeroZero.includes('1250'), 'No debe revelar el monto acumulado');

    // Caso Cajero - 1 venta (singular)
    const cajeroUno = getCloseButtonSubtitle({
        isAdmin: false,
        todaySalesCount: 1,
        todayTotalUsd: 15.0,
    });
    assert.equal(cajeroUno, '1 venta · Cierre ciego');
    assert.ok(!cajeroUno.includes('$'));

    // Caso Cajero - Múltiples ventas
    const cajeroMulti = getCloseButtonSubtitle({
        isAdmin: false,
        todaySalesCount: 14,
        todayTotalUsd: 589.2,
        hasPostClosureReversal: true,
    });
    assert.equal(cajeroMulti, '14 ventas · Cierre ciego');
    assert.ok(!cajeroMulti.includes('$'));
});

test('getCloseButtonSubtitle: muestra importes y ventas detalladas al administrador', () => {
    const adminView = getCloseButtonSubtitle({
        isAdmin: true,
        todaySalesCount: 5,
        todayTotalUsd: 84.5,
        hasPostClosureReversal: false,
    });
    assert.equal(adminView, '$84.50 · 5 ventas');

    const adminWithReversal = getCloseButtonSubtitle({
        isAdmin: true,
        todaySalesCount: 1,
        todayTotalUsd: 10.0,
        hasPostClosureReversal: true,
    });
    assert.equal(adminWithReversal, '$10.00 · 1 venta · incl. reverso');
});

test('getCloseNotificationPayload: no filtra montos en el texto ni en metadata para cajeros', () => {
    const notifCajero = getCloseNotificationPayload({
        isAdmin: false,
        todaySalesCount: 12,
        todayTotalUsd: 345.67,
        declaredUsd: 340.0,
        diffUsd: -5.67,
        cierreId: 'CIERRE-2026-10-08-001',
    });

    assert.equal(notifCajero.title, 'Caja cerrada');
    assert.equal(notifCajero.description, 'Cierre de turno completado — 12 transacciones procesadas');
    assert.ok(!notifCajero.description.includes('$'));
    assert.ok(!notifCajero.description.includes('345.67'));

    // Metadata segura: no debe incluir totalUsd, declaredUsd ni diffUsd
    assert.equal(notifCajero.meta.cierreId, 'CIERRE-2026-10-08-001');
    assert.equal(notifCajero.meta.totalUsd, undefined);
    assert.equal(notifCajero.meta.declaredUsd, undefined);
    assert.equal(notifCajero.meta.diffUsd, undefined);
});

test('getCloseNotificationPayload: incluye detalles financieros completos cuando el usuario es administrador', () => {
    const notifAdmin = getCloseNotificationPayload({
        isAdmin: true,
        todaySalesCount: 8,
        todayTotalUsd: 210.0,
        declaredUsd: 210.0,
        diffUsd: 0,
        cierreId: 'CIERRE-2026-10-08-002',
    });

    assert.equal(notifAdmin.title, 'Caja cerrada');
    assert.equal(notifAdmin.description, 'Cierre completado — $210.00 en ventas (8 transacciones)');
    assert.equal(notifAdmin.meta.totalUsd, 210.0);
    assert.equal(notifAdmin.meta.declaredUsd, 210.0);
    assert.equal(notifAdmin.meta.diffUsd, 0);
    assert.equal(notifAdmin.meta.cierreId, 'CIERRE-2026-10-08-002');
});

test('formatCashierHeroData: aísla estrictamente los datos operativos y no expone montos monetarios', () => {
    const dataConNombre = formatCashierHeroData({
        usuarioActivo: { nombre: 'María Pérez', username: 'mperez', rol: 'CAJERO' },
        salesCount: 18,
        itemsCount: 42,
        operatingDate: '2026-10-08',
    });

    assert.deepEqual(dataConNombre, {
        cashierName: 'María Pérez',
        salesCount: 18,
        itemsCount: 42,
        operatingDate: '2026-10-08',
    });

    // Validar ausencia total de campos monetarios
    assert.equal(dataConNombre.totalUsd, undefined);
    assert.equal(dataConNombre.totalBs, undefined);
    assert.equal(dataConNombre.revenue, undefined);

    // Fallback a username si no hay nombre
    const dataConUsername = formatCashierHeroData({
        usuarioActivo: { username: 'cajero_norte', rol: 'CAJERO' },
        salesCount: '5',
        itemsCount: '10',
    });
    assert.equal(dataConUsername.cashierName, 'cajero_norte');
    assert.equal(dataConUsername.salesCount, 5);
    assert.equal(dataConUsername.itemsCount, 10);

    // Fallback a 'Cajero' si no hay usuarioActivo
    const dataAnonimo = formatCashierHeroData({
        usuarioActivo: null,
        salesCount: -2,
        itemsCount: 'invalido',
    });
    assert.equal(dataAnonimo.cashierName, 'Cajero');
    assert.equal(dataAnonimo.salesCount, 0);
    assert.equal(dataAnonimo.itemsCount, 0);
});

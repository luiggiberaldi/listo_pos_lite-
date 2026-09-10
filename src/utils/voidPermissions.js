/**
 * Fuente única de verdad para las reglas de anulación (void) de ventas,
 * en especial las anulaciones después del cierre de caja.
 *
 * Todas las vistas (Dashboard/SalesHistory, Reports) y Settings deben leer
 * estas claves y helpers en lugar de duplicar la lógica o los literales.
 */

export const ALLOW_VOID_AFTER_CIERRE_KEY = 'allow_void_after_cierre';
export const VOID_CIERRE_RESTOCK_KEY = 'void_cierre_restock';
export const VOID_CIERRE_REVERT_MONEY_KEY = 'void_cierre_revert_money';

const DEFAULT_STORE = typeof localStorage !== 'undefined' ? localStorage : null;

/**
 * Una venta está protegida por un Cierre de Caja si ya fue sellada por uno.
 */
export function isVoidBlockedByClosure(sale) {
    return !!sale?.cajaCerrada;
}

/**
 * ¿Puede anularse esta venta en la UI?
 * Pura: las vistas inyectan el contexto (rol y configuración) para que sea
 * testeable sin DOM ni almacenamiento.
 *
 * Reglas:
 * - Solo ADMIN puede anular (los cajeros no ven el botón).
 * - Una venta ya anulada (o su reverso) no puede volver a anularse.
 * - Una venta sellada por cierre solo es anulable si el admin activó
 *   "Permitir anular ventas cerradas".
 */
export function canVoidSale(sale, { isAdmin = false, allowAfterCierre = false } = {}) {
    if (!sale) return false;
    if (!isAdmin) return false;
    if (sale.tipo === 'ANULACION_VENTA') return false;
    const alreadyVoided = !!sale.relatedVoidId || !!sale.voidedAt || sale.status === 'ANULADA';
    if (alreadyVoided) return false;
    if (isVoidBlockedByClosure(sale) && !allowAfterCierre) return false;
    return true;
}

/**
 * Lee las opciones de reversión para una venta según si está cerrada por
 * cierre de caja. Defaults conservadores: si la venta es post-cierre y los
 * toggles están apagados, no se revierte stock ni dinero.
 *
 * Acepta un `store` inyectable (ej. un stub en tests); por defecto usa
 * localStorage cuando existe.
 */
export function getVoidOptionsForSale(sale, store = DEFAULT_STORE) {
    if (!isVoidBlockedByClosure(sale)) return {};
    const read = (key) => {
        if (!store) return null;
        try {
            return store.getItem(key);
        } catch {
            return null;
        }
    };
    return {
        skipRestock: read(VOID_CIERRE_RESTOCK_KEY) !== 'true',
        skipRevertMoney: read(VOID_CIERRE_REVERT_MONEY_KEY) !== 'true',
    };
}

/**
 * Construye el mensaje del modal de confirmación de anulación.
 *
 * Regla de honestidad: el mensaje debe describir EXACTAMENTE lo que hará
 * la anulación según el estado de la venta y la configuración activa.
 * Para ventas post-cierre, los totales del cierre ya generado no se
 * modifican; el reverso queda pendiente hasta la corrección histórica.
 */
export function buildVoidModalMessage(sale, { restock = true, revertMoney = true } = {}) {
    if (!isVoidBlockedByClosure(sale)) {
        return [
            'Esta acción:',
            '• Marcará la venta como ANULADA',
            '• Devolverá el stock a la bodega',
            '• Revertirá deudas o saldos a favor',
            '',
            'Esta acción no se puede deshacer.',
        ].join('\n');
    }

    const lines = [
        'Esta acción:',
        '• Marcará la venta como ANULADA',
        restock
            ? '• Devolverá el stock de los productos al inventario'
            : '• NO tocará el inventario (configuración actual)',
        revertMoney
            ? '• Revertirá deudas y saldos a favor del cliente'
            : '• NO tocará deudas ni saldos a favor (configuración actual)',
        '',
        'Los totales del cierre de caja ya generado NO se modifican.',
        'El reverso quedará pendiente hasta la corrección histórica de cierres.',
        '',
        'Esta acción no se puede deshacer.',
    ];
    return lines.join('\n');
}

/**
 * ¿Es este movimiento un reverso (ANULACION_VENTA) de una venta que ya pasó
 * por cierre de caja?
 *
 * Estos reversos quedan pendientes en la sesión abierta: el KPI de ingresos
 * del dashboard no debe mostrarlos como negocio del día (evita el "día en
 * rojo" fantasma), mientras que el cuadre de caja sí los cuenta porque el
 * efectivo realmente salió del cajón.
 */
export function isPostClosureReversal(movement, allSales = []) {
    if (!movement || movement.tipo !== 'ANULACION_VENTA') return false;
    const origin = (Array.isArray(allSales) ? allSales : []).find(s => s.id === movement.originSaleId);
    return !!origin && isVoidBlockedByClosure(origin);
}

/**
 * Título corto para el modal: usa el número de venta cuando existe.
 */
export function buildVoidModalTitle(sale) {
    if (!sale) return 'Anular venta';
    const label = sale.saleNumber !== undefined && sale.saleNumber !== null && sale.saleNumber !== ''
        ? `#${String(sale.saleNumber).padStart(7, '0')}`
        : `#${String(sale.id || '').substring(0, 6).toUpperCase()}`;
    return `Anular venta ${label}`;
}

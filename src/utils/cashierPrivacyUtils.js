/**
 * Utilidades de privacidad y blindaje para rol CAJERO en el Dashboard.
 */

/**
 * Determina si el proceso de cierre debe ser en modo ciego.
 * Cualquier rol que no sea ADMIN tiene cierre ciego forzado.
 */
export function shouldUseBlindClose({ isAdmin }) {
    return !isAdmin;
}

/**
 * Retorna el texto del subtítulo para el botón de cierre de caja en el Dashboard.
 * Si no es admin, oculta montos en dólares y muestra "Cierre ciego".
 */
export function getCloseButtonSubtitle({
    isAdmin,
    todaySalesCount = 0,
    todayTotalUsd = 0,
    hasPostClosureReversal = false,
}) {
    const salesWord = todaySalesCount === 1 ? 'venta' : 'ventas';
    if (!isAdmin) {
        return `${todaySalesCount} ${salesWord} · Cierre ciego`;
    }
    const reversalSuffix = hasPostClosureReversal ? ' · incl. reverso' : '';
    return `$${Number(todayTotalUsd).toFixed(2)} · ${todaySalesCount} ${salesWord}${reversalSuffix}`;
}

/**
 * Retorna la descripción y metadata segura para la notificación de cierre.
 * Si no es admin, nunca filtra cifras monetarias en el texto o payload.
 */
export function getCloseNotificationPayload({
    isAdmin,
    todaySalesCount = 0,
    todayTotalUsd = 0,
    declaredUsd,
    diffUsd,
    cierreId,
}) {
    if (isAdmin) {
        return {
            title: 'Caja cerrada',
            description: `Cierre completado — $${Number(todayTotalUsd).toFixed(2)} en ventas (${todaySalesCount} transacciones)`,
            meta: { totalUsd: todayTotalUsd, declaredUsd, diffUsd, cierreId },
        };
    }
    return {
        title: 'Caja cerrada',
        description: `Cierre de turno completado — ${todaySalesCount} transacciones procesadas`,
        meta: { cierreId },
    };
}

/**
 * Extrae y formatea de forma segura las props para la tarjeta HERO del cajero,
 * garantizando que no se propague ninguna cifra monetaria.
 */
export function formatCashierHeroData({ usuarioActivo, salesCount = 0, itemsCount = 0, operatingDate }) {
    const cashierName = usuarioActivo?.nombre || usuarioActivo?.username || 'Cajero';
    return {
        cashierName,
        salesCount: Math.max(0, Number(salesCount) || 0),
        itemsCount: Math.max(0, Number(itemsCount) || 0),
        operatingDate: operatingDate || new Date().toISOString().slice(0, 10),
    };
}

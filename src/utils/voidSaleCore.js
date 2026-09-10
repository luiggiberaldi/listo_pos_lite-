import { round2 } from './dinero.js';
import { getLocalISODate, getLocalISOTime } from './dateHelpers.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Núcleo PURO de la mutación de anulación (void) de una venta.
 *
 * No toca almacenamiento, ni logging, ni notificaciones, ni stores de UI:
 * recibe el estado y devuelve el estado siguiente. `voidSaleProcessor.js`
 * lo envuelve con persistencia/telemetría. Esto permite arnés de tests en
 * Node sin mocks.
 *
 * Invariantes que este núcleo garantiza:
 * 1. La venta original queda sellada con voidedAt / voidedBy / relatedVoidId.
 * 2. Se crea un reverso ANULACION_VENTA en negativo con cierreId: null y
 *    cajaCerrada: false, heredando la fecha comercial de la venta original
 *    (decisión de producto: los reversos post-cierre NO aterrizan en la
 *    sesión abierta; quedan pendientes de la corrección histórica).
 * 3. El stock solo se revierte si !skipRestock.
 * 4. El dinero del cliente solo se revierte si !skipRevertMoney.
 * 5. Anular dos veces la misma venta lanza error (defensa en profundidad;
 *    la UI también lo bloquea).
 *
 * Campos de cliente soportados:
 * - Identidad: sale.customerId (ventas de checkout) o sale.clienteId
 *   (COBRO_DEUDA / VENTA_FIADA manuales del TransactionModal).
 * - Saldos: deuda y favor son los campos canónicos que leen las vistas.
 *   Se sigue escribiendo saldo_favor por compatibilidad con datos legacy,
 *   y el par (favor, deuda) se normaliza con la regla de oro de
 *   financialLogic (saldoNeto >= 0 => favor = neto, deuda = 0, y viceversa).
 */

function resolveCustomerId(sale) {
    return sale.customerId ?? sale.clienteId ?? null;
}

function resolveVoidBusinessDate(sale, sessionDate, fallbackDate = null) {
    // Status quo (decisión confirmada con producto): el reverso hereda la
    // fecha comercial de la venta ORIGINAL. Prioridad: fecha explícita de la
    // venta > fecha de la sesión abierta (solo rescata movimientos legacy sin
    // fecha explícita que pertenecen al turno) > timestamp > hoy.
    const candidates = [sale?.fechaComercial, sale?.businessDate, sessionDate];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && DATE_RE.test(candidate)) return candidate;
    }
    if (sale?.timestamp) {
        const parsed = new Date(sale.timestamp);
        if (!Number.isNaN(parsed.getTime())) return getLocalISODate(parsed);
    }
    return fallbackDate || getLocalISODate(new Date());
}

export function buildVoidMutation({
    sale,
    currentSales,
    currentProducts = [],
    currentCustomers = [],
    options = {},
    user = null,
    sessionDate = null,
    now = new Date(),
} = {}) {
    if (!sale) throw new Error('Sale object is required to void.');
    if (!Array.isArray(currentSales)) throw new Error('currentSales must be an array.');

    // ── Defensa en profundidad: prohibido anular dos veces ──
    if (sale.tipo === 'ANULACION_VENTA') {
        throw new Error('No se puede anular una transacción de reverso (ANULACION_VENTA).');
    }
    if (sale.relatedVoidId || sale.voidedAt || sale.status === 'ANULADA') {
        throw new Error('La venta ya fue anulada.');
    }

    const { skipRestock = false, skipRevertMoney = false } = options;

    // ── 1. Transacción de reverso en negativo + metadatos en la original ──
    const voidId = `void_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
    const voidTimestamp = now.toISOString();

    const voidTransaction = {
        id: voidId,
        tipo: 'ANULACION_VENTA',
        status: 'COMPLETADA',
        originSaleId: sale.id,
        originSaleNumber: sale.saleNumber,
        timestamp: voidTimestamp,
        fechaComercial: resolveVoidBusinessDate(sale, sessionDate),
        horaComercial: getLocalISOTime(now),
        cierreId: null,
        cajaCerrada: false,
        totalUsd: -(sale.totalUsd || 0),
        totalBs: -(sale.totalBs || 0),
        rate: sale.rate,
        items: sale.items ? sale.items.map(i => ({ ...i, qty: -Math.abs(i.qty) })) : [],
        payments: sale.payments ? sale.payments.map(p => ({
            ...p,
            amount: -(p.amount || 0),
            amountUsd: p.amountUsd != null ? -p.amountUsd : undefined,
            amountBs: p.amountBs != null ? -p.amountBs : undefined,
        })) : [],
        customerId: sale.customerId ?? sale.clienteId,
        customerName: sale.customerName ?? sale.clienteName,
        saleNumber: sale.saleNumber,
        changeUsd: sale.changeUsd ? -(sale.changeUsd) : 0,
        changeBs: sale.changeBs ? -(sale.changeBs) : 0,
    };

    let foundOriginal = false;
    const updatedSales = currentSales.map(s => {
        if (s.id === sale.id) {
            foundOriginal = true;
            return {
                ...s,
                voidedAt: voidTimestamp,
                voidedBy: user?.id ?? null,
                relatedVoidId: voidId,
            };
        }
        return s;
    });
    if (!foundOriginal) {
        throw new Error('La venta a anular no está en el historial actual.');
    }
    updatedSales.unshift(voidTransaction);

    // ── 2. Revertir stock (saltar si skipRestock) ──
    let updatedProducts = [...currentProducts];
    if (!skipRestock && sale.items && sale.items.length > 0) {
        updatedProducts = currentProducts.map(p => {
            const itemsInSale = sale.items.filter(i => (i._originalId || i.id) === p.id);
            if (itemsInSale.length > 0) {
                const totalToRestore = itemsInSale.reduce((sum, item) => {
                    if (item.isWeight) return sum + item.qty;
                    if (item._mode === 'unit') return sum + (item.qty / (item._unitsPerPackage || 1));
                    return sum + item.qty;
                }, 0);
                return { ...p, stock: (p.stock || 0) + totalToRestore };
            }
            return p;
        });
    }

    // ── 3. Revertir dinero del cliente (saltar si skipRevertMoney) ──
    let updatedCustomers = [...currentCustomers];
    if (!skipRevertMoney) {
        const customerId = resolveCustomerId(sale);
        const fiadoAmountUsd = sale.fiadoUsd || (sale.tipo === 'VENTA_FIADA' ? sale.totalUsd : 0) || 0;
        // M1: anular un abono (COBRO_DEUDA) devuelve la deuda que ese abono pagó.
        const abonoUsd = sale.tipo === 'COBRO_DEUDA' ? (sale.totalUsd || 0) : 0;
        // El favor consumido (`saldo_favor` como método de pago) solo aplica a
        // VENTAS: checkoutProcessor Q0 es el único flujo que decrementa el
        // saldo a favor. Los abonos se crean vía `vueltoParaMonedero`
        // (deuda primero) y NUNCA consumen favor, así que su reverso no debe
        // sumarlo de vuelta (evita duplicar el saldo).
        const favorUsed = sale.tipo === 'COBRO_DEUDA'
            ? 0
            : sale.payments?.filter(p => p.methodId === 'saldo_favor').reduce((sum, p) => sum + (p.amountUsd || 0), 0) || 0;

        if (customerId && (fiadoAmountUsd > 0 || favorUsed > 0 || abonoUsd > 0)) {
            updatedCustomers = currentCustomers.map(c => {
                if (c.id !== customerId) return c;
                const newDeuda = round2(Math.max(0, (c.deuda || 0) - fiadoAmountUsd + abonoUsd));
                const newFavor = round2((c.favor || 0) + favorUsed);
                // Regla de oro (financialLogic): solo uno de los dos saldos puede existir.
                const saldoNeto = round2(newFavor - newDeuda);
                const favor = saldoNeto >= 0 ? saldoNeto : 0;
                const deuda = saldoNeto >= 0 ? 0 : round2(Math.abs(saldoNeto));
                return { ...c, deuda, favor, saldo_favor: favor };
            });
        }
    }

    return { voidTransaction, updatedSales, updatedProducts, updatedCustomers };
}

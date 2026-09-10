import { storageService } from './storageService';
import { logEvent } from '../services/auditService';
import { useAuthStore } from '../hooks/store/useAuthStore';
import { createNotification, NOTIF_TYPES } from '../services/notificationService';
import { getOpenCashSession, getSaleBusinessDate, isMovementInCashSession } from './closureLogic';
import { buildVoidMutation } from './voidSaleCore';

const SALES_KEY = 'bodega_sales_v1';
const CUSTOMERS_KEY = 'bodega_customers_v1';

/**
 * DECISIÓN DE PRODUCTO (confirmada en la auditoría de anulaciones post-cierre):
 * el reverso ANULACION_VENTA hereda la fecha comercial de la venta ORIGINAL,
 * incluso cuando la venta ya pasó por cierre de caja. Consecuencia aceptada:
 * el reverso no es barrido por el siguiente cierre normal de la sesión
 * abierta; queda como movimiento pendiente hasta la corrección histórica de
 * cierres (wizard), que es la herramienta designada para incorporarlo.
 *
 * El núcleo puro de la mutación vive en `voidSaleCore.js` (testeable en Node
 * sin mocks); este wrapper solo resuelve contexto, persiste y notifica.
 */
export async function processVoidSale(sale, currentSales, currentProducts, options = {}) {
    if (!sale) throw new Error("Sale object is required to void.");
    const { skipRestock = false, skipRevertMoney = false } = options;

    const user = useAuthStore.getState().usuarioActivo;
    const now = new Date();
    const openSession = getOpenCashSession(currentSales);
    const sessionDate = openSession && isMovementInCashSession(sale, openSession)
        ? openSession.businessDate
        : getSaleBusinessDate(sale);

    // El wrapper carga el estado actual de clientes desde storage: es la
    // fuente de verdad para revertir deudas/saldos (igual que antes de la
    // extracción del núcleo).
    const savedCustomers = await storageService.getItem(CUSTOMERS_KEY, []);

    const { updatedSales, updatedProducts, updatedCustomers } = buildVoidMutation({
        sale,
        currentSales,
        currentProducts,
        currentCustomers: savedCustomers,
        options: { skipRestock, skipRevertMoney },
        user,
        sessionDate,
        now,
    });

    // ── Guardar todo ──
    await storageService.setItem(SALES_KEY, updatedSales);
    await storageService.setItem(CUSTOMERS_KEY, updatedCustomers);

    logEvent('VENTA', 'VENTA_ANULADA', `Venta #${sale.saleNumber || '?'} anulada - $${sale.totalUsd?.toFixed(2)}`, user, { saleId: sale.id });
    createNotification(
        NOTIF_TYPES.VENTA_ANULADA,
        'Venta anulada',
        `Venta #${sale.saleNumber || '?'} — $${sale.totalUsd?.toFixed(2)} anulada por ${user?.nombre || 'Usuario'}`,
        { saleId: sale.id, totalUsd: sale.totalUsd, userId: user?.id }
    );

    return { updatedSales, updatedProducts, updatedCustomers };
}

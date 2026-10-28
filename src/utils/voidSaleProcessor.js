import { formatSaleNumber } from './saleNumbering';
import { storageService } from './storageService';
import { logEvent } from '../services/auditService';
import { useAuthStore } from '../hooks/store/useAuthStore';
import { createNotification, NOTIF_TYPES } from '../services/notificationService';
import { getOpenCashSession, getSaleBusinessDate, isMovementInCashSession } from './closureLogic';
import { buildVoidMutation, buildVoidRestockOperations } from './voidSaleCore';
import { applyStockOperation, foldStockOutcome } from '../services/inventoryOperationService';
import { asLocalOnlyIfUnknown } from '../sync/stockResolution';
import { inventoryQueueService } from '../services/inventoryQueueService';
import { getActiveAccountId } from '../config/storageScope';

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

    // ── Fase 3: restitución de stock por el contrato de operación ──
    // UNA operación ANULACION durable e idempotente por producto, asociada a
    // la venta original (origin_ref = sale.id) con operation_id determinista
    // derivado de (venta, producto): reintentar o re-ejecutar tras un cuelgue
    // reenvía el MISMO ID y el servidor responde already_processed — jamás
    // repone dos veces. Lo no confirmado queda PENDIENTE en la cola offline con
    // su operation_id, nunca como confirmado. Se ejecuta ANTES de sellar la
    // venta: si el proceso muere a mitad, la re-ejecución converge (mismos IDs).
    let finalProducts = updatedProducts;
    const restockOps = skipRestock ? [] : buildVoidRestockOperations(sale, currentProducts, {
        accountId: getActiveAccountId(),
        deviceId: null,
        actor: user?.id ?? null,
    });
    if (restockOps.length > 0) {
        const referenceById = new Map(currentProducts.map(p => [p.id, Number(p.stock ?? 0)]));
        for (const operation of restockOps) {
            const outcome = asLocalOnlyIfUnknown(
                await applyStockOperation(operation, { fetchImpl: options.fetchImpl })
            );
            // A7: la restitución del núcleo ya está en el stock local; el
            // resultado solo decide el estado (synced/local_only o 'pending').
            finalProducts = foldStockOutcome(finalProducts, operation.product_id, outcome);
            if (outcome.outcome !== 'confirmed') {
                inventoryQueueService
                    .addOperationToQueue(operation, { referenceStock: referenceById.get(operation.product_id) ?? null })
                    .catch(err => console.warn('[Void Restock] No se pudo encolar la operación pendiente:', err?.message || err));
            }
        }
    }

    // ── Guardar todo ──
    await storageService.setItem(SALES_KEY, updatedSales);
    await storageService.setItem(CUSTOMERS_KEY, updatedCustomers);
    if (restockOps.length > 0) {
        await storageService.setItem('bodega_products_v1', finalProducts);
    }

    logEvent('VENTA', 'VENTA_ANULADA', `Venta #${formatSaleNumber(sale) || '?'} anulada - $${sale.totalUsd?.toFixed(2)}`, user, { saleId: sale.id });
    createNotification(
        NOTIF_TYPES.VENTA_ANULADA,
        'Venta anulada',
        `Venta #${formatSaleNumber(sale) || '?'} — $${sale.totalUsd?.toFixed(2)} anulada por ${user?.nombre || 'Usuario'}`,
        { saleId: sale.id, totalUsd: sale.totalUsd, userId: user?.id }
    );

    return { updatedSales, updatedProducts: finalProducts, updatedCustomers };
}

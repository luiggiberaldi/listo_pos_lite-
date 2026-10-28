/**
 * Resolución LOCAL del stock tras una operación de inventario (mitigación A7).
 *
 * Contexto: la tabla public.products del servidor solo recibe productos cuando
 * se venden (con stock 0) y no tiene cuenta propietaria; por eso su saldo NO es
 * todavía la verdad del inventario real. Hasta la Fase C (sembrar el stock real
 * en el servidor), copiar `stock_after` del servidor sobre el stock local
 * corrompía el inventario: un producto con 40 uds al que se le sumaban 5
 * quedaba en el saldo del servidor (p. ej. 2) y ese valor se replicaba a todos
 * los dispositivos.
 *
 * Regla mientras tanto: el cliente aplica la operación sobre SU stock.
 *   - modo 'delta' → stock local + cantidad
 *   - modo 'count' → cantidad contada
 *   - already_processed → el reintento ya estaba aplicado localmente: no se repite
 * El saldo del servidor se guarda aparte (stockServer) solo como diagnóstico.
 */
import { normalizeStockQuantity } from '../utils/quantityRules.js';

export function isUnknownProductResult(outcome) {
    return outcome?.outcome === 'invalid'
        && /desconocido/i.test(String(outcome?.result?.message || ''));
}

export function resolveLocalStock({ currentStock, operation, status, unit = 'unidad' }) {
    const current = Number(currentStock ?? 0);
    if (status === 'already_processed') return normalizeStockQuantity(current, unit);
    const qty = Number(operation?.quantity ?? 0);
    if (operation?.mode === 'count') return normalizeStockQuantity(qty, unit);
    return normalizeStockQuantity(current + qty, unit);
}

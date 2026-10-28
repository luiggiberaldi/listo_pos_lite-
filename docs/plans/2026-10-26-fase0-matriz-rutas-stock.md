# Fase 0 — Matriz de rutas que cambian stock (con delta)

> **Fecha:** 2026-10-26
> **Estado:** salida de la Fase 0 del [plan pre-Kardex](2026-10-13-pre-kardex-stock-integrity.md); en curso
> **Cómo se construyó:** análisis del código del sandbox `staging/` (idéntico al repo) + pruebas unitarias (62/62 en `tests/`) + verificación en vivo contra el proyecto staging "listoposlite staging" (`kkwqarueckiyytdqgqck`) el 2026-10-26.
> **Alcance:** únicamente identificar quién cambia `stock` y con qué delta. No implementa correcciones.

## Resumen

**14 rutas** cambian stock: 2 en el servidor (tabla `products.stock`) y 12 en el cliente (reemplazo del array `bodega_products_v1`). Solo 2 dejan un rastro parecido a un movimiento de inventario (los ajustes rápidos, y lo hacen en la tabla equivocada: `bodega_sales_v1`). Ninguna es idempotente salvo `process_checkout` vía `queue_id`, que el camino online ni siquiera usa.

## 1. Matriz de rutas

### A. Ámbito servidor — tabla `products.stock` (Supabase)

| # | Ruta | Disparador | Δ stock | Política de negativos | Registro que deja | Idempotencia | Riesgo para el Kardex |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `process_checkout` (RPC; hoy [006_security_and_checkout_hardening.sql](../../migrations/006_security_and_checkout_hardening.sql)) | `POST /api/checkout` desde `src/worker.js` o `api/checkout.js` | **−qty por línea**, crudo (sin normalizar unidad), serializado con `FOR UPDATE` | **Siempre permite negativos**; si `new_stock < 0` inserta `inventory_adjustments` (delta −qty, stock_after) con `reason` por defecto `'offline_sync_conflict'` | `sales` + `sale_items` + `journal_entries` (+ `inventory_adjustments` si negativo). **Sin movimiento de inventario** | `sales.queue_id` UNIQUE (solo si el payload lo envía; el online no lo envía) | Única mutación transaccional: es la base donde el futuro movimiento debe escribirse. El `reason` del ajuste por venta es engañoso |
| 2 | Upsert de productos del Worker (`src/worker.js`, `handleCheckout` paso 1) | ídem #1 | **0** (crea producto desconocido con `stock: 0`, `ON CONFLICT DO NOTHING`) | n/a | fila fantasma en `products` | n/a | Item con ID no-UUID → UUID **aleatorio por intento**: producto fantasma sin relación con el catálogo (hallazgo 6) |

### B. Ámbito cliente — array completo `bodega_products_v1` (IndexedDB + `sync_documents`)

| # | Ruta | Disparador | Δ stock | Política de negativos | Registro que deja | Riesgo para el Kardex |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Descuento post-venta — `checkoutProcessor.js` (~165-184) | Tras cada venta (online y offline) | **−qty por línea** con conversiones (peso: suma directa; `_mode:'unit'`: qty ÷ unidadesPorPaquete) | Clamp a 0 si `allow_negative_stock` está off — **diverge del servidor, que sí baja a negativo** | Ninguno | Dos semánticas de un mismo delta según dispositivo |
| 4 | `adjustStock` — `ProductContext.jsx` (~195-208) + wrapper `ProductsView.jsx` (~127-150) | Botones +/− del catálogo | **±delta explícito** | Clamp a 0 según `allow_negative_stock` | Evento `AJUSTE_ENTRADA`/`AJUSTE_SALIDA` empujado a **`bodega_sales_v1`** (tabla equivocada) | Única ruta con "movimiento", pero no es un libro de inventario |
| 5 | `setProductStock` / `handleQuickStockSave` — `ProductContext.jsx` (~210-225), `ProductsView.jsx` (~53-93) | Modal "Ajuste rápido" (add/set) | **objetivo − actual** (redondeo por unidad: kg/litro 3 decimales, resto enteros) | Clamp a 0 según config | Igual que #4 | Doble escritura del mismo estado (setProductStock + re-mapeo + push) |
| 6 | Alta/edición de producto — `productProcessor.buildProductPayload` + `ProductsView.jsx` (~373-410) | Guardar formulario de producto | **incidental: stock del formulario − actual** | Clamp en el form | Ninguno | Editar solo nombre/precio puede reescribir cantidades (hallazgo 3) |
| 7 | Vaciado masivo — `stockUtils.bulkZeroProductStock` vía `handleExecuteZeroStock` (`ProductsView.jsx` ~97-124) | Modal "Stock en 0" (todo/categoría/selección) | **−stockActual → 0** (también `stockInLotes: 0`) | n/a (fuerza 0) | Solo auditoría `STOCK_CERO_MASIVO`; **sin movimiento** | Vaciado silencioso masivo (hallazgo 7) |
| 8 | Importación compartida — `ShareInventoryModal.confirmImport` (~138-165) | Importar inventario por código | **reemplazo total**: importado − actual | hereda el importado | Ninguno | Sin modo explícito (catálogo vs cantidades) ni advertencia |
| 9 | Anulación — `voidSaleCore.buildVoidMutation` (~127-143) vía `voidSaleProcessor`, `DashboardView`, `ReportsView` | Anular venta | **+qty por línea** (mismas conversiones que #3), salvo `skipRestock` según opciones de cierre | n/a | Reverso `ANULACION_VENTA` en ventas; **sin movimiento de inventario** | La doble anulación lanza error (guard implementado) |
| 10 | Pull de nube — `useCloudSync._applyFromCloud` (~380-424) | Sincronización (poll/realtime/login) | **reemplazo total**: remoto − local | hereda el remoto | Ninguno | Para `bodega_products_v1` el remoto es "autoritativo" y **no aplica protección de timestamps** → sobrescritura entre dispositivos (hallazgo 3) |
| 11 | Restauración de backups — `SettingsModal`, `SettingsView` (~124+), `SuperAdminModal` (factory reset) | Importar/restore/reset | **reemplazo total** (el reset deja catálogo vacío: −actual) | n/a | Ninguno | Puede vaciar todo el stock sin trazas |
| 12 | Inyectores de prueba — `src/testing/*` | Herramientas de desarrollo | arbitrario | arbitrario | Ninguno | Solo entorno de pruebas |
| 13 | "Venta Libre" — `SalesView.jsx` (~664-672) | Monto libre en el POS | crea producto sintético `custom_*` con `stock: 9999` **solo en el carrito** (no existe en el catálogo local) | n/a local | Ninguno | El Worker lo crea en `products` con stock 0 y el RPC lo descuenta → **stock negativo + `inventory_adjustments` espurio** |
| 14 | Baja de producto — `ProductsView.handleDelete` (~486-492) | Eliminar producto | el stock **desaparece** con la fila del catálogo | n/a | Ninguno (el historial conserva solo el nombre en `items`) | Borrado sin archivo: la historia se vuelve ilegible (hallazgo 7) |

## 2. Normalización de unidades (semántica del delta)

| Unidad / modo | Normalización | Dónde |
| --- | --- | --- |
| `unidad` / `paquete` | enteros (`Math.round`) | `stockUtils.normalizeStockQuantity` |
| `kg` / `litro` | 3 decimales | ídem |
| Producto por lote | unidades = lotes × `unitsPerPackage` | `productProcessor.buildProductPayload` |
| Item de venta `_mode:'unit'` | qty ÷ `unitsPerPackage` | `checkoutProcessor` y `voidSaleCore` (descuento/reintegro) |
| Item por peso (`isWeight`) | suma directa | ídem |
| **Servidor (`process_checkout`)** | **qty sin normalizar** (`numeric(15,4)`) | migración 006 |

**Divergencia:** el cliente redondea/trunca según unidad y política de negativos; el servidor resta la cantidad cruda y siempre permite negativos. Un mismo movimiento puede producir dos saldos distintos.

## 3. Identidad de productos legacy (política propuesta para Fase 1/2)

Hoy, `checkoutProcessor.toUuid` y el Worker sustituyen cualquier ID no-UUID por un **UUID aleatorio por intento**, y el Worker además crea el producto sustituto con stock 0. Propuesta (sin implementar): resolver el ID canónico antes del primer envío persistiendo el mapeo local→canónico, o **rechazar** el checkout con error recuperable; nunca generar un ID sin mapeo.

## 4. Lista confirmada de operaciones que cambian stock

1. **VENTA** — delta −qty (rutas 1 y 3; el mismo evento se aplica dos veces, una por ámbito).
2. **AJUSTE_DIRECTO** — delta ±explícito o objetivo−actual (rutas 4-5).
3. **VACIADO_MASIVO** — delta −stockActual → 0 (ruta 7).
4. **IMPORTACIÓN / RESTAURACIÓN / RESET** — reemplazo total (rutas 8 y 11).
5. **ANULACIÓN** — delta +qty opcional (ruta 9).
6. **SINCRONIZACIÓN_NUBE (pull)** — reemplazo total (ruta 10).
7. **ALTA / EDICIÓN / BAJA de producto** — delta incidental o desaparición (rutas 6, 13 y 14).
8. **SERVIDOR: `process_checkout`** — delta −qty transaccional (ruta 1).

## 5. Evidencia de verificación (sandbox)

- `node --test` en `staging/`: **62/62** — cubren clamp de negativos (`tests/stockAdjustment.test.mjs`), vaciado masivo, anulaciones con/sin reintegro (`tests/voidSaleCore.test.mjs`) y scope de cuentas (`tests/syncSafety.test.mjs`).
- En vivo contra staging (2026-10-26): checkout online −2 uds (231 → 229) y checkout offline_sync −5 uds (292 → 287); **0** `inventory_adjustments`; doble entrada balanceada; reintento con mismo `queue_id` = 1 sola venta.
- Contrato de tablas confirmado por introspección (producción y staging idénticos): `products.stock numeric(15,4)`, `sale_items.quantity numeric(15,4)`, `inventory_adjustments(delta, stock_after, reason, resolved)`.
- Revalidación 2026-10-26 (tras ampliar los datos sintéticos con cierres de caja, proveedores, facturas y pagos a proveedor): esas operaciones **no** cambian stock (los cierres y `PAGO_PROVEEDOR` solo mueven dinero), por lo que el inventario de 14 rutas sigue completo; las citas de `checkoutProcessor.js`, `voidSaleCore.js` y `stockUtils.js` verificadas contra el código actual del sandbox.

## 6. Pendientes para cerrar la Fase 0

- Ensayo de **respaldo/restauración** sobre staging con conteos antes/después (ítem del plan aún no ejecutado).
- Prueba explícita de conversiones kg/litro/lote en el descuento de venta (parcialmente cubierta por `stockAdjustment.test.mjs`).
- Decisión formal de la política de IDs legacy (sección 3).
- Confirmar qué `reason` debe llevar `inventory_adjustments` cuando la causa es una venta (hoy `'offline_sync_conflict'` por defecto).

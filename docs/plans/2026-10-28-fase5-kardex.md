# Fase 5 — Kardex (libreta de movimientos por producto)

> **Fecha:** 2026-10-28 · **Rama:** `feat/kardex-fase5` (sale de `main` con el PR #2 ya publicado).
> **Plan de fondo:** [pre-Kardex, Fase 5](2026-10-13-pre-kardex-stock-integrity.md#fase-5--preparación-del-corte-de-apertura-para-el-futuro-kardex).
> **Decisiones del usuario:** alcance **completo** (libreta + apertura + pantalla); la apertura la inicia el **dueño con un botón**, **con o sin conteo físico** previo (puede empezar "tal cual está").

## Qué hay hoy (producción, 28-oct)

- `inventory_operations` (008) ya registra, una sola vez y con saldo antes/después: ajustes, conteos, vaciado, importación y anulaciones (`apply_inventory_operation`).
- **Las ventas NO dejan movimiento**: `process_checkout` descuenta `products.stock` pero no escribe en la libreta.
- **No existe corte de apertura** ni pantalla: el "Kardex Lite" del formulario de producto lee las ventas locales y ya no ve los ajustes nuevos.
- `products` y `sales` no tienen `account_id` (los usuarios cajeros son locales, PIN dentro de una misma cuenta de Supabase). `inventory_operations` sí lo tiene y los proxies lo ponen desde el token → la libreta se filtra por cuenta.

## Diseño

### A. Base de datos — migración 013 (aditiva)

1. **Ventas en la libreta:** `process_checkout` inserta, por cada línea con producto, un movimiento `VENTA` en la misma transacción: `delta = −stock_qty`, saldo antes/después, `origin_ref` = id de la venta, `account_id` de la venta. `operation_id` determinista (`md5('venta:' || sale_id || ':' || n.º de línea)`), así un reintento no puede duplicarlo (la venta ya es idempotente por `queue_id`). Venta Libre (sin producto) no deja movimiento.
2. **Corte de apertura:** tabla `kardex_openings` (una fila por cuenta: fecha, quién, dispositivo, n.º de productos) y RPC `open_kardex(payload)`:
   - recibe la lista de productos del dispositivo con el stock **que se ve en pantalla**;
   - por cada producto registra un movimiento `APERTURA` (modo conteo): saldo antes = servidor, saldo después = pantalla; si difieren, el servidor queda igual que la pantalla y la diferencia queda anotada;
   - una sola vez por cuenta (`already_opened` si se repite); todo en una transacción; productos que el servidor no conoce se informan (el cliente sube el catálogo y reintenta).
3. **Productos nuevos después del corte:** `sync_product_catalog` registra un `APERTURA` ("alta de producto") con el stock inicial al **crear** la fila (`/api/catalog-sync` pasa a enviar `account_id` del token).
4. Compatibilidad: la firma y las respuestas de `process_checkout` no cambian → la app vieja sigue funcionando; se puede aplicar antes que el código.

### B. API (Worker y Vercel)

- `GET /api/kardex?product_id=…` → apertura de la cuenta + movimientos del producto desde la apertura (solo la cuenta del token).
- `POST /api/kardex-open` → `open_kardex` con `account_id` del token.
- Añadir las excepciones en `.gitignore` (`api/*.js` está ignorado salvo la lista) — mismo error que ya pasó con `/api/inventory-operation`.

### C. App

- **Botón "Iniciar Kardex"** (solo dueño/administrador): explica que puede contar antes o empezar tal cual; sube el catálogo, envía el stock actual y muestra el resultado. Si ya se inició, muestra la fecha.
- **Sección "Kardex" en el formulario de producto** (reemplaza "Movimientos Recientes"): fecha, tipo (Apertura, Venta, Anulación, Ajuste, Conteo, Vaciado), entra/sale, saldo y referencia. **Pendientes sin internet aparte** (colas de ventas e inventario) y nunca mezclados con lo confirmado. Sin internet: aviso y solo pendientes.
- Comprobación visible: apertura + suma de movimientos = saldo del servidor.

### D. Pruebas y publicación

- `npm test` (servicio del Kardex, armado de la lista, pendientes aparte) y `npm run build`.
- 013 en **staging** (editor SQL del panel, sesión del usuario) y aceptación en vivo: venta → movimiento; reintento → sin duplicado; anulación; apertura dos veces → una; producto nuevo → alta; **saldo = apertura + movimientos** para cada producto tocado.
- Prueba en el navegador contra staging (`staging/.repo-run`, regenerar la copia del Worker con la URL de staging).
- Producción con el mismo procedimiento que la 010-012: respaldo → 013 con huellas → `data:verify` → unir PR.

## Aceptación (del plan de fondo)

Para cada producto: **saldo final = saldo de apertura + suma de movimientos confirmados**; pendientes aparte; operaciones rechazadas nunca aparecen como confirmadas.

## Fuera de alcance

Compras/facturas de proveedor como entradas, costo promedio, exportar a Excel/PDF, filtros por fecha y reconstrucción del pasado anterior a la apertura.

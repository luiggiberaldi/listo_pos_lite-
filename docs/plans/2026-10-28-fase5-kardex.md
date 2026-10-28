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

## Pantalla Movimientos (añadida a pedido del usuario, 28-oct)

- **Inventario → Movimientos**: todos los movimientos de la cuenta desde la apertura, agrupados por día. Filtros: Hoy / Ayer / 7 días / Este mes / Todo / elegir fechas; buscar producto (nombre o código); tipo (ventas, anulaciones, ajustes y conteos, saldos iniciales). Resumen del rango (entradas, salidas, n.º de movimientos) calculado en el servidor (`kardex_summary`), páginas de 50 con "Ver más" y descarga a Excel (CSV con `;`, BOM y coma decimal).
- Tocar un producto filtra por él y muestra su libreta: saldo inicial + entradas − salidas = saldo hoy, en unidades y cajas, con la marca "La libreta cuadra".
- La ficha del producto muestra solo los **últimos 5** y "Ver todos" abre Movimientos filtrada por ese producto.
- Lo pendiente del dispositivo (colas) aparece aparte en amarillo y no suma.
- El movimiento VENTA guarda `origin_ref = queue_id` (para mostrar el n.º de venta local) y quién cobró (`actor`).
- Regla de UI del usuario: desplegables siempre redondeados (`src/components/ui/RoundedSelect.jsx`).

## Correcciones encontradas en la prueba

- Editar un producto cambiaba el stock a escondidas (lotes con el n.º de cajas viejo: 48 → 60; granel truncado: 37.25 → 37). Ahora solo cambia si se toca el campo, y como CONTEO (queda en el Kardex).
- El resumen de "Iniciar Kardex" se cerraba solo.
- Dos pruebas de la cola de inventario dependían de la fecha real (fallaban desde el 28-oct).

## Estado en staging (2026-10-28)

- 013 aplicada (texto verificado por SHA-256 `bad5fa9f…` antes de ejecutar). Huellas `md5(prosrc)`:
  - `process_checkout` = `2312573529de4df66a6617bfc6f85100`
  - `sync_product_catalog` = `44d3590da4a06bc0a39981ea8e8ee3e6`
  - `open_kardex` = `0d23447ae844367962d82d88889c9ab7`
  - `kardex_summary` = `26f5b01079c3ae6ba17eaa403885364a`
  - `apply_inventory_operation` sin cambios = `2154af97adb1b7b2827aafa506f082c3`
- Aceptación en vivo `staging/scripts/acceptance-kardex.mjs`: **29/29**. `data:verify` contra la foto previa: 0 violaciones.
- Navegador (app de la rama contra staging): Iniciar Kardex (9 productos, 6 ajustados), venta de 1 caja (48 → 36), editar sin tocar stock (sigue 36), cambiar lotes 3 → 4 (Conteo +12), granel 37.25 intacto, Movimientos con filtros y "Ver todos" desde la ficha. `staging/scripts/kardex-check.mjs`: 9/9 productos cuadran.
- `npm test` 196/196, `npm run build` ✓.

## Publicación en producción (ejecutada 2026-10-28, con OK del usuario)

- Respaldo completo `backups/fgzwmwrugerptfqfrsjd-2026-10-28T15-45-37-795Z` (sales 8640, products 2040) y foto de no-destrucción.
- 013 aplicada con `apply_migration`; las 5 huellas coinciden con staging; RLS en `kardex_openings` e índice creados; `data:verify` 0 violaciones.
- Después: unir el PR y comprobar el despliegue de Vercel.

Procedimiento:

Mismo procedimiento que 010-012: respaldo → 013 con `apply_migration` → comprobar las huellas de arriba → `data:verify` → unir el PR. 013 es compatible con la app actual (misma firma y respuesta de `process_checkout`), así que va antes que el código. Vuelta atrás del código: Instant Rollback en Vercel; la base puede quedarse con 013.

# Plan de corrección de integridad de stock previo al Kardex

> **Fecha:** 2026-10-13  
> **Estado:** Propuesta para aprobación; no implementado  
> **Alcance:** Un inventario global por cuenta, cantidades únicamente, facturas de proveedor sin impacto en stock.  
> **Dependencias de producto confirmadas:** saldo inicial por corte de apertura; política de stock negativo según la configuración actual; checkout online autoritativo y ventas offline reconciliables.

## Objetivo principal

**Dejar el sistema y su base de datos preparados para agregar un Kardex completo, sin comprometer, borrar ni alterar accidentalmente los datos de los usuarios activos.** La preparación debe eliminar rutas de actualización de inventario que compiten entre sí y definir una sola semántica para confirmar stock. Al terminar, cada operación actualizará el saldo una sola vez, conservará ventas offline, será idempotente al reintentar y podrá producir un movimiento confiable.

La seguridad de datos es un requisito de salida, no una tarea opcional: todo cambio se desarrollará y verificará primero contra un clon de staging aislado; se usarán datos sintéticos o anonimizados; no se copiarán usuarios, credenciales ni secretos de producción. Las migraciones serán aditivas y compatibles durante la transición, sin borrar o reescribir tablas/registros existentes ni ejecutar correcciones masivas de stock. Se hará respaldo verificable y se ensayará la reversión/rollback en staging. **No hay garantía de riesgo cero:** producción no se tocará hasta aprobar explícitamente el resultado de staging, los respaldos, las comprobaciones y el procedimiento de despliegue.

Este plan corrige la infraestructura que el Kardex necesitará. **No implementa todavía la pantalla, exportación ni consulta histórica del Kardex.** Tampoco autoriza aplicar cambios a producción.

### Principios de protección de datos activos

1. Staging tendrá URL, claves, usuarios y base de datos propios; bloquear cualquier ejecución de migración/seed si la URL no es inequívocamente de staging/local.
2. Antes de cada cambio SQL: identificar el proyecto destino, revisar el historial real de migraciones aplicadas, comprobar el esquema y validar que no haya operaciones destructivas (`DROP`, `TRUNCATE`, borrado general, reset o actualización de stock en masa) no aprobadas.
3. Preferir migraciones expand/contract: agregar objetos y columnas compatibles primero; mantener el comportamiento anterior durante la transición; retirar compatibilidad solo en una fase separada y aprobada.
4. Verificar antes/después conteos y muestras de productos, ventas, usuarios y claves por cuenta. En staging, probar restauración del backup. No usar datos personales productivos para pruebas.
5. Cambios de saldo existentes solo mediante operaciones explícitas con trazabilidad. No inferir ni ajustar saldos históricos automáticamente; los saldos vigentes se fijan en el corte de apertura aprobado.
6. La promoción a producción requiere una aprobación posterior específica. Tener credenciales o un archivo local no autoriza escribir en producción.

**Criterio de bloqueo:** si no se puede comprobar entorno, respaldo, alcance de cuenta o compatibilidad de clientes activos, detener el despliegue; no intentar “reparar” los datos en producción.

### Fase previa — Clon de staging aislado (antes de cualquier cambio funcional o SQL)

- Crear el clon de prueba dentro de la carpeta raíz `staging/`, separado de la aplicación original.
- Apuntar el clon solo al proyecto Supabase staging. Mantener secretos fuera de Git en un archivo local ignorado; comprobar `git check-ignore` sin imprimir valores secretos.
- Confirmar que Supabase Auth siga habilitado en staging con usuarios de prueba separados; no clonar usuarios ni sesiones productivas.
- Preparar esquema y migraciones en una instancia local/staging vacía con datos sintéticos. Si se necesita validar compatibilidad con datos existentes, usar una copia anonimizada y de alcance limitado.
- Añadir guardas de entorno a scripts de migración/seed para rechazar URL o proyecto no staging/local; no incluir credenciales productivas en la configuración del clon.

**Aceptación:** el clon compila y autentica contra staging, los datos de prueba quedan aislados, credenciales no aparecen en Git ni logs y una prueba negativa confirma que la automatización se niega a apuntar a producción.

**No iniciar fases que cambien comportamiento o esquema hasta que esta fase sea aprobada.**

## Hallazgos que guían el plan

1. `processSaleTransaction` no asigna `queue_id` antes del primer intento online. Si el servidor procesa la venta pero se pierde la respuesta, el cliente puede encolarla como operación nueva y reintentarse como otra venta. La cola genera su ID después del timeout (`src/utils/checkoutProcessor.js`, `src/services/offlineQueueService.js`).
2. El descuento de stock se calcula por separado en el navegador y en `process_checkout`. El navegador puede truncar en cero cuando no se permiten negativos; el RPC resta la cantidad sin aplicar esa política (`src/utils/checkoutProcessor.js`, `migrations/004_security_and_checkout_hardening.sql`).
3. El checkout y los ajustes ordinarios escriben por vías distintas: el RPC muta filas de producto, mientras que ajustes, conteos y vaciados guardan y sincronizan arrays completos `bodega_products_v1` (`src/views/ProductsView.jsx`, `src/context/ProductContext.jsx`, `src/hooks/useCloudSync.js`). Esto permite carreras y sobrescrituras.
4. La sincronización exitosa de la cola marca la venta local como completada, pero no reconcilia el producto local con el saldo remoto (`src/services/offlineQueueService.js`).
5. El endpoint Worker intenta marcar `queue_id` después de la RPC con un PATCH no esperado (fire-and-forget); la API de Vercel sí espera el PATCH. La RPC ya acepta `queue_id`, de modo que la protección debe ocurrir en la misma transacción de checkout, sin depender de ese paso posterior (`src/worker.js`, `api/checkout.js`, `migrations/004_security_and_checkout_hardening.sql`).
6. `checkoutProcessor` sustituye un ID de producto no UUID por un UUID aleatorio; el Worker/API también normalizan IDs y crean productos desconocidos con stock cero. Sin mapeo persistido al ID local, el backend puede descontar un producto sustituto sin relación estable con el producto del catálogo.
7. Hay escrituras de stock que no generan un registro uniforme: el ajuste rápido mete eventos en ventas, pero el vaciado masivo, la edición de stock al guardar producto, importaciones y borrados no dejan un movimiento equivalente. La anulación retorna productos actualizados, pero el servicio wrapper persiste ventas y clientes, no productos directamente (`src/views/ProductsView.jsx`, `src/components/ShareInventoryModal.jsx`, `src/utils/voidSaleProcessor.js`, `src/utils/voidSaleCore.js`).
8. El `Kardex Lite` deriva hasta 20 líneas del historial financiero y busca por nombre además de ID; no es una fuente íntegra de movimientos (`src/views/ProductsView.jsx`, `src/components/Products/ProductFormModal.jsx`).

## Estrategia recomendada

Adoptar una autoridad central transaccional online para el saldo compartido y tratar los cambios offline como operaciones locales pendientes. El cliente no debe sincronizar reemplazos completos de stock para aplicar una venta o un ajuste. La API/RPC debe validar y mutar el saldo central, aplicar una política de stock común y, en la fase posterior del Kardex, insertar el movimiento en la misma transacción.

La lista de productos puede seguir sincronizando metadatos del catálogo, pero el campo `stock` debe dejar de actuar como un reemplazo autoritativo concurrente. Mientras dure una transición, las escrituras de stock de la lista deben bloquearse, aislarse o versionarse para que no reviertan una mutación transaccional central.

### Contrato de operación de inventario (preparación del Kardex)

Acordar un único comando de dominio para cambiar stock, con al menos:

- `operation_id` UUID estable asignado antes de cualquier intento online y reutilizado en fallback/reintentos.
- `account_id`, `device_id`, `actor_id` cuando estén disponibles.
- `product_id` canónico y cantidad normalizada según unidad/empaque.
- Tipo/origen de operación, motivo y referencia (venta, anulación, ajuste, conteo, apertura, vaciado).
- Política de negativo recibida/validada en servidor desde una fuente de configuración confiable; no permitir que un valor arbitrario del cliente la evada.
- Respuesta explícita: aceptada, ya procesada, conflicto de stock o fallo reintentable, con saldo central resultante y referencia remota.

En el Kardex, cada evento será inmutable, identificado por clave idempotente y contendrá delta con signo, saldo anterior/posterior, usuario, fecha, origen y producto. Correcciones futuras se representarán como reversos compensatorios. No añadir precio/costo, lotes, ubicaciones ni entradas desde facturas de proveedores en este alcance.

## Fases de trabajo

### Fase 0 — Inventario de rutas y compatibilidad

**Archivos a revisar:** `src/utils/checkoutProcessor.js`, `src/services/offlineQueueService.js`, `src/worker.js`, `api/checkout.js`, `migrations/004_security_and_checkout_hardening.sql`, `src/context/ProductContext.jsx`, `src/views/ProductsView.jsx`, `src/utils/voidSaleProcessor.js`, `src/utils/voidSaleCore.js`, `src/components/ShareInventoryModal.jsx`, `src/hooks/useCloudSync.js`.

- Enumerar todos los productores/consumidores del campo `stock`, incluidas ventas, devoluciones, ajustes, importaciones y acciones masivas.
- Confirmar el contrato actual de tablas `products`, `sales`, `sale_items` y `inventory_adjustments` en el esquema Supabase; las migraciones disponibles no reemplazan una inspección del esquema aplicado en staging.
- Comparar el historial de migraciones del repositorio con el registrado en Supabase staging; resolver numeraciones duplicadas existentes antes de crear una nueva migración. No asumir que un archivo ya fue aplicado.
- Probar desde una copia de staging consistente el cambio, el respaldo y su restauración; registrar conteos antes/después y confirmar que usuarios, ventas, productos y saldos no cambian durante la fase de inspección.
- Definir y testear conversiones entre unidad vendida y unidad de inventario (kg/litros, empaques y venta por unidad).
- Establecer una política de identidad para productos legacy no UUID: nunca generar IDs aleatorios por checkout sin guardar el mapeo; resolver el ID canónico antes del envío o rechazarlo con error recuperable.
- No hacer backfill de historia de stock durante esta fase. Las cantidades existentes se preservarán hasta un corte de apertura explícito.

**Salida:** matriz de rutas con el delta de cada una y una lista confirmada de operaciones que cambian stock — entregada en [2026-10-26-fase0-matriz-rutas-stock.md](2026-10-26-fase0-matriz-rutas-stock.md) (pendientes de cierre listados al final de ese documento).

### Fase 1 — Idempotencia antes del primer intento

**Archivos objetivo:** `src/utils/checkoutProcessor.js`, `src/services/offlineQueueService.js`, `src/worker.js`, `api/checkout.js`, pruebas de política de cola.

- Crear `operation_id` al comenzar el checkout, antes del primer `fetch`; incluirlo como `queue_id` en el payload tanto online como offline.
- Si hay timeout, pérdida de conexión o respuesta ambigua, encolar exactamente el mismo payload e ID, no crear una operación nueva.
- Mantener la unicidad de `sales.queue_id` y hacer que la RPC asigne el ID dentro de su propia transacción. Conservar los checks previos del Worker/API solo como optimización; nunca como la garantía de unicidad.
- Retirar el PATCH asíncrono posterior del Worker una vez se confirme que todos los caminos asignan el ID dentro de la RPC. Si un esquema/despliegue exige el PATCH temporalmente, la API no debe afirmar sincronización hasta recibir confirmación durable.
- En una respuesta duplicada, devolver el `sale_id` canónico y el resultado de inventario existente; no repetir descuentos ni crear movimientos secundarios.
- Revisar reintentos concurrentes desde dos pestañas/dispositivos. El guard de memoria `syncInFlight` es por instancia del navegador, no sustituye unicidad ni bloqueo en base de datos. *(Verificado: dos llamadas simultáneas con el mismo ID → una creada y una duplicada con el mismo `sale_id`, protegidas por `idx_sales_queue_id` dentro de la RPC.)*

**Aceptación:** dos solicitudes con el mismo ID, incluyendo una cuyo primer resultado se perdió, dejan una venta, un descuento y —cuando exista el Kardex— un movimiento por línea de inventario.

> **Estado (2026-10-26): implementado y verificado en el sandbox `staging/`.** `processSaleTransaction` asigna `operation_id` antes del primer `fetch` y lo envía como `queue_id` en todos los caminos; el fallback offline encola exactamente el mismo payload e ID. La RPC devuelve el `sale_id` canónico y el resultado de inventario ya aplicado en toda respuesta duplicada (`staging/migrations/007_checkout_idempotent_response.sql`, aditiva, aplicada a staging) y los PATCH posteriores del Worker/API quedaron retirados (la RPC guarda `queue_id` en su propia transacción). Aceptación en vivo contra staging: mismo ID con "respuesta perdida", carrera concurrente desde dos llamadas simultáneas y control con ID distinto → una venta y un descuento por operación, `sale_id` canónico en ambos reintentos, doble entrada balanceada una sola vez y cero ajustes espurios (15/15 comprobaciones; `node --test` 66/66). Pendiente: portar los cambios al repo principal y, en Fase 4, la reconciliación de `remoteSaleId` con el ID local.

### Fase 2 — Saldo y regla de stock uniformes

**Archivos objetivo:** `migrations/004_security_and_checkout_hardening.sql` (mediante una nueva migración versionada), `src/utils/checkoutProcessor.js`, `src/utils/stockUtils.js`, `src/worker.js`, `api/checkout.js`.

- Extraer una regla de cantidad compartida conceptualmente: cantidades válidas, normalización decimal/entera, conversión de unidad y resultado del delta.
- Aplicar en el servidor la misma política configurada de stock negativo que se usa en la UI. Asegurar que el bloqueo de fila actual sea el punto de serialización de ventas simultáneas.
- Definir lo que significa “bloquear si negativo” sin perder una venta ya cobrada offline: un conflicto de sincronización debe ser explícito y recuperable, nunca marcarse como sincronizado ni descartarse. Reconciliar según el comportamiento confirmado de la configuración; en todos los casos preservar la venta y dejar visible la diferencia para resolución.
- Crear una operación transaccional para ajustes y conteos (RPC aparte o comando de dominio incorporado a RPC) que aplique delta/conteo sobre el saldo central actual y devuelva el saldo resultante.
- Evitar que los clientes suban listas completas de productos que incluyan un stock desactualizado. Separar metadatos del catálogo de mutaciones de existencias, o filtrar/rechazar escrituras concurrentes del campo `stock` durante la transición.
- Reemplazar upserts de producto desconocido con stock cero por una regla segura: usar el producto canónico existente o impedir checkout con un ID no vinculado. No crear un “producto fantasma” con un UUID distinto al catálogo local.

**Aceptación:** checkout, ajustes y conteos concurrentes se serializan y terminan en el mismo saldo en servidor/cliente después de refrescar; una venta offline no desaparece por rechazo ni se marca sincronizada incorrectamente.

> **Estado (2026-10-26): contrato de operación de inventario implementado y verificado en el sandbox `staging/`.** `staging/migrations/008_inventory_operation_contract.sql` (aditiva) crea `inventory_operations` (append-only, `operation_id` UNIQUE) e `inventory_policies` (política de stock negativo por cuenta, definida en servidor) y la RPC `apply_inventory_operation` que serializa con `FOR UPDATE`, aplica delta/conteo y responde siempre `applied | already_processed | stock_conflict | invalid` con saldos antes/después; el INSERT con clave única reclama la operación ANTES de mutar el stock, de modo que una carrera con el mismo ID aplica el delta una sola vez. La regla de cantidad única vive en `staging/src/utils/quantityRules.js`; el cliente construye la operación con `operation_id` antes del primer intento (`staging/src/services/inventoryOperationService.js`, ruta `/api/inventory-operation` en worker y Vercel). Aceptación en vivo contra staging: 17/17 — aplicado, reintento idempotente sin doble delta, carrera concurrente con un solo delta, conflicto por política server-side sin aplicar nada y recuperable, producto desconocido/delta cero/sin ID rechazados, conteo restaurador y libro con 3 filas exactas —; `node --test` en el sandbox 75/75 y gate de no-destrucción sin indicios (snapshot pre/post 008). Pendiente del resto de Fase 2: misma política de negativos en `process_checkout`, semántica del conflicto para la venta offline ya cobrada, separar metadatos de catálogo de las mutaciones de stock y eliminar los productos fantasma del checkout.

### Fase 3 — Eliminar mutaciones silenciosas y escrituras competidoras

**Archivos objetivo:** `src/context/ProductContext.jsx`, `src/views/ProductsView.jsx`, `src/utils/stockUtils.js`, `src/utils/voidSaleProcessor.js`, `src/utils/voidSaleCore.js`, `src/components/ShareInventoryModal.jsx`.

- Cambiar `adjustStock` y `setProductStock` para invocar la operación de inventario, no actualizar stock como reemplazo de array.
- Hacer que “Añadir mercancía” y “Fijar conteo” se traduzcan a delta contra el último saldo central, con motivo/actor y validaciones de unidad. Una edición de nombre/precio no debe cambiar stock incidentalmente.
- Registrar el vaciado masivo como operaciones explícitas por producto con delta real. Confirmar el resultado antes de mostrar éxito, o marcar los cambios offline como pendientes.
- Importar inventario con modo explícito (reemplazar catálogo, mantener saldos, o corte de apertura) y advertencia si pretende cambiar cantidades; no sobrescribir stock silenciosamente.
- Al eliminar un producto con movimientos, conservar su identidad y snapshots legibles; no borrar la historia. El borrado del catálogo será lógico/archivado cuando la política de datos lo permita.
- Hacer la anulación y la restitución de stock parte de una operación durable e idempotente asociada a `originSaleId`; respetar las opciones existentes de reintegro post-cierre. Persistir en una sola operación el reverso de venta, saldo y evento de inventario, o dejarlo pendiente claramente señalado.
- Retirar el uso de `bodega_sales_v1` como registro de ajustes; la información de caja y el libro de stock son dominios distintos.

**Aceptación:** cada cambio de stock de la UI tiene un tipo/motivo y una operación única; editar solo metadatos no altera cantidad; el historial financiero no se usa como tabla de inventario.

### Fase 4 — Cola offline y reconciliación

**Archivos objetivo:** `src/services/offlineQueueService.js`, `src/services/offlineQueuePolicy.js`, `src/components/SyncStatus.jsx`, `src/utils/checkoutProcessor.js`.

- Persistir en IndexedDB el comando completo de inventario con `operation_id`, delta/unidad, saldo local de referencia, origen, estado y fecha; aislar por cuenta, como la cola actual.
- Representar estados `pending`, `synced` y `conflict/failed` claramente; nunca permitir que “dismiss failed” borre sin rastro una venta aceptada/cobrada. Para el Kardex, retener el movimiento local y su correspondencia remota.
- Tras la respuesta central, reconciliar el saldo y el ID remoto sin volver a aplicar la operación en el cliente. Refrescar el stock central o consumir el saldo devuelto por la operación.
- Reintentar con backoff existente y límite actual, pero distinguir errores transitorios de conflictos funcionales de stock/identidad; los segundos requieren explicación y una acción administrativa.
- Mantener idempotencia incluso con varias instancias o dispositivos; IndexedDB local no es árbitro global.

**Aceptación:** recarga/cierre durante sincronización, respuesta perdida, reintento, duplicado y cambio de cuenta no causan pérdida, duplicación ni cruce de operaciones.

### Fase 5 — Preparación del corte de apertura para el futuro Kardex

**Archivos objetivo futuros:** nueva migración de movimientos append-only y servicio de corte de apertura; esta fase no debe reconstruir el pasado automáticamente.

- Añadir tabla/registro append-only de movimientos de stock con restricción única sobre `operation_id`/clave idempotente, FK o referencia durable al producto, tipo, delta, saldo antes/después, timestamp, actor, origen, referencia de negocio y metadatos de sincronización.
- Desde esta fase, cada RPC central que cambia stock inserta su movimiento en la misma transacción que el saldo y la venta/ajuste/anulación.
- Crear un flujo de corte de apertura que capture una vez el saldo vigente de cada producto y lo identifique como `OPENING_BALANCE`, con fecha/hora, cuenta y usuario responsable. No atribuir movimientos previos que no puedan probarse.
- Facturas/proveedores quedan fuera del flujo de stock: no suman existencias ni generan movimientos de entrada.
- No construir la pantalla de consulta completa hasta que las fases 1–4 tengan aceptación y las operaciones ya escriban eventos fiables.

**Aceptación:** para cada producto, el saldo final es igual al saldo de apertura más la suma de deltas confirmados; pendientes se muestran aparte y las operaciones rechazadas no se presentan como confirmadas.

## Pruebas y criterios de salida

### Pruebas automatizadas

El repositorio ya usa `node:test` y `npm test`; existen pruebas de ajustes de cantidades (`tests/stockAdjustment.test.mjs`), anulaciones (`tests/voidSaleCore.test.mjs`) y seguridad de cola/scope (`tests/syncSafety.test.mjs`). Extender esos patrones antes de añadir otro runner.

- Unitarias: normalización por unidad/empaque, delta vs conteo, regla de negativos, conversión venta por paquete, identificadores estables e idempotencia.
- Pruebas de contrato de Worker/API: primer checkout, timeout tras confirmación servidor, repetición misma operación, producto legacy, resultado duplicado con ID remoto y errores HTTP.
- Pruebas de RPC/integración contra Supabase local: concurrencia sobre stock 1, dos operaciones idempotentes iguales, venta y ajuste concurrentes, política negativa y atomicidad entre venta/saldo/movimiento.
- Pruebas de sincronización local: estado de venta y movimiento antes/después del retry, reload, cuenta A/B y conflicto que no se descarta.
- Pruebas de regresión: anulaciones pre/post cierre y los cuatro estados de los permisos actuales de reintegro; importación y vaciado masivo.

### End-to-end funcional

No se encontró un runner E2E (Playwright/Cypress) configurado. No añadir una dependencia sin inspeccionar el entorno de test existente. Primero establecer integración repetible con DB local y pruebas de servicio. Si el producto requiere prueba real de interfaz, decidir/configurar un E2E como fase aprobada aparte.

Escenarios E2E mínimos cuando el harness esté disponible:

1. Checkout online descuenta una vez y actualiza el saldo al recargar.
2. El servidor confirma checkout, el cliente pierde la respuesta, reintenta el mismo `operation_id` y no duplica.
3. Venta offline aparece pendiente; al reconectar se confirma una sola vez y el saldo local queda igual al remoto.
4. Dos terminales venden concurrentemente la última unidad; resultado de saldo respeta política acordada y ambas ventas quedan trazables.
5. Ajuste/conteo concurrente con venta no sobrescribe saldo; cancelación/error no comunica éxito.
6. Anulación reintegra exactamente una vez cuando los permisos lo permiten y no cambia stock cuando está configurada para omitirlo.
7. Una escritura de catálogo/metadatos, importación o limpieza no borra el stock de otro dispositivo.

### Sign-off pre-Kardex

- Clon `staging/` aislado, Auth de staging probado con cuentas de prueba y bloqueo de destino productivo verificado.
- Backup de staging verificado y restauración ensayada; conteos/diferencias explicados. Ninguna prueba usa usuarios o secretos productivos.
- Migraciones aditivas aplicadas y verificadas únicamente en local/staging; esquema real e historial de migraciones comparados, incluidos los archivos con numeración duplicada.
- `npm test` y `npm run build` pasan.
- Verificación de RPC contra Supabase local; ninguna afirmación de corrección basada solo en tests puros.
- No queda ninguna ruta online que cambie stock por reemplazo global del array.
- Todos los checkouts tienen ID idempotente antes de la primera petición.
- El stock negativo tiene una única regla comprobable en servidor y cliente; la operación offline ya cobrada conserva su venta y un estado resoluble aunque encuentre conflicto.
- Los IDs de productos son canónicos/estables entre catálogo, venta y base central.
- Ajustes, vaciados, importaciones y anulaciones no quedan sin estado durable.
- Confirmado un corte de apertura sin reconstrucción engañosa de historia.
- Comparación pre/post staging demuestra que los datos preexistentes no se borraron ni alteraron salvo operaciones sintéticas deliberadas.
- Despliegue productivo, si se aprueba después, tiene respaldo verificado, ventana/compatibilidad con clientes activos, procedimiento de rollback y aprobación explícita independiente; la primera promoción no hace backfill ni cambio masivo de stock.

## Orden recomendado y dependencias

`Fase previa (clon staging) → Fase 0 → Fase 1 → Fase 2 → Fase 3 → Fase 4 → Fase 5`.

No iniciar Fase 0 funcional ni SQL hasta aprobar la Fase previa. No iniciar Fase 5 ni presentar el Kardex como autoritativo hasta completar los sign-offs de fases 1–4. No aplicar migraciones ni desplegar código a producción por este plan; eso requiere decisión y autorización posterior. La construcción de UI del Kardex, filtros, exportación y detalle por producto queda como plan/entrega posterior.

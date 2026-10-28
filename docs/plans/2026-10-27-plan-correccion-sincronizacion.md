# Plan de corrección de sincronización — Listo POS Lite

**Fecha:** 27‑oct‑2026 · **Basado en:** `auditoria-sincronizacion-2026-10-27.md` (hallazgos H‑1 a H‑17; ese documento no está en el repo)
**Objetivo:** todo lo que se haga en un dispositivo con la misma cuenta aparece en los demás en **< 1 min**, sin pérdida de datos con varias cajas en simultáneo, y funcionando offline.

> **Estado** — ver la sección [Estado de avance](#estado-de-avance) al final del documento.

---

## 0. Principios y reglas del trabajo

1. **No destrucción**: antes de cada migración SQL → `npm run data:snapshot`; después → `npm run data:verify` (disciplina ya usada en 007/008).
2. **Una rama por fase** (`fix/sync-fase-a`, `fix/sync-fase-b`, `feat/sync-v2`), PR con tests verdes (`node --test tests/`).
3. **Feature flag** para la arquitectura nueva: `localStorage['sync_engine'] = 'v1' | 'v2'` y columna `cloud_licenses.sync_engine` para activarlo por cuenta. Permite volver atrás sin redeploy.
4. Cada tarea tiene **criterio de aceptación** verificable; no se cierra sin él.
5. Todo cambio de servidor va primero a **staging/** (como se hizo con 008).

### Resumen de fases

| Fase | Qué resuelve | Duración estimada | Riesgo |
|---|---|---|---|
| **A — Parches urgentes** | Cambios que no suben, que no llegan, sync apagado offline, endpoints abiertos | 2–3 días | Bajo |
| **B — Integridad sobre el modelo actual** | Borrados que resucitan, merges que pisan, eco, numeración, ajustes offline | 1–1,5 semanas | Medio |
| **C — Sync v2 (fila por entidad + libro de movimientos)** | Pérdida de stock/saldos con cajas concurrentes; egreso; tiempo real | 3–4 semanas | Alto (con flag) |
| **D — Verificación y despliegue** | Pruebas multi‑dispositivo, monitoreo, migración de cuentas | 1 semana (solapada) | — |

---

## FASE A — Parches urgentes (2–3 días)

Rama `fix/sync-fase-a`. Ningún cambio de modelo de datos; solo corrige bugs.

### A1. Hash real del payload (H‑1) — *prioridad máxima*
**Archivo:** `src/hooks/useCloudSync.js` (`_computePushHash`)

- Hash sobre el string COMPLETO + longitud (síncrono, rápido, sin dependencias). Exportarlo para test.
- **Test nuevo** `tests/syncHash.test.mjs`: arreglo de 500 productos; cambiar 1 campo de cualquier posición (stock 12→13, precio 1.5→1.6, nombre) ⇒ hash distinto en el 100 % de los casos.
- **Aceptación:** editar precio de un producto en A ⇒ fila `sync_documents` actualizada en < 35 s.

### A2. `updated_at` asignado por el servidor + cursor de servidor (H‑3)
**SQL nuevo** `migrations/009_sync_documents_server_time.sql`: trigger `BEFORE INSERT OR UPDATE` que fija `updated_at := clock_timestamp()`.

**Cliente** (`useCloudSync.js`):
- Quitar `updated_at` del upsert y de `uploadBackupToCloud` (`useCloudAuthLogic.js`); pedir `.select('updated_at')` tras el upsert.
- Reemplazar `lastSyncTime = new Date().toISOString()` por **el máximo `updated_at` recibido** del servidor.
- Usar `.gte` con un margen (`cursor - margen`) para cubrir commits concurrentes; la deduplicación por hash evita reaplicar.
- Persistir el cursor por cuenta en `localStorage` (`getScopedStorageKey('_sync_cursor')`).
- **Aceptación:** con el reloj de B adelantado/atrasado 10 min, los cambios de B llegan a A en el siguiente ciclo.

### A3. Polling corto de metadatos sobre TODAS las llaves (H‑9)
- Fase 1 (metadatos) consulta `SYNC_KEYS` completas, no `POLLING_ONLY_KEYS`.
- `POLL_INTERVAL = 60 s` mientras la pestaña está visible (~1 KB por consulta).
- Al volver visible: poll inmediato, sin el cooldown de 10 min (mínimo de 5 s anti‑rebote).
- Poll inmediato también al recibir el evento `online`.
- Realtime Broadcast se mantiene como aceleración, no como único canal.
- **Aceptación:** con B offline, A cambia la tasa; al reconectar B la ve en ≤ 60 s.

### A4. Reintento de inicialización (H‑4)
- En el `catch` de `initSync`, reintento con backoff (5 s, 15 s, 60 s, máx. 5 min) usando `syncGeneration` para no duplicar.
- `window.addEventListener('online', retryInit)`.
- Mientras `initialSyncReady === false`, `pushCloudSync` **no descarta**: guarda la llave en `_dirtyKeys` (persistido en `localStorage` por cuenta). Al completar el pull inicial, subir las llaves sucias (después del merge, nunca antes).
- **Aceptación:** abrir la app en modo avión, vender 3 veces, activar internet ⇒ en < 1 min las 3 ventas están en la nube y en el otro dispositivo.

### A5. Llaves de configuración faltantes (H‑13)
Agregar a `SYNC_KEYS`, `LOCAL_KEYS` y `REALTIME_KEYS`:
`business_name`, `business_rif`, `allow_negative_stock`, `bodega_rate_mode`, `cajero_puede_abrir_caja`, `cajero_puede_cerrar_caja`, `cajero_max_descuento`, `cashea_min_amount`.
- `ProductContext.jsx`: el listener `storage` ya maneja `bodega_rate_mode`; agregar listeners donde se lean las demás (SettingsView, SalesView, CierreCajaWizard) o leerlas en el momento de uso.
- Agregar las mismas a `collectLocalBackup` (`useCloudAuthLogic.js`), junto con `my_categories_v1`, `bodega_suppliers_v1`, `bodega_supplier_invoices_v1`, `bodega_cierres_v1` en `idbKeys`.
- **Mantener locales (no sincronizar):** `printer_mode`, `printer_serial_auto_drawer`, `app_screen_scale`, `bodega_inventory_view`, `pda_*`, `bodega_pending_cart_v1`.
- **Aceptación:** cambiar nombre del negocio en A ⇒ el ticket de B lo muestra en < 5 s.

### A6. Autenticar endpoints de escritura (H‑6)
`src/worker.js`, `api/checkout.js`, `api/inventory-operation.js`:
- Validar `Authorization: Bearer <token de Supabase>` contra `/auth/v1/user`; responder 401 sin usuario; **sobrescribir** `payload.account_id = user.id` (nunca confiar en el payload).
- Cliente: `checkoutProcessor.js`, `offlineQueueService.js`, `inventoryOperationService.js` envían el token. La cola offline obtiene el token al reintentar (no lo guarda en la cola).
- **Aceptación:** `curl` sin token ⇒ 401; con token de la cuenta A no se puede escribir `account_id` de B.

### A7. Neutralizar el daño del contrato de inventario (H‑5, mitigación)
Hasta que llegue la Fase C:
- En `ProductContext.jsx`, para `mode: 'delta'`, **no** sobrescribir el stock local con `stock_after` del servidor: aplicar el delta localmente y guardar `stockServer` aparte para diagnóstico.
- Si el servidor responde `invalid: producto desconocido`, aplicar el ajuste localmente y marcarlo `stockSync: 'local_only'`.
- **Aceptación:** producto con stock 40 nunca vendido: "+5" ⇒ 45 local y en el otro dispositivo.

### A8. Quick wins menores
- **H‑15**: en `_applyFromCloud`, para colección `local` leer el valor desde `localStorage`, y registrar `_sync_local_ts_<key>` también en el interceptor de `localStorage.setItem`.
- **H‑17**: `storageService.removeItem` ya no hace `pushCloudSync(key, [])`; los borrados de colección completa solo vía factory reset explícito.
- **Indicador en UI** (`SyncStatus.jsx`): mostrar "Último sync: hace X s" (cursor A2) y número de llaves sucias (A4).

### Entregables Fase A
Migración 009 · 4 tests nuevos (`syncHash`, `syncCursor`, `syncDirtyKeys`, `endpointAuth`) · release con changelog.

---

## FASE B — Integridad sobre el modelo actual (1–1,5 semanas)

Rama `fix/sync-fase-b`. Sigue usando `sync_documents`, pero el merge deja de perder datos.

### B1. Metadatos de versión en todas las entidades (H‑8)
Crear `src/utils/entityMeta.js` con `touch(entity)` (pone `updatedAt`, `updatedBy` = device_id y `rev + 1`) y `tombstone(entity)` (además `deletedAt`).

Aplicar `touch()` en **cada** escritura de entidad:

| Entidad | Archivos |
|---|---|
| Productos | `ProductFormModal.jsx`, `BulkPriceAdjustModal.jsx`, `QuickStockModal.jsx`, `ZeroStockModal.jsx`, `ProductContext.jsx`, `checkoutProcessor.js` (descuento), `voidSaleCore.js` (reposición) |
| Clientes | `financialLogic.js` (`procesarImpactoCliente`), `customerTransactionProcessor.js`, `TransactionModal.jsx`, `CustomersView.jsx`, `voidSaleProcessor.js` |
| Ventas | `checkoutProcessor.js`, `voidSaleCore.js` (original marcada), `closureService.js`, `ProductsView.jsx` (registros de ajuste) |
| Proveedores/facturas | `SupplierModals.jsx`, `CustomersView.jsx` |
| Métodos de pago | `PaymentMethodsManager.jsx` |
| Cuentas | `useWallet.js`, `WalletView.jsx` |
| Categorías | `ProductsView.jsx`, `CategoryManagerModal.jsx` |
| Usuarios | `useAuthStore.js` (cada usuario del arreglo) |

**Regla de test**: recorre los procesadores puros (`checkoutProcessor`, `voidSaleCore`, `financialLogic`) y verifica que toda entidad modificada sale con `updatedAt` nuevo.

### B2. Borrado lógico (H‑7)
- Reemplazar los `filter(x => x.id !== id)` de persistencia por `map(x => x.id === id ? tombstone(x) : x)` (`ProductsView.jsx`, `CustomersView.jsx`, `PaymentMethodsManager.jsx`, `useWallet.js`, `useAuthStore.js`, categorías en `ProductsView.jsx`).
- Las vistas filtran `!x.deletedAt` al leer (helper `alive(arr)` en `entityMeta.js`).
- Purga de lápidas con más de 90 días al hacer push.

### B3. Merge nuevo (H‑7, H‑8) — incluye inventario
`_mergeArraysById` en `useCloudSync.js`:
- Gana el más nuevo por `updatedAt`; empate ⇒ `rev`; empate ⇒ `updatedBy` (desempate determinista, no "gana la nube").
- Lápida con `deletedAt` más nuevo que la versión viva ⇒ gana la lápida.
- **Inventario pasa a `MERGEABLE_KEYS`** (eliminar el reemplazo total de `isInventory`).
- Re‑push si el resultado **difiere** de la nube (comparar hash, no longitud).
- **Tests** `tests/syncMerge.test.mjs`: borrado vs. presente; local más nuevo; empate; venta anulada vs. versión vieja; producto creado en A y otro en B ⇒ ambos.

### B4. Stock y saldos: merge por campo con deltas (mitigación de H‑2 antes de la Fase C)
- Cada producto guarda `stockOps: { [opId]: delta }` (últimos 7 días) + `stockBase`. `stock = stockBase + Σ stockOps`. El merge **une** los `stockOps` por `opId`, así dos ventas concurrentes suman ambas.
- Consolidación en el cierre de caja (operaciones de más de 7 días pasan a `stockBase`).
- Lo mismo para clientes: `balanceOps` + `balanceBase`.
- *Si se prefiere ir directo a la Fase C, B4 puede omitirse;* se recomienda hacerla si la Fase C tardará más de un mes.

### B5. Quitar la bandera global y el eco (H‑10, H‑11)
- Eliminar `isSyncingFromCloud` como bloqueo de pushes. `_applyFromCloud` escribe vía `writeFromCloud()` que no llama `pushCloudSync`; las escrituras locales siempre se encolan.
- En el polling, sembrar `_lastPushHash[doc_id]` con el payload aplicado.
- `ProductContext.jsx`: guardar el hash de lo último recibido de la nube; si el auto‑save produce el mismo contenido, no llamar `setItem`.
- El handler de Broadcast nunca descarta mensajes: cola serial (`applyQueue = applyQueue.then(...)`).

### B6. Numeración de ventas por dispositivo (H‑12)
- Prefijo de caja (`A`, `B`, `C`…) guardado en `account_devices` (nueva columna `register_code`).
- `saleNumber` = contador local por dispositivo; mostrar `B‑0101`. Las ventas viejas conservan su número.
- **Aceptación:** 2 cajas venden a la vez 50 ventas cada una ⇒ 100 números únicos.

### B7. Cola persistente de operaciones de inventario (H‑16)
- `src/services/inventoryQueueService.js` con el patrón de `offlineQueueService` (mismo `operation_id`, backoff, persistencia por cuenta).
- `ProductsView`/`ProductContext`: el resultado `pending` encola la operación; el reintento usa el mismo payload.
- `SyncStatus.jsx` muestra ventas + ajustes pendientes.

### B8. Aislar `localStorage` por cuenta (H‑14)
- Las llaves sincronizadas de `localStorage` pasan a `getScopedStorageKey(key)` con migración única al primer arranque.
- Wrapper `scopedLocal.get/set` y reemplazo en los ~40 usos.
- Al cambiar de cuenta no se suben valores de la cuenta anterior.

### Entregables Fase B
`entityMeta.js` · merge nuevo · inventario mergeable · cola de inventario · prefijo de caja · tests `syncMerge`, `entityMeta`, `inventoryQueue`, `saleNumbering`.

---

## FASE C — Sync v2: fila por entidad + libro de movimientos (3–4 semanas)

Rama `feat/sync-v2`, detrás del flag `sync_engine = 'v2'`.

### C1. Esquema (migración `010_sync_v2_schema.sql`, aditiva)
Tabla genérica `public.entities (account_id, kind, id, data jsonb, rev, deleted_at, updated_by, updated_at, seq identity)` con PK `(account_id, kind, id)`, índice `(account_id, seq)` y RLS `auth.uid() = account_id`.
- **Cursor por `seq`** (monótono del servidor), no por fecha: `WHERE account_id = $1 AND seq > $cursor ORDER BY seq LIMIT 500`; re‑leer desde `cursor - 50` y deduplicar por `rev` para huecos de transacciones en vuelo. *Alternativa más estricta: tabla `entity_changes` alimentada por trigger con `pg_current_xact_id()`.*
- Trigger `BEFORE UPDATE`: `updated_at = clock_timestamp()`, re‑secuenciar `seq`, y rechazar si `NEW.rev <= OLD.rev` (concurrencia optimista) → el cliente recibe conflicto y re‑mergea.

### C2. Stock y saldos en el servidor (resuelve H‑2 y H‑5)
- Añadir `account_id uuid` a `public.products` e `inventory_operations` (migración `011`, con backfill).
- **Siembra del stock real**: `scripts/seed-server-stock.mjs` toma, por cuenta, el `bodega_products_v1` de `sync_documents` y crea/actualiza `public.products` con una operación `APERTURA` en `inventory_operations` (auditada).
- `process_checkout` registra cada línea como operación `VENTA` en `inventory_operations` en vez de `UPDATE` directo; `apply_inventory_operation` filtra por `account_id`.
- Tabla `customer_ledger` (account_id, customer_id, op_id único, tipo, monto_usd, sale_id, created_at) + vista `customer_balances`. Fiados, abonos, Cashea, saldo a favor y anulaciones generan movimientos.
- El cliente **nunca** sube `stock` ni `deuda` como campo editable: muestra `stockServer + Σ ops locales pendientes`.
- Conteos físicos (`mode: 'count'`) siguen siendo operación del libro.

### C3. Motor de sync v2 en el cliente (`src/sync/`)

| Módulo | Función |
|---|---|
| `outbox.js` | Cola persistente (IndexedDB, por cuenta) de cambios `{kind, id, data, rev, deleted_at}` y operaciones de libro. |
| `pusher.js` | Envía el outbox en lotes de 50 a `entities` (y `/api/inventory-operation`, `/api/checkout` para ops), con backoff y `operation_id`. |
| `puller.js` | Pull incremental por `seq`; merge por `rev`/lápida; cursor por cuenta. |
| `realtime.js` | `postgres_changes` sobre `entities` filtrado por `account_id`; si se pierde un evento, el puller lo recupera. |
| `repository.js` | API única `save(kind, entity)`, `remove(kind, id)`, `list(kind)` para las vistas; escribe IndexedDB + outbox. |
| `migrator.js` | Primera activación v2: descompone los documentos actuales en filas y los sube (idempotente, marca `v2_migrated_at`). |

- Las vistas migran de `storageService.setItem('bodega_*', arreglo)` a `repository.save(...)`. Orden: configuración → categorías → métodos de pago → proveedores → clientes → productos → ventas/cierres.
- Durante la transición, v2 **también** escribe `sync_documents` (doble escritura); se apaga cuando todas las cuentas estén en v2.

### C4. Ventas e historial
- Cada venta es una fila `kind='sale'` (inmutable salvo anulación).
- Se elimina el recorte de 30 días (`_trimSalesForSync`).
- Reportes de días viejos leen por rango (`data->>'fechaComercial'`), con índice de expresión.

### C5. Retiro del modelo viejo
1. Todas las cuentas activas en v2 por 2 semanas sin incidentes.
2. Desactivar doble escritura.
3. `sync_documents` queda solo lectura (backup); se archiva a los 90 días.

---

## FASE D — Verificación y despliegue

### D1. Banco de pruebas multi‑dispositivo
`tests/e2e/multidevice.spec.mjs` con **Playwright**: 2 contextos de navegador, misma cuenta, contra staging. Escenarios obligatorios (v1 parcheado y v2):
1. Crear/editar/borrar producto en A ⇒ visible en B (< 60 s en v1, < 5 s en v2).
2. A y B venden el mismo producto a la vez (10 ventas c/u) ⇒ stock final = inicial − 20 *(v2; en v1 con B4)*.
3. A cobra abono y B vende fiado al mismo cliente ⇒ saldo correcto en ambos.
4. Anulación en A mientras B está offline ⇒ B la ve al reconectar; sin doble reposición de stock.
5. Borrado de cliente en A, B offline con ese cliente ⇒ tras reconectar, sigue borrado.
6. B abre sin internet, vende 5, reconecta ⇒ las 5 en la nube y en A.
7. Reloj de B desfasado ±10 min ⇒ todo llega igual.
8. Pestaña de B oculta 30 min ⇒ al volver se actualiza en < 5 s.
9. Cambio de tasa/nombre del negocio/permisos de cajero ⇒ en B en < 5 s.
10. Factory reset en A ⇒ B limpia y recarga.

Unit tests en `tests/` corriendo en CI (GitHub Actions: `node --test`).

### D2. Observabilidad
- Tabla `sync_health` (account_id, device_id, cursor, outbox_size, last_push_at, last_pull_at, app_version) actualizada cada 5 min.
- Panel en `SuperAdminModal`/MonitorView: dispositivos atrasados > 10 min, outbox > 50, versiones viejas.
- Logs de conflicto (`rev` rechazado, lápida aplicada) a `audit_log` con `cat='SYNC'`.

### D3. Despliegue escalonado

| Paso | Qué | Gate para avanzar |
|---|---|---|
| 1 | Fase A en staging → producción | E2E 1, 6, 7, 8, 9 en verde; snapshot/verify ok |
| 2 | Fase B en producción | E2E 3, 4, 5 en verde; 3 días sin reportes |
| 3 | Fase C con flag en la cuenta de prueba | Todos los E2E en verde |
| 4 | v2 para 10 % de cuentas (las de más dispositivos primero) | 1 semana, `sync_health` sin atrasos |
| 5 | v2 para 100 % | 2 semanas estables |
| 6 | Retiro de v1 (C5) | — |

**Rollback:** Fase A/B → revertir release (migraciones aditivas, el trigger 009 se puede dejar). Fase C → flag en `v1`; la doble escritura mantiene `sync_documents` al día.

---

## Matriz hallazgo → tarea

| Hallazgo | Severidad | Tarea(s) |
|---|---|---|
| H‑1 hash débil | 🔴 | A1 |
| H‑2 stock "último gana" | 🔴 | B3, B4 (mitigación) → C2 (definitivo) |
| H‑3 reloj/cursor | 🔴 | A2 → C1 (`seq`) |
| H‑4 sync apagado si abre offline | 🔴 | A4 → C3 (outbox) |
| H‑5 contrato con stock falso | 🔴 | A7 (mitigación) → C2 |
| H‑6 endpoints sin auth | 🔴 | A6 |
| H‑7 borrados resucitan | 🟠 | B2, B3 → C1 (`deleted_at`) |
| H‑8 merge sin `updatedAt` | 🟠 | B1, B3 → C1 (`rev`) |
| H‑9 broadcast perdido | 🟠 | A3 → C3 (realtime + puller) |
| H‑10 escrituras descartadas | 🟠 | B5 → C3 |
| H‑11 eco | 🟠 | B5 → C3 |
| H‑12 números duplicados | 🟠 | B6 |
| H‑13 config sin sync | 🟡 | A5 |
| H‑14 localStorage sin cuenta | 🟡 | B8 |
| H‑15 protección local rota | 🟡 | A8 |
| H‑16 ajustes offline perdidos | 🟡 | B7 → C3 |
| H‑17 removeItem vacía nube | 🟡 | A8 |

---

## Riesgos y cómo se controlan

| Riesgo | Mitigación |
|---|---|
| A1 hace que se suban de golpe muchos cambios retenidos (más egreso el primer día) | Es deseable; el debounce agrupa. Vigilar Disk IO de Supabase el día del release. |
| Polling de 60 s aumenta peticiones | Solo metadatos (~1 KB); pausado con pestaña oculta. En v2 lo reemplaza Realtime. |
| Merge nuevo (B3) re‑sube datos viejos de dispositivos desactualizados | Lápidas + `rev`; correr B con todos los dispositivos actualizados (forzar recarga con `broadcastForceReload`). |
| Siembra de stock (C2) con datos incorrectos | Operación `APERTURA` auditada, desde el último documento de la nube, con snapshot previo y revisión manual de 3 cuentas. |
| Dispositivos con versión vieja durante la transición | Doble escritura en v2; `sync_health.app_version` para detectar y forzar recarga. |
| Límite de plan de Supabase (egress/Disk IO) | v2 sube filas de KB en vez de documentos de MB: debería **bajar** el consumo. Medir antes/después. |

---

## Estado de avance

Revisión de código del 28‑oct‑2026 (rama `fix/sync-fase-a`). "Código ✅" = implementado y con tests; la prueba manual con 2 navegadores sigue pendiente para todas.

| Tarea | Código | Notas |
|---|---|---|
| A1 hash | ✅ | `src/sync/syncHash.js` + `tests/syncHash.test.mjs`. Productos suben con espera de 30 s (dentro del criterio de 35 s). |
| A2 hora del servidor + cursor | ✅ (parcial) | Migración 009 **aplicada en producción** el 28‑oct (no hay proyecto staging; snapshot por huella antes/después idéntico). Cursor en `src/sync/syncCursor.js` + `tests/syncCursor.test.mjs`. **No** se persiste el cursor por cuenta: el pull inicial baja todo y fija el cursor, así que no cambia el resultado. |
| A3 polling 60 s | ✅ | Además: aviso `sync_ping` por Realtime tras subir documentos pesados (los otros equipos revisan al instante). |
| A4 reintento + llaves sucias | ✅ | `src/sync/dirtyKeys.js` + `tests/syncDirtyKeys.test.mjs`. Huella de "lo que tiene la nube" para no confundir re‑guardados con cambios. |
| A5 config del negocio | ✅ | El commit original solo tocó el backup; las 8 llaves se agregaron a SYNC/LOCAL/REALTIME el 28‑oct. Tickets y recibos leen al imprimir; Ajustes (`SettingsView`, `SettingsTabVentas`) escuchan el evento `storage`. |
| A6 auth de endpoints | ✅ | `src/services/authHeaders.js`; worker y `api/*` validan el token; `tests/endpointAuth.test.mjs`. |
| A7 stock local | ✅ | `src/sync/stockResolution.js` + `tests/stockResolution.test.mjs`. |
| A8 quick wins | ✅ | H‑15, H‑17 e indicador "Sync hace X s · N sin subir". |

Extras fuera del plan, en la misma rama: Inicio y Clientes se refrescan al llegar datos de otra caja; ventas suben con espera de 10 s; `npm run dev` arranca web + API; opción de PIN al cambiar de pestaña (`feat/bloqueo-cambio-pestana`, unida a esta rama).

**Pendiente para cerrar la Fase A:** prueba manual con 2 navegadores (escenarios E2E 1, 6, 7, 8, 9), subir la rama, PR a `main` y publicar.

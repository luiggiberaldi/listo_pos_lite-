# Publicación del Kardex en producción (PR #2)

> **Fecha:** 2026-10-28
> **Estado:** preparado y ensayado en staging; **nada ejecutado en producción**.
> **PR:** [luiggiberaldi/listo_pos_lite-#2](https://github.com/luiggiberaldi/listo_pos_lite-/pull/2) (borrador, rama `feat/kardex-port`).
> **Plan de fondo:** [plan pre-Kardex](2026-10-13-pre-kardex-stock-integrity.md).

## Resumen en una línea

Primero **respaldo**, después **migraciones 010 → 011 → 012** en la base de producción, y recién entonces **unir el PR** (unir a `main` publica el código en Vercel). Si algo sale mal: **primero** se vuelve atrás el código en Vercel y **después** la base.

## Estado de producción antes de empezar (leído el 2026-10-28, solo lectura)

| Dato | Valor |
| --- | --- |
| Proyecto Supabase | `fgzwmwrugerptfqfrsjd` — plan **gratuito** (sin respaldos descargables: el respaldo lo hacemos nosotros) |
| Migraciones aplicadas | 007, 008, 009 (falta 010, 011, 012) |
| `process_checkout` | `md5(prosrc) = 5904cab78838673cb03a7e9f950847ca` — idéntica a `migrations/007_checkout_idempotent_response.sql` |
| `apply_inventory_operation` | `md5(prosrc) = 2154af97adb1b7b2827aafa506f082c3` (010-012 no la tocan) |
| `sync_product_catalog` | no existe (la crea 011) |
| `sale_items.product_id` | admite NULL (lo necesita la "Venta Libre" de 011/012) |
| `inventory_policies` | vacía → negativos permitidos como hoy |
| Filas | products 2040 · sales 8618 · sale_items 15212 · journal_entries 19092 · inventory_adjustments 9512 · inventory_operations 3 |
| Despliegue de Vercel vigente | `dpl_AHtLMBzy5uKgHci2jEo37Jirg2py` (main, Fase A, commit `2c810e0`) — **punto de vuelta atrás del código** |

## Por qué este orden es seguro

- 010, 011 y 012 **solo reemplazan funciones** (`process_checkout`) y crean una nueva (`sync_product_catalog`). No crean, cambian ni borran tablas ni filas.
- **La app que hoy está en `main` funciona con las migraciones nuevas**: convierte IDs raros en UUID y su API registra el producto antes de cobrar (nunca hay "producto desconocido"), no manda `stock_qty` (012 descuenta `qty` como siempre) y sin filas en `inventory_policies` se siguen permitiendo negativos. Ensayado en staging.
- **El código nuevo no funciona con la función vieja** (la "Venta Libre" llega como `custom_*` y la 007 falla al convertirlo a UUID). Por eso: migraciones antes del código, y en una vuelta atrás, código antes que base.

## Paso a paso

Elegir una hora de poco movimiento en las cajas. Tener a mano esta página y el SQL de vuelta atrás.

### 1. Respaldo (≈ 5 min)

En la carpeta del proyecto (usa `.env` y `.dev.vars`, que apuntan a producción; la guarda aborta si el proyecto no es el esperado):

```bash
npm run data:snapshot -- --env-file .env --env-file .dev.vars --expect-host fgzwmwrugerptfqfrsjd.supabase.co
```

```bash
node scripts/backup-export.mjs --env-file .env --env-file .dev.vars --expect-host fgzwmwrugerptfqfrsjd.supabase.co
```

- Comprobar que el respaldo diga "completo" (si dice "INCOMPLETAS", alguien vendió mientras se exportaba: repetir o aceptarlo). Queda en `backups/fgzwmwrugerptfqfrsjd-<fecha>/` (ignorado por git: tiene datos de clientes).
- Comprobar las huellas actuales (editor SQL o conector, solo lectura):

```sql
select proname, md5(prosrc) from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('process_checkout', 'apply_inventory_operation', 'sync_product_catalog')
 order by 1;
```

  Debe dar `process_checkout = 5904cab78838673cb03a7e9f950847ca`, `apply_inventory_operation = 2154af97adb1b7b2827aafa506f082c3` y **ninguna** `sync_product_catalog`. **Si algo no coincide, PARAR**: alguien cambió producción y hay que revisar antes de seguir.

### 2. Migraciones en producción (≈ 5 min)

Aplicar **en este orden**, de a una, comprobando la huella después de cada una (misma consulta del paso 1). La forma recomendada es el conector de Supabase (`apply_migration`, queda registrada en el historial de migraciones como la 008 y la 009); alternativa: pegar el archivo completo en el editor SQL del proyecto **listo pos lite**.

| Orden | Archivo | Huella esperada de `process_checkout` después |
| --- | --- | --- |
| 1 | `migrations/010_checkout_negative_stock_policy.sql` | `c0d50c7bfd17dfd2786cf38b218a6137` |
| 2 | `migrations/011_checkout_linked_products_and_catalog_sync.sql` | `609faa126a908e015970958aeb0c7ef8` (y `sync_product_catalog = 30a40366084ee6745eac11ecb845444c`) |
| 3 | `migrations/012_checkout_inventory_quantity.sql` | `31d51b5cc61c3d9cd2b3239c564fd3b1` |

Cada archivo va dentro de `BEGIN … COMMIT`: si falla, no queda nada a medias.

Después:

```bash
npm run data:verify -- --env-file .env --env-file .dev.vars --expect-host fgzwmwrugerptfqfrsjd.supabase.co
```

Debe decir "sin indicios de destrucción". Esperar unos minutos y comprobar que siguen entrando ventas (el conteo de `sales` sube) y que no hay errores de `/api/checkout` en los registros de Vercel.

### 3. Publicar el código (≈ 5 min)

1. En GitHub, marcar el PR #2 como "Ready for review" y unirlo a `main`.
2. Esperar a que Vercel marque el despliegue de producción como **READY**.
3. Prueba en producción con tu propia cuenta: abrir la app, comprobar que el indicador diga "Online", hacer una venta pequeña real y ver que no aparezca "por revisar".

### 4. Después de publicar

- Pedir a los negocios que venden **por caja/lote** un **conteo físico** de esos productos: el error anterior (1 caja descontaba 1 unidad) dejó su stock desviado.
- Vigilar los primeros días el aviso "N por revisar" de Inicio.
- Las cajas que no recarguen la app seguirán un tiempo con la versión anterior; funciona con las migraciones nuevas, pero descuenta las cajas con la regla vieja hasta que se actualice.

## Vuelta atrás

**Si falla el código (paso 3):** en Vercel, proyecto `listo-pos-lite` → Deployments → `dpl_AHtLMBzy5uKgHci2jEo37Jirg2py` → "Instant Rollback". La base puede quedarse con 010-012 (la app de `main` funciona con ellas).

**Si además hay que devolver la base:** solo **después** de volver atrás el código, ejecutar [`docs/backups/2026-10-28_rollback_kardex_010-012.sql`](../backups/2026-10-28_rollback_kardex_010-012.sql) y comprobar `process_checkout = 5904cab78838673cb03a7e9f950847ca`. No toca datos: las ventas registradas mientras estuvo la 012 siguen siendo válidas (las líneas de "Venta Libre" quedan con `product_id` NULL).

**Si se perdieran datos** (no debería: nada de esto borra filas): el respaldo del paso 1 tiene cada tabla completa en JSON con su huella SHA-256 en `manifest.json`; la restauración sería manual, tabla por tabla, comparando contra `npm run data:verify`.

## Ensayo en staging (2026-10-28)

Ejecutado en `kkwqarueckiyytdqgqck` con los mismos archivos (texto verificado por SHA-256 antes de cada ejecución):

1. Foto de no-destrucción.
2. SQL de vuelta atrás → staging quedó con **las mismas huellas que producción** (`5904cab…`, `2154af9…`); la app de `main` cobra bien.
3. 010 → 011 → 012 aplicadas en orden sin errores; huellas finales `31d51b5…` (cobro) y `30a4036…` (catálogo). La 011 nunca se había ejecutado antes en ninguna base.
4. Cobro con el cliente de `main` (sin `stock_qty`) y con el cliente nuevo (1 caja con `stock_qty` 12 + Venta Libre): ambos OK (`staging/scripts/rollout-check.mjs`).
5. Vuelta atrás otra vez → `5904cab…`; la app de `main` sigue cobrando; el cliente nuevo falla (esperado: confirma que el código se revierte primero).
6. 012 de nuevo → ambos clientes OK; `data:verify` contra la foto inicial: **0 violaciones**.
7. Respaldo (`scripts/backup-export.mjs`) contra staging: completo; con páginas pequeñas el resultado es idéntico (paginación verificada); con el proyecto equivocado la guarda aborta sin leer nada.

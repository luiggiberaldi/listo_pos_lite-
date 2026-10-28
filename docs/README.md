# Documentación de Listo POS Lite

## Carpetas

| Carpeta | Qué contiene |
|---|---|
| `plans/` | Planes de trabajo con fecha. Cada uno dice qué se hizo y qué falta. |
| `ideas/` | Propuestas viejas o a futuro que **no** están en ejecución. |
| `backups/` | Respaldos SQL de funciones antes de migraciones y fotos de "no-destrucción" de staging. |
| `legacy/` | SQL antiguo que ya fue reemplazado por `migrations/`. Solo de referencia. |

## Planes (`plans/`)

| Plan | Estado |
|---|---|
| [Integridad de stock pre-Kardex](plans/2026-10-13-pre-kardex-stock-integrity.md) | ✅ Base del Kardex, ya publicado |
| [Fase 0: matriz de rutas de stock](plans/2026-10-26-fase0-matriz-rutas-stock.md) | ✅ Insumo del Kardex |
| [Corrección de sincronización (fases A–D)](plans/2026-10-27-plan-correccion-sincronizacion.md) | 🟡 A y B publicadas; B4 omitida; C y D pendientes |
| [Fase 5: Kardex](plans/2026-10-28-fase5-kardex.md) | ✅ Publicado |
| [Publicación del Kardex en producción](plans/2026-10-28-publicacion-kardex-produccion.md) | ✅ Ejecutado |
| [Responsividad P1–P3](plans/2026-10-28-plan-responsividad.md) | ✅ Publicado (PR #5, #6, #7, #8) |
| [Multicaja](plans/2026-10-28-plan-multicaja.md) | 📋 Guardado para el futuro |

## Ideas (`ideas/`)

- [Multicaja por red local (LAN)](ideas/2026-10-08-lan-multicaja-sync.md): solo si se necesitan varias cajas sin internet.
- [Licencias para varios equipos](ideas/sync_and_licensing.md): en su mayoría ya existe (`max_devices`).

-- 016 · Limpieza de sync_documents tras partir las ventas por día
--
-- Desde esta versión la app sube las ventas como un documento por día
-- ("bodega_sales_v1@2026-10-28") en vez de un solo documento de 30 días
-- (~600 KB) que se reescribía entero en cada venta y agotaba el Disk IO
-- Budget de Supabase.
--
--   1. Borra los documentos de prueba stress_test_doc_* (basura de pruebas).
--   2. Tarea semanal (domingo 04:30):
--      * borra los trozos de ventas de hace más de 45 días (la app solo sube
--        los últimos 30; el historial completo sigue en cada equipo, en
--        cloud_backups y en la tabla sales);
--      * borra el documento único viejo 'bodega_sales_v1' cuando lleva 14
--        días sin cambios, es decir, cuando ya ningún equipo con la versión
--        anterior lo sigue subiendo.
--
-- No toca ventas de la tabla sales ni respaldos.

BEGIN;

DELETE FROM public.sync_documents WHERE doc_id LIKE 'stress\_test\_doc\_%';

SELECT cron.unschedule('sales_chunks_retention_weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sales_chunks_retention_weekly');

SELECT cron.schedule(
    'sales_chunks_retention_weekly',
    '30 4 * * 0',
    $job$
        DELETE FROM public.sync_documents
            WHERE doc_id LIKE 'bodega\_sales\_v1@____-__-__'
              AND split_part(doc_id, '@', 2) < to_char(now() - INTERVAL '45 days', 'YYYY-MM-DD');
        DELETE FROM public.sync_documents
            WHERE doc_id = 'bodega_sales_v1'
              AND updated_at < now() - INTERVAL '14 days';
    $job$
);

COMMIT;

-- ── Rollback (manual) ─────────────────────────────────────────────
-- SELECT cron.unschedule('sales_chunks_retention_weekly');
-- (los documentos de prueba borrados no se recuperan; no tenían datos reales)

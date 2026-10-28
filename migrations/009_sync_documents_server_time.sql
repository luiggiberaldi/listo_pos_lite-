-- ============================================================
-- MIGRACIÓN 009: updated_at de sync_documents lo fija el SERVIDOR
--
-- PROBLEMA (auditoría de sincronización, H-3): updated_at lo ponía el cliente
-- con su propio reloj, y el polling comparaba contra la hora local del lector.
-- Con relojes desfasados entre dispositivos, los cambios de un equipo nunca
-- llegaban a los demás por polling.
--
-- SOLUCIÓN: un trigger asigna updated_at = clock_timestamp() en cada INSERT/
-- UPDATE, ignorando el valor que mande el cliente. El cliente usa como cursor
-- el máximo updated_at recibido del servidor.
--
-- ADITIVA: no borra ni transforma datos. Idempotente (se puede re-ejecutar).
-- Disciplina de no-destrucción: npm run data:snapshot → migración →
-- npm run data:verify.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_documents_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_documents_touch ON public.sync_documents;
CREATE TRIGGER trg_sync_documents_touch
    BEFORE INSERT OR UPDATE ON public.sync_documents
    FOR EACH ROW EXECUTE FUNCTION public.sync_documents_touch();

COMMIT;

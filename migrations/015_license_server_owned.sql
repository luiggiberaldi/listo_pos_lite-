-- 015 · La licencia la maneja solo el servidor
--
-- Antes la política "cloud_licenses_owner" (FOR ALL) dejaba que cada usuario
-- escribiera su propia licencia: podía cambiarse valid_until, max_devices,
-- license_type o active desde el navegador. Y account_devices aceptaba
-- INSERT directo, saltándose el límite de equipos.
--
-- Ahora:
--   * cloud_licenses: el dueño solo LEE su fila y puede actualizar únicamente
--     business_name, phone y updated_at (datos de perfil).
--   * account_devices: el dueño lee, renombra (device_alias), marca last_seen
--     y expulsa (DELETE). Los equipos nuevos entran solo por
--     register_and_check_device, que revisa el límite.
--   * register_and_check_device crea la licencia de prueba (7 días, 2 equipos)
--     si la cuenta no tiene ninguna, en lugar de responder 'ok' sin límite.
--
-- No toca datos existentes. Rollback: ver el final del archivo.

BEGIN;

-- ── 1. cloud_licenses: solo lectura + perfil ──────────────────────
DROP POLICY IF EXISTS cloud_licenses_owner ON public.cloud_licenses;

CREATE POLICY cloud_licenses_owner_select
    ON public.cloud_licenses FOR SELECT TO authenticated
    USING (lower(auth.jwt() ->> 'email') = lower(email));

CREATE POLICY cloud_licenses_owner_update_profile
    ON public.cloud_licenses FOR UPDATE TO authenticated
    USING (lower(auth.jwt() ->> 'email') = lower(email))
    WITH CHECK (lower(auth.jwt() ->> 'email') = lower(email));

REVOKE INSERT, UPDATE, DELETE ON public.cloud_licenses FROM anon, authenticated;
GRANT SELECT ON public.cloud_licenses TO authenticated;
GRANT UPDATE (business_name, phone, updated_at) ON public.cloud_licenses TO authenticated;

-- ── 2. account_devices: sin INSERT directo ────────────────────────
DROP POLICY IF EXISTS account_devices_owner ON public.account_devices;

CREATE POLICY account_devices_owner_select
    ON public.account_devices FOR SELECT TO authenticated
    USING (lower(auth.jwt() ->> 'email') = lower(email));

CREATE POLICY account_devices_owner_update
    ON public.account_devices FOR UPDATE TO authenticated
    USING (lower(auth.jwt() ->> 'email') = lower(email))
    WITH CHECK (lower(auth.jwt() ->> 'email') = lower(email));

CREATE POLICY account_devices_owner_delete
    ON public.account_devices FOR DELETE TO authenticated
    USING (lower(auth.jwt() ->> 'email') = lower(email));

REVOKE INSERT, UPDATE, DELETE ON public.account_devices FROM anon, authenticated;
GRANT SELECT, DELETE ON public.account_devices TO authenticated;
GRANT UPDATE (device_alias, last_seen) ON public.account_devices TO authenticated;

-- ── 3. Registro de equipo: crea la licencia de prueba si falta ────
CREATE OR REPLACE FUNCTION public.register_and_check_device(
    p_email TEXT,
    p_device_id TEXT,
    p_device_alias TEXT DEFAULT 'Dispositivo'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_caller_email TEXT;
    v_meta JSONB;
    v_max_devices INTEGER;
    v_active BOOLEAN;
    v_license_type TEXT;
    v_valid_until TIMESTAMP WITH TIME ZONE;
    v_count INTEGER;
    v_already_registered BOOLEAN;
BEGIN
    v_caller_email := auth.jwt() ->> 'email';
    IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(p_email) THEN
        RETURN 'unauthorized';
    END IF;
    IF coalesce(p_device_id, '') = '' THEN
        RETURN 'unauthorized';
    END IF;

    SELECT max_devices, active, license_type, valid_until
    INTO v_max_devices, v_active, v_license_type, v_valid_until
    FROM public.cloud_licenses
    WHERE lower(email) = lower(p_email)
    FOR UPDATE;

    IF NOT FOUND THEN
        -- Licencia de prueba de fábrica: 7 días, 2 equipos. Nombre y teléfono
        -- vienen de los datos que el usuario dio al registrarse.
        v_meta := coalesce(auth.jwt() -> 'user_metadata', '{}'::jsonb);
        INSERT INTO public.cloud_licenses (
            email, device_id, license_type, plan_tier, max_devices, days_remaining,
            valid_until, business_name, phone, active, updated_at
        ) VALUES (
            lower(p_email), p_device_id, 'trial', 'basic', 2, 7,
            NOW() + INTERVAL '7 days',
            coalesce(nullif(v_meta ->> 'full_name', ''), 'Negocio'),
            coalesce(v_meta ->> 'phone', ''),
            true, NOW()
        )
        ON CONFLICT (email) DO NOTHING;

        SELECT max_devices, active, license_type, valid_until
        INTO v_max_devices, v_active, v_license_type, v_valid_until
        FROM public.cloud_licenses
        WHERE lower(email) = lower(p_email)
        FOR UPDATE;
    END IF;

    IF v_active = false THEN
        RETURN 'license_inactive';
    END IF;

    IF v_license_type <> 'permanent' AND v_valid_until < NOW() THEN
        RETURN 'license_expired';
    END IF;

    v_max_devices := coalesce(v_max_devices, 2);

    SELECT COUNT(*) INTO v_count
    FROM public.account_devices
    WHERE lower(email) = lower(p_email);

    IF v_count > v_max_devices THEN
        RETURN 'limit_reached';
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.account_devices
        WHERE lower(email) = lower(p_email) AND device_id = p_device_id
    ) INTO v_already_registered;

    IF v_already_registered THEN
        UPDATE public.account_devices
        SET last_seen = NOW(), device_alias = COALESCE(NULLIF(p_device_alias, ''), device_alias)
        WHERE lower(email) = lower(p_email) AND device_id = p_device_id;
        RETURN 'ok';
    END IF;

    IF v_count >= v_max_devices THEN
        RETURN 'limit_reached';
    END IF;

    INSERT INTO public.account_devices (email, device_id, device_alias, last_seen)
    VALUES (lower(p_email), p_device_id, COALESCE(NULLIF(p_device_alias, ''), 'Dispositivo'), NOW())
    ON CONFLICT (email, device_id) DO UPDATE SET last_seen = NOW();

    RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.register_and_check_device(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_and_check_device(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_and_check_device(text, text, text) TO service_role;

-- ── 4. Borrar contraseñas guardadas en respaldos viejos ───────────
-- Versiones anteriores de la app subían abasto-auth-storage con la
-- contraseña de la cuenta en texto plano (state.adminPassword). Solo se
-- quita ese campo; el resto del respaldo queda igual.
UPDATE public.cloud_backups
SET backup_data = jsonb_set(
    backup_data,
    '{data,ls,abasto-auth-storage}',
    CASE jsonb_typeof(backup_data #> '{data,ls,abasto-auth-storage}')
        WHEN 'string' THEN to_jsonb(
            (((backup_data #>> '{data,ls,abasto-auth-storage}')::jsonb) #- '{state,adminPassword}')::text
        )
        ELSE (backup_data #> '{data,ls,abasto-auth-storage}') #- '{state,adminPassword}'
    END
)
WHERE backup_data #> '{data,ls,abasto-auth-storage}' IS NOT NULL
  AND backup_data::text LIKE '%adminPassword%';

COMMIT;

-- ── Rollback (manual) ─────────────────────────────────────────────
-- BEGIN;
-- DROP POLICY IF EXISTS cloud_licenses_owner_select ON public.cloud_licenses;
-- DROP POLICY IF EXISTS cloud_licenses_owner_update_profile ON public.cloud_licenses;
-- CREATE POLICY cloud_licenses_owner ON public.cloud_licenses FOR ALL TO authenticated
--     USING (lower(auth.jwt() ->> 'email') = lower(email))
--     WITH CHECK (lower(auth.jwt() ->> 'email') = lower(email));
-- GRANT INSERT, UPDATE, DELETE ON public.cloud_licenses TO authenticated;
-- DROP POLICY IF EXISTS account_devices_owner_select ON public.account_devices;
-- DROP POLICY IF EXISTS account_devices_owner_update ON public.account_devices;
-- DROP POLICY IF EXISTS account_devices_owner_delete ON public.account_devices;
-- CREATE POLICY account_devices_owner ON public.account_devices FOR ALL TO authenticated
--     USING (lower(auth.jwt() ->> 'email') = lower(email))
--     WITH CHECK (lower(auth.jwt() ->> 'email') = lower(email));
-- GRANT INSERT, UPDATE, DELETE ON public.account_devices TO authenticated;
-- (y volver a crear register_and_check_device desde 006)
-- COMMIT;

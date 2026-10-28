-- 014 · Código de caja por dispositivo (Fase B: B6)
--
-- Cada dispositivo de una cuenta recibe una letra (A, B, C… Z, AA, AB…) que
-- la app usa como prefijo del número de venta: "B-00101". Así dos cajas que
-- venden a la vez (o sin internet) nunca repiten número.
--
-- Las letras no se reutilizan: si se expulsa la caja B y entra una nueva,
-- recibe la siguiente letra libre por orden (nunca una ya usada antes).

BEGIN;

ALTER TABLE public.account_devices ADD COLUMN IF NOT EXISTS register_code text;

-- Último índice entregado por cuenta (no baja al borrar dispositivos).
CREATE TABLE IF NOT EXISTS public.account_register_counters (
    email text PRIMARY KEY,
    last_index integer NOT NULL DEFAULT 0
);
ALTER TABLE public.account_register_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_register_counters FROM PUBLIC, anon, authenticated;

-- 1 → A, 26 → Z, 27 → AA, 28 → AB…
CREATE OR REPLACE FUNCTION public.register_code_from_index(p_index integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    n integer := p_index;
    v_out text := '';
BEGIN
    WHILE n > 0 LOOP
        n := n - 1;
        v_out := chr(65 + (n % 26)) || v_out;
        n := n / 26;
    END LOOP;
    RETURN v_out;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assign_register_code ON public.account_devices;
CREATE OR REPLACE FUNCTION public.account_devices_register_code_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_index integer;
BEGIN
    IF NEW.register_code IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.account_devices d
        WHERE d.email = NEW.email AND d.device_id = NEW.device_id
    ) THEN
        RETURN NEW; -- upsert de un dispositivo existente: conserva su letra
    END IF;
    INSERT INTO public.account_register_counters AS c (email, last_index)
    VALUES (lower(NEW.email), 1)
    ON CONFLICT (email) DO UPDATE SET last_index = c.last_index + 1
    RETURNING last_index INTO v_index;
    NEW.register_code := public.register_code_from_index(v_index);
    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_assign_register_code
    BEFORE INSERT ON public.account_devices
    FOR EACH ROW EXECUTE FUNCTION public.account_devices_register_code_trigger();

-- Dispositivos que ya existen: letra por orden de alta dentro de cada cuenta.
WITH ordered AS (
    SELECT id, lower(email) AS em,
           row_number() OVER (PARTITION BY lower(email) ORDER BY created_at, id) AS rn
    FROM public.account_devices
    WHERE register_code IS NULL
)
UPDATE public.account_devices d
SET register_code = public.register_code_from_index(o.rn::integer)
FROM ordered o
WHERE d.id = o.id;

INSERT INTO public.account_register_counters (email, last_index)
SELECT lower(email), count(*) FROM public.account_devices GROUP BY lower(email)
ON CONFLICT (email) DO UPDATE SET last_index = GREATEST(public.account_register_counters.last_index, EXCLUDED.last_index);

CREATE UNIQUE INDEX IF NOT EXISTS account_devices_email_register_code_key
    ON public.account_devices (lower(email), register_code);

REVOKE ALL ON FUNCTION public.account_devices_register_code_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_code_from_index(integer) FROM PUBLIC, anon, authenticated;

COMMIT;

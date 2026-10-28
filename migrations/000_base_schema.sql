-- ============================================================
-- MIGRACIÓN 000: Esquema base de la aplicación (bootstrap)
--
-- Generado el 2026-10-26 por introspección de SOLO LECTURA del
-- esquema real de producción (columnas, defaults, restricciones,
-- índices, RLS y definiciones de funciones). No contiene datos.
--
-- Propósito: permitir crear un entorno staging/local completo
-- desde cero. Después aplicar, en orden, las migraciones 001-006
-- (son idempotentes).
--
-- DIVERGENCIAS entre el SQL del repo y el estado real de producción
-- (aquí se replica el estado REAL):
--   * audit_log.user_id es INTEGER en producción; la migración 003
--     lo declara TEXT (su CREATE TABLE nunca llegó a ejecutarse allí).
--     ALERTA: un INTEGER no admite UUIDs de auth.users.
--   * cloud_backups conserva password_hash y cloud_licenses conserva
--     days_remaining (default 15), aunque db_estacion_maestra_setup.sql
--     ordena eliminarlos. cloud_licenses tiene además plan_tier y
--     max_devices default 1 (el setup dice default 2) y device_id NOT NULL.
--   * products, sales, sale_items, inventory_adjustments, journal_entries,
--     licenses y license_audit_logs no se crean en ningún archivo del repo;
--     sus definiciones se tomaron de producción.
--   * Faltaban en el repo las funciones auto_register_device,
--     heartbeat_device y validate_double_entry (copiadas de producción).
-- ============================================================

BEGIN;

-- ── 1. Tablas ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    stock numeric(15,4) DEFAULT 0,
    price numeric(15,4) NOT NULL,
    barcode text,
    category text,
    created_at timestamptz DEFAULT now(),
    cost_price numeric(10,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    total numeric(15,4) NOT NULL,
    status text DEFAULT 'completed',
    sync_origin text DEFAULT 'online',
    created_at timestamptz DEFAULT now(),
    queue_id uuid
);

CREATE TABLE IF NOT EXISTS public.sale_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id uuid REFERENCES public.sales(id),
    product_id uuid REFERENCES public.products(id),
    quantity numeric(15,4) NOT NULL,
    unit_price numeric(15,4) NOT NULL,
    subtotal numeric(15,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_adjustments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid REFERENCES public.products(id),
    sale_id uuid REFERENCES public.sales(id),
    delta numeric(15,4) NOT NULL,
    stock_after numeric(15,4) NOT NULL,
    reason text DEFAULT 'offline_sync_conflict',
    resolved boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.journal_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id uuid NOT NULL,
    account_code varchar NOT NULL,
    debit numeric(15,4) DEFAULT 0,
    credit numeric(15,4) DEFAULT 0,
    description text,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.licenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id text NOT NULL,
    product_id text NOT NULL,
    type text DEFAULT 'demo',
    expires_at timestamptz,
    client_name text,
    created_at timestamptz DEFAULT now(),
    last_seen timestamptz DEFAULT now(),
    metadata jsonb,
    active boolean DEFAULT true,
    code text,
    CONSTRAINT licenses_device_id_product_id_key UNIQUE (device_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.license_audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    action text NOT NULL,
    days_added integer,
    mrr_value numeric(10,2) DEFAULT 0.00,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sync_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    collection text NOT NULL,
    doc_id text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT sync_documents_user_id_collection_doc_id_key UNIQUE (user_id, collection, doc_id)
);

CREATE TABLE IF NOT EXISTS public.audit_log (
    id uuid PRIMARY KEY,
    ts bigint NOT NULL,
    cat text NOT NULL,
    action text NOT NULL,
    "desc" text,
    user_id integer,
    user_name text,
    user_role text,
    email text,
    device_id text,
    meta jsonb,
    synced_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cloud_backups (
    email text PRIMARY KEY,
    password_hash text,
    backup_data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.cloud_licenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    device_id text NOT NULL,
    license_type text NOT NULL DEFAULT 'trial',
    days_remaining integer DEFAULT 15,
    business_name text,
    phone text,
    active boolean DEFAULT true,
    updated_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    max_devices integer DEFAULT 1,
    plan_tier text DEFAULT 'basic',
    valid_until timestamptz,
    CONSTRAINT cloud_licenses_email_key UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS public.account_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    device_id text NOT NULL,
    device_alias text DEFAULT 'Dispositivo',
    last_seen timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    CONSTRAINT account_devices_email_device_id_key UNIQUE (email, device_id)
);

CREATE TABLE IF NOT EXISTS public.device_backups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id text NOT NULL,
    product_id text NOT NULL,
    backup_data jsonb,
    updated_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    CONSTRAINT device_backups_device_id_key UNIQUE (device_id)
);

-- ── 2. Índices presentes en producción y no cubiertos por 001-006 ──

CREATE INDEX IF NOT EXISTS idx_audit_log_email ON public.audit_log (email);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON public.audit_log (ts DESC);

-- ── 3. RLS habilitado en las 13 tablas (las políticas las crean 003/006) ──

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_backups ENABLE ROW LEVEL SECURITY;

-- ── 4. Funciones existentes en producción y ausentes del repo ──
-- (006 hace REVOKE/GRANT sobre estas tres: deben existir antes)

CREATE OR REPLACE FUNCTION public.auto_register_device(p_device_id text, p_product_id text, p_client_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    INSERT INTO public.licenses (device_id, product_id, client_name, type)
    VALUES (p_device_id, p_product_id, p_client_name, 'demo')
    ON CONFLICT (device_id, product_id) DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_device(p_device_id text, p_product_id text, p_client_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    UPDATE public.licenses
    SET last_seen = NOW(),
        client_name = COALESCE(NULLIF(p_client_name, ''), client_name)
    WHERE device_id = p_device_id AND product_id = p_product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_double_entry(tx_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    total_debit NUMERIC(15,4);
    total_credit NUMERIC(15,4);
BEGIN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_entries
    WHERE transaction_id = tx_uuid;

    IF total_debit != total_credit THEN
        RAISE EXCEPTION 'Double entry validation failed for transaction %: Debit (%) != Credit (%)', tx_uuid, total_debit, total_credit;
    END IF;

    RETURN TRUE;
END;
$function$;

COMMIT;

-- ============================================================
-- MIGRACIÓN 008: Contrato único de operación de inventario
-- Proyecto: repo principal (portada desde el sandbox staging/, donde
-- quedó aplicada y verificada el 2026-10-26 con pre/post sin indicios
-- de destrucción).
-- Fase 2 del plan pre-Kardex — "Saldo y regla de stock uniformes"
-- (ítem: operación transaccional para ajustes y conteos) + contrato
-- de operación con operation_id idempotente.
--
-- ADITIVA: crea dos tablas y una RPC nuevas. No borra ni modifica
-- datos, tablas ni funciones existentes.
-- Disciplina de no-destrucción: aplicar siempre con snapshot previo y
-- verificación posterior (npm run data:snapshot → migración →
-- npm run data:verify). El gate ya cubre inventory_operations como
-- tabla de solo-creación.
--
-- El contrato responde SIEMPRE con un status explícito:
--   applied           → operación nueva aplicada (delta + saldos)
--   already_processed → mismo operation_id reenviado; resultado canónico
--   stock_conflict    → la política de negativos lo impide; nada aplicado
--   invalid           → payload/entidad inválida; nada aplicado
-- La unicidad la garantiza idx_inventory_operations_operation_id DENTRO de
-- la transacción de la RPC; los pre-checks son solo atajos.
-- ============================================================

BEGIN;

-- Política de stock negativo por cuenta. FUENTE CONFIABLE en servidor:
-- el cliente la consulta, nunca la define (no se acepta del payload).
CREATE TABLE IF NOT EXISTS public.inventory_policies (
    account_id TEXT PRIMARY KEY,
    allow_negative BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Libro de operaciones de inventario (append-only, base del futuro Kardex).
-- Cada fila es UNA operación confirmada, identificada por su operation_id.
CREATE TABLE IF NOT EXISTS public.inventory_operations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id UUID NOT NULL,
    account_id TEXT,
    device_id TEXT,
    actor TEXT,
    product_id UUID NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN
        ('VENTA', 'AJUSTE_DIRECTO', 'CONTEO', 'VACIADO', 'ANULACION', 'APERTURA')),
    mode TEXT NOT NULL CHECK (mode IN ('delta', 'count')),
    quantity NUMERIC(15,4) NOT NULL,
    unit_mode TEXT,
    delta NUMERIC(15,4) NOT NULL,
    stock_before NUMERIC(15,4) NOT NULL,
    stock_after NUMERIC(15,4) NOT NULL,
    reason TEXT,
    origin_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_operations_operation_id
    ON public.inventory_operations (operation_id);
CREATE INDEX IF NOT EXISTS idx_inventory_operations_product
    ON public.inventory_operations (product_id, created_at);

-- ── RPC: aplicar una operación de inventario (idempotente) ─────────────────
CREATE OR REPLACE FUNCTION public.apply_inventory_operation(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
    v_operation_id UUID;
    v_account_id TEXT;
    v_device_id TEXT;
    v_actor TEXT;
    v_product_id UUID;
    v_type TEXT;
    v_mode TEXT;
    v_quantity NUMERIC(15,4);
    v_unit TEXT;
    v_reason TEXT;
    v_origin_ref TEXT;
    v_allow_negative BOOLEAN;
    v_current_stock NUMERIC(15,4);
    v_delta NUMERIC(15,4);
    v_new_stock NUMERIC(15,4);
    v_op_row_id BIGINT;
    rec RECORD;
BEGIN
    v_operation_id := NULLIF(payload->>'operation_id', '')::UUID;
    v_account_id := NULLIF(payload->>'account_id', '');
    v_device_id := NULLIF(payload->>'device_id', '');
    v_actor := NULLIF(payload->>'actor', '');
    v_product_id := NULLIF(payload->>'product_id', '')::UUID;
    v_type := COALESCE(payload->>'operation_type', 'AJUSTE_DIRECTO');
    v_mode := COALESCE(payload->>'mode', 'delta');
    v_unit := NULLIF(payload->>'unit_mode', '');
    v_reason := NULLIF(payload->>'reason', '');
    v_origin_ref := NULLIF(payload->>'origin_ref', '');

    -- ── Validación de contrato: nunca excepción al cliente ──
    IF v_operation_id IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'operation_id es obligatorio');
    END IF;
    IF v_product_id IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'product_id inválido');
    END IF;
    IF v_type NOT IN ('VENTA', 'AJUSTE_DIRECTO', 'CONTEO', 'VACIADO', 'ANULACION', 'APERTURA') THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'operation_type no soportado: ' || v_type);
    END IF;
    IF v_mode NOT IN ('delta', 'count') THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'mode debe ser delta o count');
    END IF;
    BEGIN
        v_quantity := (payload->>'quantity')::NUMERIC;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'quantity no es numérica');
    END;
    IF v_quantity IS NULL OR v_quantity = 'NaN'::numeric THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'quantity no es finita');
    END IF;

    -- ── 1. Idempotencia: misma operación → resultado canónico, sin re-aplicar ──
    SELECT * INTO rec FROM public.inventory_operations WHERE operation_id = v_operation_id;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'status', 'already_processed',
            'operation_id', v_operation_id,
            'product_id', rec.product_id,
            'delta', rec.delta,
            'stock_before', rec.stock_before,
            'stock_after', rec.stock_after,
            'operation_row_id', rec.id
        );
    END IF;

    -- ── 2. Producto canónico debe existir (el contrato NUNCA crea productos) ──
    SELECT stock INTO v_current_stock FROM public.products WHERE id = v_product_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'producto desconocido');
    END IF;

    -- ── 3. Delta según modo (regla de cantidad única) ──
    IF v_mode = 'count' THEN
        IF v_quantity < 0 THEN
            RETURN jsonb_build_object('status', 'invalid', 'message', 'el conteo objetivo no puede ser negativo');
        END IF;
        v_delta := v_quantity - v_current_stock;
        v_new_stock := v_quantity;
    ELSE
        IF v_quantity = 0 THEN
            RETURN jsonb_build_object('status', 'invalid', 'message', 'delta cero no es una operación');
        END IF;
        v_delta := v_quantity;
        v_new_stock := v_current_stock + v_delta;
    END IF;

    -- ── 4. Política de negativos desde fuente confiable del servidor ──
    SELECT allow_negative INTO v_allow_negative
      FROM public.inventory_policies WHERE account_id = v_account_id;
    IF NOT FOUND THEN
        v_allow_negative := true; -- comportamiento vigente por defecto
    END IF;
    IF NOT v_allow_negative AND v_new_stock < 0 THEN
        RETURN jsonb_build_object(
            'status', 'stock_conflict',
            'operation_id', v_operation_id,
            'product_id', v_product_id,
            'current_stock', v_current_stock,
            'requested_delta', v_delta,
            'message', 'La política de stock negativo prohíbe este movimiento'
        );
    END IF;

    -- ── 5. Reclamar la operación (INSERT con clave única) ANTES de mutar el stock:
    -- si dos reintentos compiten, el índice único hace que el perdedor devuelva
    -- el resultado del ganador sin aplicar el delta dos veces. ──
    BEGIN
        INSERT INTO public.inventory_operations
            (operation_id, account_id, device_id, actor, product_id, operation_type,
             mode, quantity, unit_mode, delta, stock_before, stock_after, reason, origin_ref)
        VALUES
            (v_operation_id, v_account_id, v_device_id, v_actor, v_product_id, v_type,
             v_mode, v_quantity, v_unit, v_delta, v_current_stock, v_new_stock, v_reason, v_origin_ref)
        RETURNING id INTO v_op_row_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT * INTO rec FROM public.inventory_operations WHERE operation_id = v_operation_id;
        IF FOUND THEN
            RETURN jsonb_build_object(
                'status', 'already_processed',
                'operation_id', v_operation_id,
                'product_id', rec.product_id,
                'delta', rec.delta,
                'stock_before', rec.stock_before,
                'stock_after', rec.stock_after,
                'operation_row_id', rec.id
            );
        END IF;
        RAISE;
    END;

    UPDATE public.products SET stock = v_new_stock WHERE id = v_product_id;

    RETURN jsonb_build_object(
        'status', 'applied',
        'operation_id', v_operation_id,
        'product_id', v_product_id,
        'delta', v_delta,
        'stock_before', v_current_stock,
        'stock_after', v_new_stock,
        'operation_row_id', v_op_row_id
    );
END;
$function$;

-- Ejecución solo para service_role (mismo criterio que process_checkout).
REVOKE ALL ON FUNCTION public.apply_inventory_operation(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inventory_operation(jsonb) TO service_role;

COMMIT;

-- ============================================================
-- RESPALDO PRE-MIGRACIÓN 007 — public.process_checkout(jsonb)
-- Proyecto: fgzwmwrugerptfqfrsjd (PRODUCCIÓN)
-- Fecha de captura: 2026-10-26 (antes de aplicar 007_checkout_idempotent_response)
-- Cuenta del conector: supabase_mood-ashur
--
-- Conteos ANTES de la migración (solo referencia; el tráfico sigue vivo):
--   sales: 8533 | sale_items: 15063 | products: 2038
--   journal_entries: 18909 | inventory_adjustments: 9391
-- Permisos ANTES (pg_proc.proacl):
--   postgres=X/postgres | service_role=X/postgres   (SECURITY INVOKER: prosecdef=false)
--
-- ROLLBACK: el bloque siguiente es la definición EXACTA capturada con
-- pg_get_functiondef antes del cambio. Reemplazar la función con este
-- contenido restaura el comportamiento previo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_checkout(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    new_sale_id UUID;
    v_queue_id UUID;
    v_total NUMERIC(15,4);
    v_sync_origin TEXT;
    v_original_created_at TIMESTAMPTZ;
    item JSONB;
    payment JSONB;
    v_product_id UUID;
    v_qty NUMERIC(15,4);
    v_unit_price NUMERIC(15,4);
    v_subtotal NUMERIC(15,4);
    v_current_stock NUMERIC(15,4);
    v_new_stock NUMERIC(15,4);
    v_payment_amount NUMERIC(15,4);
    v_payment_method TEXT;
    v_payment_label TEXT;
    v_payment_currency TEXT;
    v_account_code TEXT;
BEGIN
    v_total := (payload->>'total')::NUMERIC;
    v_sync_origin := COALESCE(payload->>'sync_origin', 'online');
    v_queue_id := NULLIF(payload->>'queue_id', '')::UUID;

    IF payload ? 'original_created_at' AND payload->>'original_created_at' IS NOT NULL THEN
        v_original_created_at := (payload->>'original_created_at')::TIMESTAMPTZ;
    ELSE
        v_original_created_at := NOW();
    END IF;

    -- Primera comprobación rápida. La restricción UNIQUE protege también
    -- carreras simultáneas entre dos reintentos.
    IF v_queue_id IS NOT NULL THEN
        SELECT id INTO new_sale_id
        FROM public.sales
        WHERE queue_id = v_queue_id
        LIMIT 1;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'sale_id', new_sale_id,
                'total', v_total,
                'sync_origin', v_sync_origin
            );
        END IF;
    END IF;

    -- Crear la venta. Si dos dispositivos llegan al mismo tiempo, el índice
    -- único de queue_id hace que el segundo reintento devuelva la venta previa.
    BEGIN
        INSERT INTO public.sales (total, sync_origin, created_at, queue_id)
        VALUES (v_total, v_sync_origin, v_original_created_at, v_queue_id)
        RETURNING id INTO new_sale_id;
    EXCEPTION WHEN unique_violation THEN
        IF v_queue_id IS NOT NULL THEN
            SELECT id INTO new_sale_id FROM public.sales WHERE queue_id = v_queue_id LIMIT 1;
            IF FOUND THEN
                RETURN jsonb_build_object(
                    'success', true,
                    'duplicate', true,
                    'sale_id', new_sale_id,
                    'total', v_total,
                    'sync_origin', v_sync_origin
                );
            END IF;
        END IF;
        RAISE;
    END;

    -- Procesar artículos e inventario con bloqueo de fila.
    FOR item IN SELECT * FROM jsonb_array_elements(payload->'cart')
    LOOP
        v_product_id := (item->>'id')::UUID;
        v_qty := (item->>'qty')::NUMERIC;
        v_unit_price := (item->>'priceUsd')::NUMERIC;
        v_subtotal := v_qty * v_unit_price;

        INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (new_sale_id, v_product_id, v_qty, v_unit_price, v_subtotal);

        SELECT stock INTO v_current_stock
        FROM public.products
        WHERE id = v_product_id
        FOR UPDATE;

        IF FOUND THEN
            v_new_stock := v_current_stock - v_qty;
            UPDATE public.products SET stock = v_new_stock WHERE id = v_product_id;

            IF v_new_stock < 0 THEN
                INSERT INTO public.inventory_adjustments (product_id, sale_id, delta, stock_after)
                VALUES (v_product_id, new_sale_id, -v_qty, v_new_stock);
            END IF;
        END IF;
    END LOOP;

    -- Asientos contables.
    FOR payment IN SELECT * FROM jsonb_array_elements(payload->'payments')
    LOOP
        v_payment_amount := (payment->>'amountUsd')::NUMERIC;
        v_payment_method := payment->>'methodId';
        v_payment_currency := UPPER(COALESCE(payment->>'currency', 'USD'));
        v_payment_label := COALESCE(NULLIF(TRIM(payment->>'methodLabel'), ''), v_payment_method);

        IF v_payment_currency = 'BS' THEN
            IF v_payment_method ILIKE '%efectivo%' OR v_payment_method ILIKE '%cash%' THEN
                v_account_code := '101-CAJA';
            ELSE
                v_account_code := '102-BANCO';
            END IF;
        ELSIF v_payment_method ILIKE '%efectivo%'
           OR v_payment_method ILIKE '%cash%'
           OR v_payment_method ILIKE '%divisa%'
           OR v_payment_method = 'efectivo_usd' THEN
            v_account_code := '101-CAJA';
        ELSE
            v_account_code := '102-BANCO';
        END IF;

        IF v_payment_amount > 0 THEN
            INSERT INTO public.journal_entries
                (transaction_id, account_code, debit, credit, description, created_at)
            VALUES
                (new_sale_id, v_account_code, v_payment_amount, 0,
                 'Pago Recibido: ' || v_payment_label, v_original_created_at);
        END IF;
    END LOOP;

    IF payload ? 'fiadoUsd' AND (payload->>'fiadoUsd')::NUMERIC > 0 THEN
        INSERT INTO public.journal_entries
            (transaction_id, account_code, debit, credit, description, created_at)
        VALUES
            (new_sale_id, '112-CLIENTES', (payload->>'fiadoUsd')::NUMERIC,
             0, 'Venta Fiada', v_original_created_at);
    END IF;

    INSERT INTO public.journal_entries
        (transaction_id, account_code, debit, credit, description, created_at)
    VALUES
        (new_sale_id, '401-VENTAS', 0, v_total,
         'Ingreso por Venta #' || new_sale_id, v_original_created_at);

    PERFORM public.validate_double_entry(new_sale_id);

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'sale_id', new_sale_id,
        'total', v_total,
        'sync_origin', v_sync_origin
    );
END;
$function$;

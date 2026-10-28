-- ============================================================
-- MIGRACIÓN 012: process_checkout descuenta la cantidad de INVENTARIO
-- Proyecto: repo principal (portada desde el sandbox staging/, donde es
-- la 011). Base: cuerpo de process_checkout de la migración 011.
--
-- Problema: el carrito envía qty en la unidad VENDIDA. Al vender 6 unidades
-- sueltas de una caja de 12, el cliente descuenta 0.5 caja pero el servidor
-- restaba 6 cajas de products.stock.
--
-- Corrección: cada línea puede traer stock_qty (cantidad en unidad de
-- inventario). El servidor la usa para descontar stock, validar la política
-- de negativos y registrar inventory_adjustments; qty × priceUsd sigue
-- rigiendo sale_items y el dinero. Sin stock_qty (cliente anterior) se usa
-- qty como antes. Conserva las líneas libres de 011.
-- Misma firma; solo reemplaza el cuerpo de la función.
-- Disciplina de no-destrucción: aplicar siempre con snapshot previo y
-- verificación posterior (npm run data:snapshot → migración →
-- npm run data:verify). NO aplicada a producción.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.process_checkout(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
    new_sale_id UUID;
    v_queue_id UUID;
    v_account_id TEXT;
    v_total NUMERIC(15,4);
    v_sync_origin TEXT;
    v_original_created_at TIMESTAMPTZ;
    v_existing_total NUMERIC(15,4);
    v_existing_origin TEXT;
    v_inventory JSONB := '[]'::jsonb;
    v_conflicts JSONB := '[]'::jsonb;
    v_unknown JSONB := '[]'::jsonb;
    v_untracked JSONB := '[]'::jsonb;
    v_raw_id TEXT;
    v_allow_negative BOOLEAN;
    item JSONB;
    payment JSONB;
    v_product_id UUID;
    v_qty NUMERIC(15,4);
    v_stock_qty NUMERIC(15,4);
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
    v_account_id := NULLIF(payload->>'account_id', '');

    IF payload ? 'original_created_at' AND payload->>'original_created_at' IS NOT NULL THEN
        v_original_created_at := (payload->>'original_created_at')::TIMESTAMPTZ;
    ELSE
        v_original_created_at := NOW();
    END IF;

    -- ── Idempotencia: misma operación → resultado canónico, sin re-aplicar ──
    IF v_queue_id IS NOT NULL THEN
        SELECT id, total, sync_origin INTO new_sale_id, v_existing_total, v_existing_origin
        FROM public.sales
        WHERE queue_id = v_queue_id
        LIMIT 1;

        IF FOUND THEN
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'product_id', si.product_id,
                       'quantity', si.quantity,
                       'stock', p.stock
                   ) ORDER BY si.id), '[]'::jsonb)
              INTO v_inventory
              FROM public.sale_items si
              LEFT JOIN public.products p ON p.id = si.product_id
             WHERE si.sale_id = new_sale_id;

            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'sale_id', new_sale_id,
                'total', v_existing_total,
                'sync_origin', COALESCE(v_existing_origin, v_sync_origin),
                'inventory', v_inventory
            );
        END IF;
    END IF;

    -- ── Productos vinculados: el checkout NUNCA crea productos fantasma ──
    -- Cada item del carrito debe referenciar un producto del catálogo
    -- canónico (el mismo UUID del catálogo local). IDs desconocidos o no-UUID
    -- se rechazan de forma explícita y resoluble, sin aplicar nada.
    FOR item IN SELECT * FROM jsonb_array_elements(payload->'cart')
    LOOP
        v_raw_id := item->>'id';
        IF v_raw_id IS NULL
           OR v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            -- Línea libre ("Venta Libre" custom_*, IDs legacy no-UUID): se
            -- registra en la venta (dinero) sin producto ni inventario. Nunca
            -- bloquea una venta ya cobrada ni crea un producto fantasma.
            v_untracked := v_untracked || jsonb_build_object('id', v_raw_id);
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = v_raw_id::UUID) THEN
            v_unknown := v_unknown || jsonb_build_object(
                'id', v_raw_id, 'reason', 'producto no vinculado al catálogo');
        END IF;
    END LOOP;

    IF jsonb_array_length(v_unknown) > 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'status', 'unknown_product',
            'duplicate', false,
            'requires_resolution', true,
            'sync_origin', v_sync_origin,
            'message', 'El carrito referencia productos no vinculados al catálogo',
            'unknown_products', v_unknown
        );
    END IF;

    -- ── Política de negativos: fuente confiable en servidor ──
    SELECT allow_negative INTO v_allow_negative
      FROM public.inventory_policies WHERE account_id = v_account_id;
    IF NOT FOUND THEN
        v_allow_negative := true; -- comportamiento vigente por defecto
    END IF;

    -- ── Pre-validación: detectar conflictos SIN mutar nada ──
    IF NOT v_allow_negative THEN
        FOR item IN SELECT * FROM jsonb_array_elements(payload->'cart')
        LOOP
            -- Las líneas libres no mueven inventario: fuera de la política.
            CONTINUE WHEN item->>'id' IS NULL OR item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
            v_product_id := (item->>'id')::UUID;
            v_stock_qty := COALESCE(NULLIF(item->>'stock_qty', '')::NUMERIC, (item->>'qty')::NUMERIC);
            SELECT stock INTO v_current_stock FROM public.products WHERE id = v_product_id;
            IF FOUND AND (v_current_stock - v_stock_qty) < 0 THEN
                v_conflicts := v_conflicts || jsonb_build_object(
                    'product_id', v_product_id,
                    'requested_qty', v_stock_qty,
                    'available_stock', v_current_stock
                );
            END IF;
        END LOOP;

        IF jsonb_array_length(v_conflicts) > 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'status', 'stock_conflict',
                'duplicate', false,
                'requires_resolution', true,
                'sync_origin', v_sync_origin,
                'message', 'La política de stock negativo prohíbe este checkout',
                'conflicts', v_conflicts
            );
        END IF;
    END IF;

    -- ── Mutaciones en un bloque abortable completo: si una carrera alcanza
    -- el stock entre la pre-validación y la aplicación, TODO se revierte y se
    -- devuelve el mismo conflicto explícito. ──
    BEGIN
        -- Crear la venta. Si dos reintentos llegan al mismo tiempo, el índice
        -- único de queue_id hace que el perdedor devuelva la venta previa.
        BEGIN
            INSERT INTO public.sales (total, sync_origin, created_at, queue_id)
            VALUES (v_total, v_sync_origin, v_original_created_at, v_queue_id)
            RETURNING id INTO new_sale_id;
        EXCEPTION WHEN unique_violation THEN
            IF v_queue_id IS NOT NULL THEN
                SELECT id, total, sync_origin INTO new_sale_id, v_existing_total, v_existing_origin
                FROM public.sales WHERE queue_id = v_queue_id LIMIT 1;
                IF FOUND THEN
                    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                               'product_id', si.product_id,
                               'quantity', si.quantity,
                               'stock', p.stock
                           ) ORDER BY si.id), '[]'::jsonb)
                      INTO v_inventory
                      FROM public.sale_items si
                      LEFT JOIN public.products p ON p.id = si.product_id
                     WHERE si.sale_id = new_sale_id;

                    RETURN jsonb_build_object(
                        'success', true,
                        'duplicate', true,
                        'sale_id', new_sale_id,
                        'total', v_existing_total,
                        'sync_origin', COALESCE(v_existing_origin, v_sync_origin),
                        'inventory', v_inventory
                    );
                END IF;
            END IF;
            RAISE;
        END;

        FOR item IN SELECT * FROM jsonb_array_elements(payload->'cart')
        LOOP
            -- Línea libre: sale_items sin producto (product_id admite NULL),
            -- sin tocar stock ni inventory_adjustments.
            IF item->>'id' IS NULL OR item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                v_qty := (item->>'qty')::NUMERIC;
                v_unit_price := (item->>'priceUsd')::NUMERIC;
                INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, subtotal)
                VALUES (new_sale_id, NULL, v_qty, v_unit_price, v_qty * v_unit_price);
                CONTINUE;
            END IF;

            v_product_id := (item->>'id')::UUID;
            v_qty := (item->>'qty')::NUMERIC;
            -- Cantidad de inventario (012): stock_qty si el cliente la envía;
            -- clientes previos sin el campo conservan el comportamiento anterior.
            v_stock_qty := COALESCE(NULLIF(item->>'stock_qty', '')::NUMERIC, v_qty);
            v_unit_price := (item->>'priceUsd')::NUMERIC;
            v_subtotal := v_qty * v_unit_price;
            v_new_stock := NULL;

            -- El producto se vincula y bloquea ANTES de insertar la línea
            -- (sale_items.product_id tiene FK a products): si desapareció entre
            -- la pre-validación y aquí, el bloque completo se revierte con el
            -- mismo conflicto explícito.
            SELECT stock INTO v_current_stock
            FROM public.products
            WHERE id = v_product_id
            FOR UPDATE;

            IF NOT FOUND THEN
                RAISE 'unknown_product';
            END IF;

            INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, subtotal)
            VALUES (new_sale_id, v_product_id, v_qty, v_unit_price, v_subtotal);

            v_new_stock := v_current_stock - v_stock_qty;

            -- Re-chequeo bajo bloqueo de fila: punto de serialización.
            IF NOT v_allow_negative AND v_new_stock < 0 THEN
                RAISE 'stock_conflict';
            END IF;

            UPDATE public.products SET stock = v_new_stock WHERE id = v_product_id;

            IF v_new_stock < 0 THEN
                INSERT INTO public.inventory_adjustments (product_id, sale_id, delta, stock_after)
                VALUES (v_product_id, new_sale_id, -v_stock_qty, v_new_stock);
            END IF;

            v_inventory := v_inventory || jsonb_build_object(
                'product_id', v_product_id,
                'quantity', v_qty,
                'stock_qty', v_stock_qty,
                'stock', v_new_stock
            );
        END LOOP;

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

    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'stock_conflict' THEN
            RETURN jsonb_build_object(
                'success', false,
                'status', 'stock_conflict',
                'duplicate', false,
                'requires_resolution', true,
                'sync_origin', v_sync_origin,
                'message', 'Stock insuficiente detectado durante la aplicación; nada fue aplicado'
            );
        ELSIF SQLERRM = 'unknown_product' THEN
            RETURN jsonb_build_object(
                'success', false,
                'status', 'unknown_product',
                'duplicate', false,
                'requires_resolution', true,
                'sync_origin', v_sync_origin,
                'message', 'Producto no vinculado detectado durante la aplicación; nada fue aplicado'
            );
        END IF;
        RAISE;
    END;

    PERFORM public.validate_double_entry(new_sale_id);

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'sale_id', new_sale_id,
        'total', v_total,
        'sync_origin', v_sync_origin,
        'inventory', v_inventory,
        'untracked_lines', v_untracked
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_checkout(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_checkout(jsonb) TO service_role;

COMMIT;

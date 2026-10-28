-- ============================================================
-- MIGRACIÓN 013: Kardex — ventas en la libreta y corte de apertura
-- Fase 5 (docs/plans/2026-10-28-fase5-kardex.md). Requiere 008 y 012.
--   1. process_checkout escribe un movimiento VENTA por línea con
--      producto en inventory_operations, en la misma transacción que el
--      saldo (delta = -stock_qty, saldo antes/después, origin_ref = venta).
--      Firma y respuesta sin cambios: la app anterior sigue funcionando.
--   2. kardex_openings + RPC open_kardex: corte de apertura único por
--      cuenta. Cada producto enviado queda con un movimiento APERTURA
--      (modo conteo) desde el saldo del servidor al saldo del dispositivo.
--   3. sync_product_catalog registra un APERTURA "Alta de producto" al
--      crear un producto (account_id lo pone /api/catalog-sync).
--   4. kardex_summary: totales de un rango para la pantalla Movimientos.
-- ADITIVA: una tabla, un índice, dos funciones nuevas y dos cuerpos
-- reemplazados.
-- No borra filas. Solo open_kardex (acción explícita del dueño) cambia
-- products.stock, y deja la diferencia anotada en la libreta.
-- Disciplina de no-destrucción: snapshot -> migración -> data:verify.
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
    v_line INTEGER := 0;
    v_device_id TEXT;
    v_actor TEXT;
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
    v_device_id := NULLIF(payload->>'device_id', '');
    v_actor := NULLIF(payload->>'actor', '');

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
            v_line := v_line + 1;
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

            -- Kardex (013): movimiento VENTA en la misma transacción que el
            -- saldo. operation_id determinista por venta y línea: la venta ya
            -- es idempotente por queue_id, y ON CONFLICT nunca bloquea un cobro.
            -- origin_ref = queue_id (el id que guarda el dispositivo), para
            -- poder mostrar el número de venta local.
            INSERT INTO public.inventory_operations
                (operation_id, account_id, device_id, actor, product_id, operation_type,
                 mode, quantity, unit_mode, delta, stock_before, stock_after, reason, origin_ref)
            VALUES
                (md5('venta:' || new_sale_id::text || ':' || v_line::text)::uuid,
                 v_account_id, v_device_id, v_actor, v_product_id, 'VENTA',
                 'delta', v_stock_qty, NULLIF(item->>'_mode', ''), -v_stock_qty,
                 v_current_stock, v_new_stock, 'Venta', COALESCE(v_queue_id::text, new_sale_id::text))
            ON CONFLICT (operation_id) DO NOTHING;

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

CREATE OR REPLACE FUNCTION public.sync_product_catalog(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
    item JSONB;
    v_raw_id TEXT;
    v_id UUID;
    v_name TEXT;
    v_price NUMERIC(15,4);
    v_cost NUMERIC(15,4);
    v_stock NUMERIC(15,4);
    v_created JSONB := '[]'::jsonb;
    v_updated JSONB := '[]'::jsonb;
    v_rejected JSONB := '[]'::jsonb;
    v_account_id TEXT := NULLIF(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload->>'account_id' END, '');
BEGIN
    FOR item IN SELECT * FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(payload) = 'array'
             THEN payload
             ELSE COALESCE(payload->'products', '[]'::jsonb)
        END)
    LOOP
        v_raw_id := item->>'id';
        IF v_raw_id IS NULL
           OR v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            v_rejected := v_rejected || jsonb_build_object(
                'id', v_raw_id, 'reason', 'id inválido (se requiere el UUID del catálogo local)');
            CONTINUE;
        END IF;
        v_id := v_raw_id::UUID;
        v_name := NULLIF(TRIM(COALESCE(item->>'name', '')), '');

        BEGIN
            v_price := (item->>'price')::NUMERIC;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_price := NULL;
        END;
        BEGIN
            v_cost := (item->>'cost_price')::NUMERIC;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_cost := NULL;
        END;
        BEGIN
            v_stock := (item->>'stock')::NUMERIC;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_stock := NULL;
        END;

        IF v_name IS NULL AND NOT EXISTS (SELECT 1 FROM public.products WHERE id = v_id) THEN
            v_rejected := v_rejected || jsonb_build_object(
                'id', v_raw_id, 'reason', 'nombre requerido para registrar el producto');
            CONTINUE;
        END IF;

        -- INSERT = registro inicial: única vez que el catálogo fija un saldo
        -- (saldo de apertura transicional; el corte formal llega con el Kardex).
        BEGIN
            INSERT INTO public.products (id, name, stock, price, cost_price, barcode, category)
            VALUES (v_id, v_name, COALESCE(v_stock, 0), COALESCE(v_price, 0),
                    COALESCE(v_cost, 0), item->>'barcode', item->>'category')
            ON CONFLICT (id) DO NOTHING;

            IF FOUND THEN
                v_created := v_created || to_jsonb(v_id);
                -- Kardex (013): el alta fija el saldo inicial del producto.
                INSERT INTO public.inventory_operations
                    (operation_id, account_id, product_id, operation_type, mode,
                     quantity, delta, stock_before, stock_after, reason)
                VALUES
                    (md5('alta:' || v_id::text)::uuid, v_account_id, v_id, 'APERTURA', 'count',
                     COALESCE(v_stock, 0), COALESCE(v_stock, 0), 0, COALESCE(v_stock, 0),
                     'Alta de producto')
                ON CONFLICT (operation_id) DO NOTHING;
            ELSE
                -- UPDATE = SOLO metadatos. El stock enviado por la lista se
                -- ignora: los metadatos de catálogo no mutan existencias.
                UPDATE public.products SET
                    name = COALESCE(v_name, name),
                    price = COALESCE(v_price, price),
                    cost_price = COALESCE(v_cost, cost_price),
                    barcode = COALESCE(item->>'barcode', barcode),
                    category = COALESCE(item->>'category', category)
                WHERE id = v_id;
                v_updated := v_updated || to_jsonb(v_id);
            END IF;
        EXCEPTION WHEN unique_violation THEN
            -- Carrera benigna: otro proceso lo registró mientras llegaba este.
            UPDATE public.products SET
                name = COALESCE(v_name, name),
                price = COALESCE(v_price, price),
                cost_price = COALESCE(v_cost, cost_price),
                barcode = COALESCE(item->>'barcode', barcode),
                category = COALESCE(item->>'category', category)
            WHERE id = v_id;
            v_updated := v_updated || to_jsonb(v_id);
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 'ok',
        'created', v_created,
        'updated', v_updated,
        'rejected', v_rejected
    );
END;
$function$;

-- ── Corte de apertura: una fila por cuenta ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kardex_openings (
    account_id TEXT PRIMARY KEY,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor TEXT,
    device_id TEXT,
    product_count INTEGER NOT NULL DEFAULT 0
);
-- Sin políticas: solo service_role (vía /api/kardex).
ALTER TABLE public.kardex_openings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.open_kardex(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
    v_account_id TEXT := NULLIF(payload->>'account_id', '');
    v_actor TEXT := NULLIF(payload->>'actor', '');
    v_device_id TEXT := NULLIF(payload->>'device_id', '');
    v_opened_at TIMESTAMPTZ;
    item JSONB;
    v_raw_id TEXT;
    v_id UUID;
    v_stock NUMERIC(15,4);
    v_current NUMERIC(15,4);
    v_count INTEGER := 0;
    v_adjusted INTEGER := 0;
    v_unknown JSONB := '[]'::jsonb;
    v_skipped JSONB := '[]'::jsonb;
    rec RECORD;
BEGIN
    IF v_account_id IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'account_id es obligatorio');
    END IF;
    IF jsonb_typeof(payload->'products') IS DISTINCT FROM 'array' THEN
        RETURN jsonb_build_object('status', 'invalid', 'message', 'products debe ser una lista');
    END IF;

    -- Una sola apertura por cuenta: la fila se reclama ANTES de tocar nada;
    -- dos pulsaciones simultáneas -> la segunda espera y recibe already_opened.
    INSERT INTO public.kardex_openings (account_id, actor, device_id)
    VALUES (v_account_id, v_actor, v_device_id)
    ON CONFLICT (account_id) DO NOTHING
    RETURNING opened_at INTO v_opened_at;

    IF v_opened_at IS NULL THEN
        SELECT * INTO rec FROM public.kardex_openings WHERE account_id = v_account_id;
        RETURN jsonb_build_object(
            'status', 'already_opened',
            'opened_at', rec.opened_at,
            'actor', rec.actor,
            'product_count', rec.product_count
        );
    END IF;

    FOR item IN SELECT * FROM jsonb_array_elements(payload->'products')
    LOOP
        v_raw_id := item->>'id';
        IF v_raw_id IS NULL
           OR v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            v_skipped := v_skipped || jsonb_build_object('id', v_raw_id, 'reason', 'id inválido');
            CONTINUE;
        END IF;
        BEGIN
            v_stock := (item->>'stock')::NUMERIC;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_stock := NULL;
        END;
        IF v_stock IS NULL OR v_stock = 'NaN'::numeric THEN
            v_skipped := v_skipped || jsonb_build_object('id', v_raw_id, 'reason', 'stock inválido');
            CONTINUE;
        END IF;
        v_id := v_raw_id::UUID;

        SELECT stock INTO v_current FROM public.products WHERE id = v_id FOR UPDATE;
        IF NOT FOUND THEN
            v_unknown := v_unknown || to_jsonb(v_raw_id);
            CONTINUE;
        END IF;

        INSERT INTO public.inventory_operations
            (operation_id, account_id, device_id, actor, product_id, operation_type,
             mode, quantity, delta, stock_before, stock_after, reason)
        VALUES
            (md5('apertura:' || v_account_id || ':' || v_id::text)::uuid,
             v_account_id, v_device_id, v_actor, v_id, 'APERTURA',
             'count', v_stock, v_stock - v_current, v_current, v_stock, 'Corte de apertura')
        ON CONFLICT (operation_id) DO NOTHING;

        IF FOUND THEN
            v_count := v_count + 1;
            IF v_stock <> v_current THEN
                UPDATE public.products SET stock = v_stock WHERE id = v_id;
                v_adjusted := v_adjusted + 1;
            END IF;
        END IF;
    END LOOP;

    UPDATE public.kardex_openings SET product_count = v_count WHERE account_id = v_account_id;

    RETURN jsonb_build_object(
        'status', 'opened',
        'opened_at', v_opened_at,
        'product_count', v_count,
        'adjusted', v_adjusted,
        'unknown_products', v_unknown,
        'skipped', v_skipped
    );
END;
$function$;

-- ── Resumen de movimientos (pantalla Movimientos) ─────────────────────────
-- Totales de un rango para una cuenta: entradas y salidas (sin contar las
-- aperturas, que son saldo inicial y no movimiento) y número de filas.
CREATE OR REPLACE FUNCTION public.kardex_summary(payload jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
    SELECT jsonb_build_object(
        'count', COUNT(*),
        'entradas', COALESCE(SUM(delta) FILTER (WHERE delta > 0 AND operation_type <> 'APERTURA'), 0),
        'salidas', COALESCE(-SUM(delta) FILTER (WHERE delta < 0 AND operation_type <> 'APERTURA'), 0)
    )
    FROM public.inventory_operations
    WHERE account_id = NULLIF(payload->>'account_id', '')
      AND (payload->>'from' IS NULL OR created_at >= (payload->>'from')::timestamptz)
      AND (payload->>'to' IS NULL OR created_at < (payload->>'to')::timestamptz)
      AND (jsonb_typeof(payload->'types') IS DISTINCT FROM 'array'
           OR operation_type IN (SELECT jsonb_array_elements_text(payload->'types')))
      AND (jsonb_typeof(payload->'product_ids') IS DISTINCT FROM 'array'
           OR product_id::text IN (SELECT jsonb_array_elements_text(payload->'product_ids')));
$function$;

CREATE INDEX IF NOT EXISTS idx_inventory_operations_account_created
    ON public.inventory_operations (account_id, created_at);

-- Ejecución solo para service_role (mismo criterio que 006-012).
REVOKE ALL ON FUNCTION public.process_checkout(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_checkout(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_product_catalog(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_catalog(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.open_kardex(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_kardex(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.kardex_summary(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kardex_summary(jsonb) TO service_role;

COMMIT;

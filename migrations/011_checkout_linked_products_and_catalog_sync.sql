-- ============================================================
-- MIGRACIÓN 011: Checkout con productos vinculados + catálogo solo-metadatos
-- Proyecto: repo principal (portada desde el sandbox staging/, donde es
-- la 010). Requiere 008 y 010.
-- Fase 2 (fin) — eliminar mutaciones silenciosas:
--   1. process_checkout NUNCA crea productos fantasma. Un UUID que no
--      existe en public.products se rechaza en bloque con status
--      'unknown_product' explícito y resoluble, sin aplicar nada; el
--      cliente registra su catálogo (/api/catalog-sync) y reintenta el
--      MISMO operation_id. Se retiran el upsert de productos
--      desconocidos y la renominación de IDs legacy de los proxies.
--   2. Líneas libres (cambio respecto al sandbox): un id que NO es UUID
--      ("Venta Libre" custom_* o IDs legacy) ya no bloquea la venta: se
--      registra en sale_items con product_id NULL, sin mover stock, y se
--      informa en 'untracked_lines'. Una venta cobrada nunca queda
--      bloqueada sin salida por una línea que no es de catálogo.
--   3. Nueva RPC sync_product_catalog: metadatos del catálogo (nombre,
--      precios, código de barras, categoría) SIN mutar existencias — el
--      stock de la lista solo es saldo inicial al CREAR la fila.
--
-- ADITIVA respecto a datos: reemplaza el cuerpo de process_checkout
-- (misma firma) y crea una función nueva. No borra ni actualiza filas.
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
            v_qty := (item->>'qty')::NUMERIC;
            SELECT stock INTO v_current_stock FROM public.products WHERE id = v_product_id;
            IF FOUND AND (v_current_stock - v_qty) < 0 THEN
                v_conflicts := v_conflicts || jsonb_build_object(
                    'product_id', v_product_id,
                    'requested_qty', v_qty,
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

            v_new_stock := v_current_stock - v_qty;

            -- Re-chequeo bajo bloqueo de fila: punto de serialización.
            IF NOT v_allow_negative AND v_new_stock < 0 THEN
                RAISE 'stock_conflict';
            END IF;

            UPDATE public.products SET stock = v_new_stock WHERE id = v_product_id;

            IF v_new_stock < 0 THEN
                INSERT INTO public.inventory_adjustments (product_id, sale_id, delta, stock_after)
                VALUES (v_product_id, new_sale_id, -v_qty, v_new_stock);
            END IF;

            v_inventory := v_inventory || jsonb_build_object(
                'product_id', v_product_id,
                'quantity', v_qty,
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

-- ── RPC: sincronización de catálogo SOLO-METADATOS ─────────────────────────
-- Los metadatos del catálogo (nombre, precios, código de barras, categoría)
-- se registran/actualizan aquí, separados de las mutaciones de stock. El
-- campo `stock` de la lista es solo SALDO INICIAL al crear la fila: en
-- actualizaciones se IGNORA por completo (una lista desactualizada jamás
-- sobrescribe existencias; eso es dominio de apply_inventory_operation y
-- process_checkout). Los IDs no-UUID se reportan y se saltan — este contrato
-- NUNCA renombra identidades.
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

-- Permisos idénticos a 006/007/008: ejecución solo para service_role.
REVOKE ALL ON FUNCTION public.process_checkout(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_checkout(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_product_catalog(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_catalog(jsonb) TO service_role;

COMMIT;

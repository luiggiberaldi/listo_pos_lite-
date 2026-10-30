-- 017 · sync_product_catalog tolerante a códigos repetidos y sin reescrituras inútiles
--
-- Problema (30-oct-2026): dos productos con el mismo código de barras hacían
-- fallar TODO el envío del catálogo (idx_products_barcode, error 409). Los
-- productos nuevos nunca llegaban al servidor y las ventas que los traían
-- quedaban como CONFLICTO_CATALOGO. Además cada envío reescribía los ~2000
-- productos aunque no hubieran cambiado (842 mil actualizaciones), lo que
-- agotaba el Disk IO Budget de Supabase.
--
-- Ahora:
--   * Si el código ya lo usa OTRO producto, este se guarda sin código y se
--     avisa en 'warnings'. Un producto con problema nunca tumba a los demás.
--   * Solo se actualiza la fila si algún dato cambió de verdad.
--   * Mismo contrato: el stock solo fija el saldo inicial al crear; el alta
--     deja su asiento de APERTURA en inventory_operations (Kardex 013).

CREATE OR REPLACE FUNCTION public.sync_product_catalog(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    item JSONB;
    v_raw_id TEXT;
    v_id UUID;
    v_name TEXT;
    v_price NUMERIC(15,4);
    v_cost NUMERIC(15,4);
    v_stock NUMERIC(15,4);
    v_barcode TEXT;
    v_category TEXT;
    v_exists BOOLEAN;
    v_inserted BOOLEAN;
    v_created JSONB := '[]'::jsonb;
    v_updated JSONB := '[]'::jsonb;
    v_rejected JSONB := '[]'::jsonb;
    v_warnings JSONB := '[]'::jsonb;
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
        v_barcode := NULLIF(TRIM(COALESCE(item->>'barcode', '')), '');
        v_category := item->>'category';

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

        SELECT EXISTS (SELECT 1 FROM public.products WHERE id = v_id) INTO v_exists;

        IF v_name IS NULL AND NOT v_exists THEN
            v_rejected := v_rejected || jsonb_build_object(
                'id', v_raw_id, 'reason', 'nombre requerido para registrar el producto');
            CONTINUE;
        END IF;

        -- Código de barras que ya usa otro producto: se guarda sin código.
        IF v_barcode IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.products WHERE barcode = v_barcode AND id <> v_id
        ) THEN
            v_warnings := v_warnings || jsonb_build_object(
                'id', v_raw_id, 'barcode', v_barcode,
                'reason', 'código de barras repetido: lo usa otro producto; se guardó sin código');
            v_barcode := NULL;
        END IF;

        BEGIN
            IF NOT v_exists THEN
                -- INSERT = registro inicial: única vez que el catálogo fija un saldo.
                INSERT INTO public.products (id, name, stock, price, cost_price, barcode, category)
                VALUES (v_id, v_name, COALESCE(v_stock, 0), COALESCE(v_price, 0),
                        COALESCE(v_cost, 0), v_barcode, v_category)
                ON CONFLICT (id) DO NOTHING;
                v_inserted := FOUND;
            ELSE
                v_inserted := FALSE;
            END IF;

            IF v_inserted THEN
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
                -- UPDATE = SOLO metadatos, y solo si algo cambió (sin
                -- reescrituras inútiles). El stock de la lista se ignora.
                UPDATE public.products SET
                    name = COALESCE(v_name, name),
                    price = COALESCE(v_price, price),
                    cost_price = COALESCE(v_cost, cost_price),
                    barcode = COALESCE(v_barcode, barcode),
                    category = COALESCE(v_category, category)
                WHERE id = v_id
                  AND (name IS DISTINCT FROM COALESCE(v_name, name)
                    OR price IS DISTINCT FROM COALESCE(v_price, price)
                    OR cost_price IS DISTINCT FROM COALESCE(v_cost, cost_price)
                    OR barcode IS DISTINCT FROM COALESCE(v_barcode, barcode)
                    OR category IS DISTINCT FROM COALESCE(v_category, category));
                IF FOUND THEN
                    v_updated := v_updated || to_jsonb(v_id);
                END IF;
            END IF;
        EXCEPTION WHEN unique_violation THEN
            -- Carrera: otro envío tomó el código (o el id) mientras llegaba este.
            -- Se reintenta sin tocar el código de barras.
            v_warnings := v_warnings || jsonb_build_object(
                'id', v_raw_id, 'barcode', v_barcode,
                'reason', 'código de barras repetido: lo usa otro producto; se guardó sin código');
            IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = v_id) THEN
                INSERT INTO public.products (id, name, stock, price, cost_price, barcode, category)
                VALUES (v_id, v_name, COALESCE(v_stock, 0), COALESCE(v_price, 0),
                        COALESCE(v_cost, 0), NULL, v_category)
                ON CONFLICT (id) DO NOTHING;
                IF FOUND THEN
                    v_created := v_created || to_jsonb(v_id);
                    INSERT INTO public.inventory_operations
                        (operation_id, account_id, product_id, operation_type, mode,
                         quantity, delta, stock_before, stock_after, reason)
                    VALUES
                        (md5('alta:' || v_id::text)::uuid, v_account_id, v_id, 'APERTURA', 'count',
                         COALESCE(v_stock, 0), COALESCE(v_stock, 0), 0, COALESCE(v_stock, 0),
                         'Alta de producto')
                    ON CONFLICT (operation_id) DO NOTHING;
                END IF;
            ELSE
                UPDATE public.products SET
                    name = COALESCE(v_name, name),
                    price = COALESCE(v_price, price),
                    cost_price = COALESCE(v_cost, cost_price),
                    category = COALESCE(v_category, category)
                WHERE id = v_id
                  AND (name IS DISTINCT FROM COALESCE(v_name, name)
                    OR price IS DISTINCT FROM COALESCE(v_price, price)
                    OR cost_price IS DISTINCT FROM COALESCE(v_cost, cost_price)
                    OR category IS DISTINCT FROM COALESCE(v_category, category));
                IF FOUND THEN
                    v_updated := v_updated || to_jsonb(v_id);
                END IF;
            END IF;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 'ok',
        'created', v_created,
        'updated', v_updated,
        'rejected', v_rejected,
        'warnings', v_warnings
    );
END;
$function$;

-- ── Rollback (manual) ─────────────────────────────────────────────
-- Volver a crear la función con la definición de 011/013.

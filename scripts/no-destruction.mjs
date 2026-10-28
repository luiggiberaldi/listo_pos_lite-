#!/usr/bin/env node
// scripts/no-destruction.mjs — Gate de no-destrucción para despliegues/migraciones.
//
// Flujo de uso (3 pasos):
//   1. ANTES del despliegue o migración:  npm run data:snapshot
//   2. Aplicar la migración / desplegar el código.
//   3. DESPUÉS:                          npm run data:verify
//
// La verificación falla (exit 1) si detecta indicios de destrucción de datos:
//   - Conteos que bajan en tablas de solo-creación (ventas, líneas, asientos,
//     ajustes de inventario).
//   - Muestras de ventas que desaparecen o cuyo total/fecha fueron alterados.
//   - Muestras de productos que desaparecen (tolerable con --product-tolerance).
//   - Comparación contra un snapshot de OTRO proyecto (host distinto).
//
// Compara el MISMO proyecto antes/después; el tráfico legítimo solo agrega
// filas, así que cualquier baja es sospechosa. Nunca imprime credenciales.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_SNAPSHOT = 'docs/backups/no-destruction/latest.json';
const APPEND_ONLY_TABLES = ['sales', 'sale_items', 'journal_entries', 'inventory_adjustments', 'inventory_operations'];
const MUTABLE_TABLES = ['products'];
const SAMPLE_LIMIT = 25;

// ── Utilidades de entorno (convención de migrate_inventory.js) ──────────────

export function parseEnvFile(text) {
    const out = {};
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[match[1]] = value;
    }
    return out;
}

function loadEnv(envFiles) {
    const merged = {};
    const files = envFiles.length > 0 ? envFiles : ['.env'];
    for (const file of files) {
        try {
            Object.assign(merged, parseEnvFile(fs.readFileSync(file, 'utf8')));
        } catch {
            // Archivo ausente: se ignoran las claves que no aporte.
        }
    }
    // process.env siempre tiene prioridad sobre los archivos.
    for (const [key, value] of Object.entries(process.env)) {
        if (value != null && value !== '') merged[key] = value;
    }
    return merged;
}

function resolveConfig(envFiles) {
    const env = loadEnv(envFiles);
    const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
    const serviceKey = env.SUPABASE_SERVICE_KEY;
    if (!url) {
        console.error('Falta la URL de Supabase (VITE_SUPABASE_URL o SUPABASE_URL).');
        process.exit(2);
    }
    if (!serviceKey) {
        console.error('Falta SUPABASE_SERVICE_KEY (clave de servicio para conteos globales, sin RLS).');
        console.error('Provéela por variable de entorno o --env-file; nunca se imprime ni se guarda en el snapshot.');
        process.exit(2);
    }
    const host = new URL(url).host.toLowerCase();
    const projectRef = host.split('.')[0];
    return { url: url.replace(/\/$/, ''), serviceKey, host, projectRef };
}

// ── Acceso a datos (PostgREST con clave de servicio) ────────────────────────

async function rest(cfg, table, query) {
    const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
        headers: {
            apikey: cfg.serviceKey,
            Authorization: `Bearer ${cfg.serviceKey}`,
            Prefer: 'count=exact',
        },
    });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status} consultando ${table}: ${(await res.text()).slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    return res;
}

async function fetchCount(cfg, table) {
    const res = await rest(cfg, table, 'select=id&limit=1');
    const contentRange = res.headers.get('content-range') || '';
    await res.arrayBuffer();
    const total = contentRange.split('/')[1];
    const count = Number.parseInt(total, 10);
    if (!Number.isFinite(count)) {
        throw new Error(`No se pudo obtener el conteo de ${table} (content-range: ${contentRange || 'ausente'})`);
    }
    return count;
}

async function fetchRows(cfg, table, select, query) {
    const res = await rest(cfg, table, `select=${select}&${query}`);
    return res.json();
}

async function fetchCounts(cfg, tables) {
    const counts = {};
    for (const table of tables) {
        try {
            counts[table] = await fetchCount(cfg, table);
        } catch (err) {
            // Tabla aún no creada en este proyecto (migración pendiente): se
            // omite del snapshot. Una tabla que DESAPARECE sí es destrucción:
            // su conteo previo pasa a contar como 0 y la comparación falla.
            if (err?.status === 404) continue;
            throw err;
        }
    }
    return counts;
}

export async function buildSnapshot(cfg, { limit = SAMPLE_LIMIT } = {}) {
    const tables = [...APPEND_ONLY_TABLES, ...MUTABLE_TABLES];
    const [counts, sales, products] = await Promise.all([
        fetchCounts(cfg, tables),
        fetchRows(cfg, 'sales', 'id,total,created_at', `order=created_at.desc&limit=${limit}`),
        fetchRows(cfg, 'products', 'id,name', `order=id.asc&limit=${limit}`),
    ]);
    return {
        projectRef: cfg.projectRef,
        host: cfg.host,
        createdAt: new Date().toISOString(),
        counts,
        samples: { sales, products },
    };
}

// Estado "después": mismas filas muestreadas, reconsultadas por ID (una venta
// puede dejar de estar entre las 25 más recientes sin haber sido eliminada).
export async function buildAfterState(cfg, before, { productTolerance = 0 } = {}) {
    const tables = [...APPEND_ONLY_TABLES, ...MUTABLE_TABLES];
    const saleIds = (before.samples?.sales || []).map(row => row.id).filter(Boolean);
    const productIds = (before.samples?.products || []).map(row => row.id).filter(Boolean);
    const [counts, sales, products] = await Promise.all([
        fetchCounts(cfg, tables),
        saleIds.length > 0
            ? fetchRows(cfg, 'sales', 'id,total,created_at', `id=in.(${saleIds.join(',')})`)
            : Promise.resolve([]),
        productIds.length > 0
            ? fetchRows(cfg, 'products', 'id,name', `id=in.(${productIds.join(',')})`)
            : Promise.resolve([]),
    ]);
    return {
        projectRef: cfg.projectRef,
        host: cfg.host,
        createdAt: new Date().toISOString(),
        counts,
        samples: { sales, products },
        productTolerance,
    };
}

// ── Comparación pura (sin I/O; unit-tests en tests/noDestruction.test.mjs) ──

export function compareSnapshots(before, after, { productTolerance = 0 } = {}) {
    const violations = [];
    const warnings = [];

    if (before.projectRef !== after.projectRef) {
        violations.push(
            `Proyectos distintos: el snapshot es de "${before.projectRef}" y el estado actual es de "${after.projectRef}". No se puede evaluar destrucción entre proyectos diferentes.`
        );
    }

    for (const table of APPEND_ONLY_TABLES) {
        const b = Number(before.counts?.[table] ?? 0);
        const a = Number(after.counts?.[table] ?? 0);
        if (a < b) {
            violations.push(`La tabla "${table}" perdió filas: ${b} → ${a} (${b - a} menos).`);
        }
    }
    for (const table of MUTABLE_TABLES) {
        const b = Number(before.counts?.[table] ?? 0);
        const a = Number(after.counts?.[table] ?? 0);
        if (a < b) {
            const drop = b - a;
            const message = `La tabla "${table}" perdió filas: ${b} → ${a} (${drop} menos).`;
            if (drop > productTolerance) violations.push(message);
            else warnings.push(`${message} (dentro de la tolerancia de ${productTolerance})`);
        }
    }

    const salesAfter = new Map((after.samples?.sales || []).map(row => [row.id, row]));
    for (const row of before.samples?.sales || []) {
        const found = salesAfter.get(row.id);
        if (!found) {
            violations.push(`Venta muestreada ${row.id} ya no existe (fue eliminada).`);
            continue;
        }
        if (String(found.total) !== String(row.total) || String(found.created_at) !== String(row.created_at)) {
            violations.push(
                `Venta muestreada ${row.id} fue alterada: total ${row.total} → ${found.total}, fecha ${row.created_at} → ${found.created_at}.`
            );
        }
    }

    const productsAfter = new Set((after.samples?.products || []).map(row => row.id));
    const missingProducts = (before.samples?.products || [])
        .map(row => row.id)
        .filter(id => !productsAfter.has(id));
    if (missingProducts.length > 0) {
        const message = `Productos muestreados eliminados (${missingProducts.length}): ${missingProducts.join(', ')}.`;
        if (missingProducts.length > productTolerance) violations.push(message);
        else warnings.push(`${message} (dentro de la tolerancia de ${productTolerance})`);
    }

    return { violations, warnings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { command: argv[0], envFiles: [], out: DEFAULT_SNAPSHOT, against: DEFAULT_SNAPSHOT, expectHost: null, productTolerance: 0, limit: SAMPLE_LIMIT };
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--env-file') args.envFiles.push(argv[++i]);
        else if (arg === '--out') args.out = argv[++i];
        else if (arg === '--against') args.against = argv[++i];
        else if (arg === '--expect-host') args.expectHost = String(argv[++i]).toLowerCase();
        else if (arg === '--product-tolerance') args.productTolerance = Number.parseInt(argv[++i], 10) || 0;
        else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10) || SAMPLE_LIMIT;
        else if (arg === '--help' || arg === '-h') args.command = 'help';
        else {
            console.error(`Argumento desconocido: ${arg}`);
            process.exit(2);
        }
    }
    return args;
}

function assertExpectedHost(cfg, expectHost) {
    if (expectHost && cfg.host !== expectHost) {
        console.error(`El destino es ${cfg.host} pero se esperaba ${expectHost}. Abortando para no tocar el proyecto equivocado.`);
        process.exit(2);
    }
}

function printCounts(counts) {
    return Object.entries(counts).map(([t, n]) => `${t}=${n}`).join('  ');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const tables = [...APPEND_ONLY_TABLES, ...MUTABLE_TABLES];

    if (args.command === 'help' || !args.command) {
        console.log(`Uso: node scripts/no-destruction.mjs <snapshot|verify> [opciones]

  snapshot   Captura conteos y muestras del proyecto destino (ANTES del cambio).
  verify     Reconsulta el proyecto y compara contra el snapshot (DESPUÉS).

Opciones:
  --env-file <ruta>          Archivo .env con credenciales (repetible).
  --out <ruta>               Dónde guardar el snapshot (default ${DEFAULT_SNAPSHOT}).
  --against <ruta>           Snapshot contra el cual verificar (default ${DEFAULT_SNAPSHOT}).
  --expect-host <host>       Aborta si el destino no es ese host (anti-error de proyecto).
  --product-tolerance <n>    Productos muestreados que pueden faltar sin fallar (default 0).
  --limit <n>                Tamaño de las muestras (default ${SAMPLE_LIMIT}).

Credenciales: VITE_SUPABASE_URL (o SUPABASE_URL) y SUPABASE_SERVICE_KEY.
Nunca se imprimen ni se guardan en el snapshot.`);
        return;
    }

    const cfg = resolveConfig(args.envFiles);
    assertExpectedHost(cfg, args.expectHost);

    if (args.command === 'snapshot') {
        console.log(`▶ No-destrucción · snapshot`);
        console.log(`  Destino: ${cfg.url} (proyecto ${cfg.projectRef})`);
        const snapshot = await buildSnapshot(cfg, { limit: args.limit });
        console.log(`  Conteos: ${printCounts(snapshot.counts)}`);
        console.log(`  Muestras: ${snapshot.samples.sales.length} ventas, ${snapshot.samples.products.length} productos`);
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, JSON.stringify(snapshot, null, 2));
        console.log(`  Guardado en: ${args.out}`);
        console.log(`  Siguiente paso: aplicar la migración / desplegar, luego "npm run data:verify".`);
        return;
    }

    if (args.command === 'verify') {
        let before;
        try {
            before = JSON.parse(fs.readFileSync(args.against, 'utf8'));
        } catch {
            console.error(`No se pudo leer el snapshot ${args.against}. Ejecute primero "npm run data:snapshot".`);
            process.exit(2);
        }
        console.log(`▶ No-destrucción · verificación contra ${args.against}`);
        console.log(`  Destino: ${cfg.url} (proyecto ${cfg.projectRef})`);
        const after = await buildAfterState(cfg, before, { productTolerance: args.productTolerance });
        console.log(`  Conteos actuales: ${printCounts(after.counts)}`);
        const { violations, warnings } = compareSnapshots(before, after, { productTolerance: args.productTolerance });

        for (const warning of warnings) console.warn(`  ⚠ ${warning}`);
        if (violations.length === 0) {
            console.log(`  RESULTADO: sin indicios de destrucción (0 violaciones, ${warnings.length} advertencias).`);
            return;
        }
        for (const violation of violations) console.error(`  ✖ ${violation}`);
        console.error(`  RESULTADO: ${violations.length} violación(es) de no-destrucción.`);
        process.exit(1);
        return;
    }

    console.error(`Comando desconocido: ${args.command} (use snapshot, verify o --help)`);
    process.exit(2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch(error => {
        console.error(`Error: ${error?.message || error}`);
        process.exit(2);
    });
}

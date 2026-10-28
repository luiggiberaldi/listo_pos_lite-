#!/usr/bin/env node
// scripts/backup-export.mjs — Respaldo lógico de las tablas críticas a disco.
//
// El plan gratuito de Supabase no ofrece respaldos descargables; este script
// exporta, por la API REST con la clave de servicio, cada tabla completa a un
// archivo JSON y escribe un manifiesto con conteos y huellas SHA-256. Solo LEE.
//
// Uso:
//   node scripts/backup-export.mjs --env-file .env --env-file .dev.vars --expect-host <ref>.supabase.co
//
// Salida: backups/<ref>-<fecha>/<tabla>.json + manifest.json (carpeta ignorada
// por git: contiene datos de clientes, nunca se versiona). Nunca imprime ni
// guarda credenciales.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseEnvFile } from './no-destruction.mjs';

// Tabla → columna de orden estable para paginar.
const TABLES = {
    products: 'id',
    sales: 'id',
    sale_items: 'id',
    journal_entries: 'id',
    inventory_adjustments: 'id',
    inventory_operations: 'id',
    inventory_policies: 'account_id',
    sync_documents: 'id',
};
let PAGE = 1000;

function parseArgs(argv) {
    const args = { envFiles: [], expectHost: null, outDir: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') args.envFiles.push(argv[++i]);
        else if (argv[i] === '--expect-host') args.expectHost = String(argv[++i]).toLowerCase();
        else if (argv[i] === '--out-dir') args.outDir = argv[++i];
        else if (argv[i] === '--page') PAGE = Number.parseInt(argv[++i], 10) || PAGE; // solo para ensayos
    }
    return args;
}

function loadEnv(files) {
    const env = {};
    for (const f of files) {
        try { Object.assign(env, parseEnvFile(fs.readFileSync(f, 'utf8'))); } catch { /* archivo ausente */ }
    }
    for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
    return env;
}

async function exportTable(base, headers, table, orderBy) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const res = await fetch(`${base}/rest/v1/${table}?select=*&order=${orderBy}.asc`, {
            headers: { ...headers, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' },
        });
        if (!res.ok && res.status !== 206) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
        const page = await res.json();
        rows.push(...page);
        const total = Number(res.headers.get('content-range')?.split('/')[1]);
        if (page.length < PAGE || (Number.isFinite(total) && rows.length >= total)) {
            return { rows, total: Number.isFinite(total) ? total : rows.length };
        }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const env = loadEnv(args.envFiles.length ? args.envFiles : ['.env']);
    const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_KEY.');
    const host = new URL(url).hostname.toLowerCase();
    if (!args.expectHost) throw new Error('Indica --expect-host <ref>.supabase.co para confirmar el proyecto.');
    if (host !== args.expectHost) throw new Error(`Guarda: el destino es ${host}, no ${args.expectHost}. Abortado.`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ref = host.split('.')[0];
    const outDir = args.outDir || path.join('backups', `${ref}-${stamp}`);
    fs.mkdirSync(outDir, { recursive: true });

    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const manifest = { project: host, startedAt: new Date().toISOString(), tables: {} };
    for (const [table, orderBy] of Object.entries(TABLES)) {
        const { rows, total } = await exportTable(url.replace(/\/$/, ''), headers, table, orderBy);
        const json = JSON.stringify(rows);
        fs.writeFileSync(path.join(outDir, `${table}.json`), json);
        const sha256 = crypto.createHash('sha256').update(json).digest('hex');
        manifest.tables[table] = { rows: rows.length, totalReportado: total, completo: rows.length === total, sha256 };
        console.log(`${rows.length === total ? '✅' : '⚠️ '} ${table}: ${rows.length}/${total}`);
    }
    manifest.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const incompletas = Object.entries(manifest.tables).filter(([, t]) => !t.completo).map(([n]) => n);
    console.log(`\nRespaldo en ${outDir}${incompletas.length ? ` — INCOMPLETAS: ${incompletas.join(', ')} (el tráfico siguió escribiendo; repetir o aceptar)` : ' — completo'}`);
    process.exit(incompletas.length ? 2 : 0);
}

main().catch(err => { console.error(err.message); process.exit(1); });

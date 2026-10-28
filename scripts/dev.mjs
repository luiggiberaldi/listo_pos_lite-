// Arranque de desarrollo: la web (Vite, puerto 5173) y la API (wrangler dev,
// puerto 8787) juntas. Vite reenvía /api a la 8787 (vite.config.js); sin la
// API, /api/checkout responde 500 y las ventas se quedan en la cola ("Sync (1)").
//
//   npm run dev       → web + API
//   npm run dev:web   → solo la web
//   npm run dev:api   → solo la API
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const isWindows = process.platform === 'win32';

if (!existsSync('.dev.vars')) {
    console.warn(
        '\n[dev] ⚠ Falta .dev.vars: la API arrancará pero /api/checkout responderá 500.\n' +
        '[dev]   Copia .dev.vars.example como .dev.vars y pega tu SUPABASE_SERVICE_KEY.\n'
    );
}

// wrangler.jsonc sirve ./dist como assets: debe existir aunque no haya build.
if (!existsSync('dist')) mkdirSync('dist');

const COLORS = { web: '\x1b[36m', api: '\x1b[35m' };
const RESET = '\x1b[0m';

function run(name, command) {
    // Comando fijo (sin datos del usuario): en Windows npx necesita la shell.
    const child = spawn(command, { shell: true, env: process.env });
    const prefix = `${COLORS[name]}[${name}]${RESET} `;
    const pipe = (stream, out) => {
        let buffer = '';
        stream.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) out.write(prefix + line + '\n');
        });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('exit', code => {
        console.log(`${prefix}terminó (código ${code ?? 0}); cerrando todo.`);
        shutdown(code ?? 0);
    });
    return child;
}

const children = [
    run('web', 'npx vite'),
    run('api', 'npx wrangler dev --port 8787'),
];

let closing = false;
function shutdown(code) {
    if (closing) return;
    closing = true;
    for (const child of children) {
        if (child.exitCode !== null) continue;
        // Con shell hay que cerrar el árbol de procesos completo (Windows).
        if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

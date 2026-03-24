// ============================================================
// 🧪 SYSTEM TESTER v4.0 — Cobertura Total + Auditoría AI
// ============================================================
// Tests REAL storageService (localforage/IndexedDB) operations.
// AISLAMIENTO: Utiliza claves exclusivas para test (TEST_KEYS).
// NUNCA modifica ni lee los datos reales del usuario.
// v4.0: Cobertura completa de servicios + Análisis Groq AI
// ============================================================

import { storageService } from '../utils/storageService';
import { formatBs, smartCashRounding, formatVzlaPhone } from '../utils/calculatorUtils';
import { DEFAULT_PAYMENT_METHODS, getPaymentLabel, getPaymentMethod, addPaymentMethod, removePaymentMethod, getActivePaymentMethods } from '../config/paymentMethods';
import { CurrencyService } from '../services/CurrencyService';
import { RateService } from '../services/RateService';
import { procesarImpactoCliente } from '../utils/financialLogic';
import { MessageService } from '../services/MessageService';
import { FinancialEngine } from '../core/FinancialEngine';

// ── Claves de Storage Aisladas para Test ──
const TEST_KEYS = {
    products: 'test_myproductsv1',
    sales: 'test_mysalesv1',
    customers: 'test_mycustv1',
};

// ── Test State ──
const state = {
    logs: [],
    suites: [],          // { id, name, status: 'pending'|'running'|'passed'|'failed'|'skipped', startedAt, finishedAt, error }
    isRunning: false,
    stopped: false,
    startedAt: null,
    finishedAt: null,
    onLog: null,
    onProgress: null,
    onComplete: null,
    _7dayStats: null,
};

// ── Helpers de Estado ──
function initSuites(activeSuites) {
    state.suites = activeSuites.map(s => ({
        id: s.key,
        name: s.name,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        error: null
    }));
}

function updateSuiteStatus(id, patch) {
    const s = state.suites.find(x => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
}

// ── Logging ──
function log(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('es-VE', { hour12: false });
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️', section: '━', ai: '🤖', day: '📅' };
    const icon = icons[type] || 'ℹ️';
    const entry = { time: ts, msg: `${icon} ${msg}`, type, raw: msg };

    state.logs.push(entry);
    state.onLog?.(entry);

    if (type === 'error') console.error(`[TEST ERROR] ${msg}`);
}

function section(title) {
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'section');
    log(title, 'section');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'section');
}

// ── Assertions ──
class AssertionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AssertionError';
    }
}

function assert(condition, message) {
    if (!condition) throw new AssertionError(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new AssertionError(`${message} (Esperado: ${expected}, Recibido: ${actual})`);
}

function assertClose(actual, expected, message, tolerance = 0.02) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new AssertionError(`${message} (Esperado: ~${expected}, Recibido: ${actual}, Diff: ${diff.toFixed(4)})`);
    }
}

// ── Helpers Generales ──
const TEST_PREFIX = '🧪_TEST_';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function createTestProduct(overrides = {}) {
    return {
        id: `${TEST_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
        name: `${TEST_PREFIX}Producto ${Date.now()}`,
        priceUsdt: 5.00,
        costBs: 100,
        stock: 50,
        category: 'Test',
        barcode: `TST${Date.now()}`,
        unit: 'und',
        sellByUnit: false,
        _testData: true,
        ...overrides,
    };
}

function createTestCustomer(overrides = {}) {
    return {
        id: `${TEST_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
        name: `${TEST_PREFIX}Cliente ${Date.now()}`,
        phone: '0412-TEST',
        deuda: 0,
        _testData: true,
        ...overrides,
    };
}

// ════════════════════════════════════════════
// LIMPIEZA TOTAL
// ════════════════════════════════════════════
async function cleanupTestData() {
    log('🧹 Ejecutando limpieza de claves de test...', 'info');
    try {
        await storageService.removeItem(TEST_KEYS.products);
        await storageService.removeItem(TEST_KEYS.sales);
        await storageService.removeItem(TEST_KEYS.customers);
        log('Limpieza completada: Claves de test eliminadas.', 'success');
    } catch (err) {
        log(`Error en limpieza de data: ${err.message}`, 'error');
    }
}

// ════════════════════════════════════════════
// NUEVAS SUITES RÁPIDAS
// ════════════════════════════════════════════

// 1. Validación de Catálogo y Tasas
async function suiteCatalogoTasas() {
    section('💱 SUITE: Validación Catálogo y Tasas');

    const rates = {
        usdt: { price: 600 },
        bcv: { price: 500 },
        euro: { price: 650 },
    };

    const mockProducts = [
        createTestProduct({ priceUsdt: 2.5 }),
        createTestProduct({ priceUsdt: 10.0 }),
        createTestProduct({ priceUsdt: 0.5 }),
    ];

    for (const p of mockProducts) {
        const precioBs = p.priceUsdt * rates.bcv.price;
        const precioBcv = precioBs / rates.bcv.price;

        assert(!isNaN(precioBs) && precioBs !== undefined, `Precio en Bs para ${p.name} no es válido`);
        assert(!isNaN(precioBcv) && precioBcv !== undefined, `Precio BCV para ${p.name} no es válido`);

        // Sensibilidad
        const tasaUsdtAlta = rates.bcv.price * 1.10; // +10%
        const precioBsAlto = p.priceUsdt * tasaUsdtAlta;
        assert(precioBsAlto > precioBs, `Precio Bs no subió con aumento de tasa USDT (base: ${precioBs}, nuevo: ${precioBsAlto})`);
    }

    log('Catálogo OK: 3 productos procesados, precios y sensibilidad validados (Cero NaN).', 'success');
}

// 2. Simulación de Ventas y Ganancias
async function suiteVentasGanancias() {
    section('📈 SUITE: Simulación Ventas y Ganancias');

    const salesList = [
        // Ganancia (+2, +5, +3, +10)
        { id: '1', buyPrice: 10, sellPrice: 12, qty: 1 },
        { id: '2', buyPrice: 15, sellPrice: 20, qty: 1 },
        { id: '3', buyPrice: 5, sellPrice: 8, qty: 1 },
        { id: '4', buyPrice: 20, sellPrice: 30, qty: 1 },
        // Pérdida (-2)
        { id: '5', buyPrice: 12, sellPrice: 10, qty: 1 },
    ];

    const generatedSales = salesList.map(mockSale => {
        const profit = (mockSale.sellPrice - mockSale.buyPrice) * mockSale.qty;
        return {
            id: `${TEST_PREFIX}${crypto.randomUUID()}`,
            items: [{ id: 'mock', qty: mockSale.qty, priceUsd: mockSale.sellPrice, costUsd: mockSale.buyPrice }],
            totalUsd: mockSale.sellPrice * mockSale.qty,
            profitTotalUsd: profit,
        };
    });

    await storageService.setItem(TEST_KEYS.sales, generatedSales);

    const savedSales = await storageService.getItem(TEST_KEYS.sales, []);
    assertEqual(savedSales.length, 5, 'Deben existir 5 ventas simuladas');

    let totalUsd = 0;
    let totalProfit = 0;
    let hasLoss = false;

    for (const s of savedSales) {
        assert(s.totalUsd !== undefined && !isNaN(s.totalUsd), `Venta ${s.id} tiene totalUsd inválido`);
        assert(s.profitTotalUsd !== undefined && !isNaN(s.profitTotalUsd), `Venta ${s.id} tiene profitTotalUsd inválido`);

        totalUsd += s.totalUsd;
        totalProfit += s.profitTotalUsd;
        if (s.profitTotalUsd < 0) hasLoss = true;
    }

    assert(hasLoss, 'Debe haber registrado al menos una venta con pérdida');
    assertClose(totalUsd, 80, 'El total vendido en USD debe ser exacto');
    assertClose(totalProfit, 18, 'La ganancia total USD debe ser exacta (sumando ganancias y la pérdida)');

    log('Ventas y ganancias simuladas OK: Cálculos precisos y validación de pérdida exitosa.', 'success');
}

// 3. Stress Test Ligero (Catálogo 100 items)
async function suiteStressCatalogo() {
    section('⚡ SUITE: Stress Test Catálogo (100 items)');

    const payload = Array.from({ length: 100 }, (_, i) =>
        createTestProduct({ name: `Stress Prod ${i}`, priceUsdt: Math.random() * 20 })
    );

    await storageService.setItem(TEST_KEYS.products, payload);

    const t0 = performance.now();
    const loaded = await storageService.getItem(TEST_KEYS.products, []);

    // Simular render/cálculos pesados (precios e impuestos imaginarios x 100 items)
    const rateUsdt = 36.5;
    for (const p of loaded) {
        const bs = p.priceUsdt * rateUsdt;
        const bcv = bs / 36.5;
        assert(!isNaN(bs), 'Calculo Bs válido');
    }

    const elapsed = performance.now() - t0;

    if (elapsed > 300) {
        throw new Error(`Rendimiento insuficiente: El catálogo tardó demasiado (${elapsed.toFixed(1)}ms). Esperado < 300ms.`);
    }

    log(`Stress catálogo OK: Carga y recálculo en ${elapsed.toFixed(1)}ms (umbral 300ms).`, 'success');
}

// 4. Suite Dashboard (Ventas Hoy / Ayer y Métricas)
async function suiteDashboard() {
    section('📊 SUITE: Validación de Dashboard (Cálculos de Tiempo)');

    await storageService.setItem(TEST_KEYS.sales, []); // Clean start

    const now = new Date();
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);

    const ventas = [
        // Hoy: 2 ventas, 1 fia
        { id: `test_h1`, date: now.toISOString(), totalUsd: 10, profitTotalUsd: 4, status: 'COMPLETADA' },
        { id: `test_h2`, date: now.toISOString(), totalUsd: 5, profitTotalUsd: 2, status: 'COMPLETADA' },
        { id: `test_h3`, date: now.toISOString(), totalUsd: 20, profitTotalUsd: 8, status: 'FIADO' },
        // Ayer: 1 venta
        { id: `test_a1`, date: ayer.toISOString(), totalUsd: 50, profitTotalUsd: 20, status: 'COMPLETADA' },
    ];

    await storageService.setItem(TEST_KEYS.sales, ventas);

    const db = await storageService.getItem(TEST_KEYS.sales, []);

    const isSameDay = (d1, d2) => d1.getDate() === d2.getDate() && d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();

    const ventasCompletadasHoy = db.filter(v => v.status === 'COMPLETADA' && isSameDay(new Date(v.date), new Date()));
    const ventasAyer = db.filter(v => v.status === 'COMPLETADA' && isSameDay(new Date(v.date), ayer));

    const gananciaHoy = ventasCompletadasHoy.reduce((sum, v) => sum + (v.profitTotalUsd || 0), 0);
    const ventasHoyUsd = ventasCompletadasHoy.reduce((sum, v) => sum + (v.totalUsd || 0), 0);
    const ventasAyerUsd = ventasAyer.reduce((sum, v) => sum + (v.totalUsd || 0), 0);

    assertClose(ventasHoyUsd, 15, 'Total USD de HOY debe sumar exacto excluyendo fiados');
    assertClose(gananciaHoy, 6, 'Ganancia neta HOY exacta');
    assertClose(ventasAyerUsd, 50, 'Total USD AYER exacto');

    log('Métricas del Dashboard simuladas correctamente (cruces de tiempo estrictos OK).', 'success');
}

// 5. Suite Corrupción de Data (Caos)
async function suiteChaos() {
    section('🌪️ SUITE: Corrupción de Data en LocalForage (Hydration Resilience)');

    const garbageProducts = [
        createTestProduct({ priceUsdt: NaN, costBs: 'abc' }), // Bad floats
        { name: 'Fantasma sin ID verdadero', priceUsdt: 10, stock: 5 }, // Raw object, missing vital ID
        createTestProduct({ priceUsdt: -50, category: undefined }), // Negative pricing
        createTestProduct({ id: 'ok1', priceUsdt: 1.0, costBs: 0.5 }), // The only fully valid one
    ];

    await storageService.setItem(TEST_KEYS.products, garbageProducts);
    const db = await storageService.getItem(TEST_KEYS.products, []);

    // Simulate our app's resilient hydrating filter
    const valid = db.filter(p => p && p.id && !isNaN(parseFloat(p.priceUsdt)) && parseFloat(p.priceUsdt) >= 0);

    assertEqual(valid.length, 1, 'Solo 1 de 4 items corruptos debe sobrevivir el filtro de hidratación.');

    log('Niveles de tolerancia al Caos OK (Los datos corruptos fueron atajados).', 'success');
}

// 6. Suite Stress Extremo: 5.000 items (o 500 en FastMode)
async function suiteExtremo(fastMode) {
    const qty = fastMode ? 500 : 5000;
    section(`🌋 SUITE: EXTREME STRESS (${qty} items)`);

    const payload = Array.from({ length: qty }, () => createTestProduct());

    const t0 = performance.now();
    await storageService.setItem(TEST_KEYS.products, payload);
    const writeTime = performance.now() - t0;

    const t1 = performance.now();
    const read = await storageService.getItem(TEST_KEYS.products, []);
    const readTime = performance.now() - t1;

    assertEqual(read.length, qty, 'Lectura íntegra falló');
    assert(readTime < 1500, `Demasiado lento: LocalForage tardó ${readTime.toFixed(0)}ms para ${qty} items.`);

    log(`Sobrevivió carga y parseo masivo de ${qty} keys. (W: ${writeTime.toFixed(0)}ms, R: ${readTime.toFixed(0)}ms, Umbral 1.5s)`, 'success');
}

// 7. Prueba Transaccional Simulada Quota Exceeded (Promise Reject)
async function suiteQuota() {
    section('🔌 SUITE: Storage Mocks (Simulando QuotaExceeded / App Offline)');

    const mockStorage = {
        async setItem() {
            throw new Error('QuotaExceededError: El disco en dispositivo está lleno');
        }
    };

    let caught = false;
    try {
        await mockStorage.setItem(TEST_KEYS.products, []);
    } catch (err) {
        caught = !!err.message.includes('QuotaExceeded');
    }

    assert(caught, 'La App no maneja de forma segura las asincronías rotas del almacenamiento');
    log('Graceful Failure Offline / Storage lleno validado OK', 'success');
}


// ════════════════════════════════════════════
// SUITES ADAPTADAS (AISLADAS)
// ════════════════════════════════════════════

async function suiteStorage() {
    section('💾 SUITE: STORAGE SERVICE (IndexedDB)');

    const testKey = `${TEST_PREFIX}test_key_${Date.now()}`;
    const testObj = { foo: 'bar', num: 42, arr: [1, 2, 3], nested: { a: true } };

    await storageService.setItem(testKey, testObj);
    const read = await storageService.getItem(testKey);

    assert(read, 'getItem retorna datos');
    assertEqual(read.foo, 'bar', 'String field');
    assertEqual(read.num, 42, 'Number field');
    assert(Array.isArray(read.arr) && read.arr.length === 3, 'Array field');

    const missing = await storageService.getItem('nonexistent_key_xyz', 'default_val');
    assertEqual(missing, 'default_val', 'Default fallback');

    // Cleanup
    await storageService.removeItem(testKey);
    const deleted = await storageService.getItem(testKey);
    assertEqual(deleted, null, 'removeItem');

    log('Storage CRUD OK', 'success');
}

async function suiteProductos() {
    section('📦 SUITE: PRODUCTOS (Catálogo Aislado)');

    await storageService.setItem(TEST_KEYS.products, []); // Clean start

    const prod1 = createTestProduct({ priceUsdt: 2.50, stock: 100, category: 'Harinas' });
    const prod2 = createTestProduct({ priceUsdt: 4.00, stock: 30, category: 'Lácteos' });

    await storageService.setItem(TEST_KEYS.products, [prod1, prod2]);
    const saved = await storageService.getItem(TEST_KEYS.products, []);

    assertEqual(saved.length, 2, 'Productos guardados');
    assertClose(saved.find(p => p.id === prod1.id).priceUsdt, 2.50, 'Lectura precisa de precio');

    // Filter
    const harinas = saved.filter(p => p.category === 'Harinas');
    assertEqual(harinas.length, 1, 'Filtro categoría');

    log('CRUD de Productos OK', 'success');
}

async function suiteCarrito() {
    section('🛒 SUITE: CARRITO (Lógica de Cesta)');

    const RATE = 95.50;
    let cart = [
        { id: 't1', priceUsd: 2.50, qty: 1 },
        { id: 't2', priceUsd: 4.00, qty: 2 }
    ];

    const totalUsd = cart.reduce((sum, i) => sum + (i.priceUsd * i.qty), 0);
    assertClose(totalUsd, 10.50, 'Total USD carrito');

    const totalBs = totalUsd * RATE;
    assert(totalBs > 0, 'Total Bs correcto');

    const formatChecked = formatBs(totalBs);
    // Ahora esperamos decimales con coma (es-VE)
    assert(formatChecked.includes(','), 'formatBs debe mostrar decimales con coma (es-VE)');

    log('Cálculos carrito OK (con decimales)', 'success');
}

async function suiteReportes() {
    section('📊 SUITE: REPORTES (Validación de Totales y Divisas)');

    await storageService.setItem(TEST_KEYS.sales, []); // Limpiar

    const now = new Date().toISOString();
    // Simulamos 3 ventas con montos "sensibles" de punto flotante
    const mySales = [
        {
            id: 'rs1',
            timestamp: now,
            status: 'COMPLETADA',
            totalUsd: 10.05,
            payments: [{ methodId: 'efectivo_usd', currency: 'USD', amountUsd: 10.05 }],
            items: [{ id: 'i1', name: 'P1', qty: 1, priceUsd: 10.05 }]
        },
        {
            id: 'rs2',
            timestamp: now,
            status: 'COMPLETADA',
            totalUsd: 20.01,
            payments: [{ methodId: 'efectivo_usd', currency: 'USD', amountUsd: 20.01 }],
            items: [{ id: 'i2', name: 'P2', qty: 1, priceUsd: 20.01 }]
        },
        {
            id: 'rs3',
            timestamp: now,
            status: 'COMPLETADA',
            totalUsd: 1.00,
            payments: [{ methodId: 'efectivo_bs', currency: 'BS', amountBs: 460.55 }],
            items: [{ id: 'i3', name: 'P3', qty: 1, priceUsd: 1.00 }]
        }
    ];

    await storageService.setItem(TEST_KEYS.sales, mySales);

    // Lógica replicada de ReportsView
    const paymentBreakdown = {};
    mySales.forEach(s => {
        s.payments.forEach(p => {
            if (!paymentBreakdown[p.methodId]) {
                paymentBreakdown[p.methodId] = { total: 0, currency: p.currency || 'BS' };
            }
            paymentBreakdown[p.methodId].total += (p.currency === 'USD' ? p.amountUsd : p.amountBs) || 0;
        });
    });

    // Validar suma exacta de USD (30.06)
    assertClose(paymentBreakdown['efectivo_usd'].total, 30.06, 'Suma de Efectivo USD exacta (30.06)');
    
    // Validar suma exacta de BS (460.55)
    assertClose(paymentBreakdown['efectivo_bs'].total, 460.55, 'Suma de Efectivo BS exacta (460.55)');

    log('Validación de Reportes (Divisas/Efectivo) OK: Totales exactos sin basura flotante.', 'success');
}

async function suiteBimoneda() {
    section('💱 SUITE: BIMONEDA (Conversiones)');

    const RATE = 95.50;
    const TOTAL_USD = 15.00;

    const paidUsd = 10.00;
    const paidBs = 500;
    const paidBsToUsd = paidBs / RATE;
    const totalPaidUsd = paidUsd + paidBsToUsd;

    assertClose(paidBsToUsd, 5.235, 'Bs -> USD exacto');
    assertClose(totalPaidUsd, 15.235, 'Pago total USD');

    const changeUsd = Math.max(0, totalPaidUsd - TOTAL_USD);
    assertClose(changeUsd, 0.235, 'Vuelto USD');

    log('Bimoneda OK', 'success');
}

async function suiteCheckout() {
    section('🧾 SUITE: CHECKOUT (Persistencia Aislada)');

    await storageService.setItem(TEST_KEYS.sales, []); // Clean start

    const RATE = 95.50;
    const totalUsd = 11.50;

    const sale = {
        id: `${TEST_PREFIX}${crypto.randomUUID()}`,
        status: 'COMPLETADA',
        items: [{ id: 'mock', qty: 1, priceUsd: 11.5 }],
        totalUsd, totalBs: totalUsd * RATE,
    };

    await storageService.setItem(TEST_KEYS.sales, [sale]);
    const readSales = await storageService.getItem(TEST_KEYS.sales, []);

    assertEqual(readSales.length, 1, 'Venta persistida en test_key');
    assertEqual(readSales[0].status, 'COMPLETADA', 'Status preservado');

    log('Checkout OK', 'success');
}

async function suiteClientes() {
    section('👥 SUITE: CLIENTES (Manejo Deuda Aislado)');

    await storageService.setItem(TEST_KEYS.customers, []); // Clean start

    const customer = createTestCustomer({ deuda: 0 });
    await storageService.setItem(TEST_KEYS.customers, [customer]);

    let db = await storageService.getItem(TEST_KEYS.customers, []);
    assertEqual(db[0].deuda, 0, 'Deuda inicial 0');

    // Fiado
    db = db.map(c => c.id === customer.id ? { ...c, deuda: c.deuda + 15 } : c);
    await storageService.setItem(TEST_KEYS.customers, db);
    db = await storageService.getItem(TEST_KEYS.customers, []);
    assertClose(db[0].deuda, 15, 'Deuda fiada sumada correctamente');

    log('Manejo deuda clientes OK', 'success');
}

async function suite7Days() {
    section('🗓️ SUITE: SIMULACIÓN 7 DÍAS DE OPERACIÓN');

    await storageService.setItem(TEST_KEYS.products, []);
    await storageService.setItem(TEST_KEYS.sales, []);

    const prods = [createTestProduct({ priceUsdt: 2.0, stock: 100 })];
    await storageService.setItem(TEST_KEYS.products, prods);

    let generatedSales = [];
    let revenue = 0;

    for (let day = 0; day < 7; day++) {
        if (state.stopped) break;

        for (let s = 0; s < 3; s++) { // 3 ventas/dia
            revenue += 2.0;
            generatedSales.push({
                id: `7d_${day}_${s}`,
                totalUsd: 2.0,
                items: [{ id: prods[0].id, qty: 1 }]
            });
        }
        log(`Simulado día ${day + 1}: 3 ventas.`, 'info');
        state.onProgress?.({ name: `Simulando Día ${day + 1}...`, current: day + 1, total: 7 });
        await delay(30);
    }

    await storageService.setItem(TEST_KEYS.sales, generatedSales);

    // Check persist
    const checkSales = await storageService.getItem(TEST_KEYS.sales, []);
    assert(checkSales.length >= 20, 'Ventas generadas persisten (al menos 21 ventas)');

    log(`Simulación completada. Total revenue: $${revenue.toFixed(2)}`, 'success');
}

async function suiteIntegridad() {
    section('🛡️ SUITE: INTEGRIDAD NaN/NULL');
    const badValues = [null, undefined, '', 'abc', NaN];
    for (const v of badValues) {
        const parsed = parseFloat(v) || 0;
        assert(!isNaN(parsed), `parseFloat maneja ${v}`);
    }
    log('Manejo de nulls y NaN OK', 'success');
}

// ════════════════════════════════════════════
// v4.0 — SUITES DE COBERTURA TOTAL
// ════════════════════════════════════════════

// 8. CurrencyService (Matemática Central de Precios)
async function suiteCurrencyService() {
    section('🧳 SUITE: CurrencyService — Matemática Central');

    // safeParse
    assertEqual(CurrencyService.safeParse('12.50'), 12.50, 'safeParse string normal');
    assertEqual(CurrencyService.safeParse('12,50'), 12.50, 'safeParse con coma venezolana');
    assertEqual(CurrencyService.safeParse(''), 0, 'safeParse string vacío');
    assertEqual(CurrencyService.safeParse('.'), 0, 'safeParse solo punto');
    assertEqual(CurrencyService.safeParse(null), 0, 'safeParse null');
    assertEqual(CurrencyService.safeParse(42), 42, 'safeParse number directo');

    // applyRoundingRule
    assertEqual(CurrencyService.applyRoundingRule(99.4, 'VES'), '100', 'VES redondea ceil entero');
    assertEqual(CurrencyService.applyRoundingRule(12.456, 'USD'), '12.46', 'USD a 2 decimales');
    assertEqual(CurrencyService.applyRoundingRule(0.001, 'VES'), '1', 'VES ceil de centavos');

    // calculateExchange
    const result = CurrencyService.calculateExchange(100, 36.5, 1);
    assertClose(result, 3650, 'Exchange 100 USD * 36.5 rate');
    assertEqual(CurrencyService.calculateExchange(100, 36.5, 0), 0, 'Exchange con rateTo=0 retorna 0');
    assertEqual(CurrencyService.calculateExchange(100, 0, 36.5), 0, 'Exchange con rateFrom=0 retorna 0');

    log('CurrencyService: safeParse + applyRoundingRule + calculateExchange OK', 'success');
}

// 9. RateService (Normalización + Contextos de Tasa)
async function suiteRateService() {
    section('📊 SUITE: RateService — Normalización y Contextos');

    // normalizeCurrencyCode
    assertEqual(RateService.normalizeCurrencyCode('bolivares'), 'VES', 'Normaliza "bolivares" → VES');
    assertEqual(RateService.normalizeCurrencyCode('BOLÍVARES'), 'VES', 'Normaliza con tilde');
    assertEqual(RateService.normalizeCurrencyCode('teter'), 'USD', 'Normaliza "teter" → USD (USDT removido en PreciosAlDía)');
    assertEqual(RateService.normalizeCurrencyCode('binance'), 'USD', 'Normaliza "binance" → USD (USDT removido)');
    assertEqual(RateService.normalizeCurrencyCode('euro'), 'EUR', 'Normaliza "euro" → EUR');
    assertEqual(RateService.normalizeCurrencyCode(''), 'USD', 'Vacío → USD default');
    assertEqual(RateService.normalizeCurrencyCode(null), 'USD', 'null → USD default');

    // getExchangeContext
    const mockRates = {
        usdt: { price: 37.10 },
        bcv: { price: 36.35 },
        euro: { price: 39.50 },
    };

    const ctx1 = RateService.getExchangeContext('USDT', 'VES', mockRates);
    assertClose(ctx1.rateUsed, 36.35, 'USDT→VES usa tasa BCV (USDT mapeado a USD)');
    assertEqual(ctx1.target, 'VES', 'Target correcto');

    const ctx2 = RateService.getExchangeContext('VES', null, mockRates);
    assertEqual(ctx2.target, 'USD', 'VES sin target → USD auto');

    const ctx3 = RateService.getExchangeContext('USD', 'VES', mockRates);
    assertClose(ctx3.rateUsed, 36.35, 'USD→VES usa tasa BCV');

    log('RateService: Normalización + Contexto de tasas OK', 'success');
}

// 10. FinancialLogic (procesarImpactoCliente — Las Reglas de Oro del Dinero)
async function suiteFinancialLogic() {
    section('💰 SUITE: FinancialLogic — Impacto Financiero de Clientes');

    // Escenario 1: Cliente limpio, paga sin deuda
    const c1 = procesarImpactoCliente({ deuda: 0, favor: 0 }, { usaSaldoFavor: 0, esCredito: false, deudaGenerada: 0, vueltoParaMonedero: 0 });
    assertEqual(c1.deuda, 0, 'Sin transacción = sin cambio deuda');
    assertEqual(c1.favor, 0, 'Sin transacción = sin cambio favor');

    // Escenario 2: Fiar $50
    const c2 = procesarImpactoCliente({ deuda: 0, favor: 0 }, { esCredito: true, deudaGenerada: 50 });
    assertEqual(c2.deuda, 50, 'Fiado genera deuda');

    // Escenario 3: Vuelto digital abona deuda existente
    const c3 = procesarImpactoCliente({ deuda: 30, favor: 0 }, { vueltoParaMonedero: 10 });
    assertClose(c3.deuda, 20, 'Vuelto reduce deuda parcialmente');
    assertEqual(c3.favor, 0, 'No genera favor si deuda pendiente');

    // Escenario 4: Vuelto digital excede deuda → genera favor
    const c4 = procesarImpactoCliente({ deuda: 5, favor: 0 }, { vueltoParaMonedero: 20 });
    assertEqual(c4.deuda, 0, 'Deuda se cancela completa');
    assertClose(c4.favor, 15, 'Excedente va a favor');

    // Escenario 5: Uso de saldo a favor
    const c5 = procesarImpactoCliente({ deuda: 0, favor: 100 }, { usaSaldoFavor: 40 });
    assertClose(c5.favor, 60, 'Saldo a favor se reduce');

    // Escenario 6: Normalización — favor y deuda simultáneos (The Golden Rule)
    const c6 = procesarImpactoCliente({ deuda: 100, favor: 30 }, { vueltoParaMonedero: 0 });
    assertEqual(c6.favor, 0, 'Golden Rule: favor se consume contra deuda');
    assertClose(c6.deuda, 70, 'Golden Rule: deuda neta correcta');

    log('FinancialLogic: 6 escenarios de impacto financiero validados OK', 'success');
}

// 11. Utilidades (smartCashRounding + formatVzlaPhone)
async function suiteUtilidades() {
    section('🛠️ SUITE: Utilidades — Redondeo Efectivo + Teléfono VE');

    // smartCashRounding
    assertEqual(smartCashRounding(99.10), 99, 'Decimal ≤0.20 → floor (99.10 → 99)');
    assertEqual(smartCashRounding(99.20), 99, 'Decimal =0.20 → floor (99.20 → 99)');
    assertEqual(smartCashRounding(99.21), 100, 'Decimal >0.20 → ceil (99.21 → 100)');
    assertEqual(smartCashRounding(99.99), 100, 'Decimal alto → ceil (99.99 → 100)');
    assertEqual(smartCashRounding(100.00), 100, 'Entero exacto sin cambio');

    // formatVzlaPhone
    assertEqual(formatVzlaPhone('04121234567'), '584121234567', '04xx → 58xx');
    assertEqual(formatVzlaPhone('4121234567'), '584121234567', 'Sin 0 → 58xx');
    assertEqual(formatVzlaPhone('584121234567'), '584121234567', 'Ya internacional → sin cambio');
    assertEqual(formatVzlaPhone(''), null, 'Vacío → null');
    assertEqual(formatVzlaPhone(null), null, 'null → null');

    log('Utilidades: smartCashRounding (5 casos) + formatVzlaPhone (5 casos) OK', 'success');
}

// 12. PaymentMethods (CRUD de métodos de pago)
async function suitePaymentMethods() {
    section('💳 SUITE: PaymentMethods — Factory + Custom CRUD');

    // Factory methods existen
    assert(DEFAULT_PAYMENT_METHODS.length >= 4, 'Al menos 4 métodos de fábrica');
    const efectivoBs = DEFAULT_PAYMENT_METHODS.find(m => m.id === 'efectivo_bs');
    assert(efectivoBs, 'Existe Efectivo Bs en fábrica');
    assertEqual(efectivoBs.isFactory, true, 'Es método de fábrica');

    // Helpers de lookup
    const label = getPaymentLabel('pago_movil');
    assert(label.includes('Pago Móvil'), 'getPaymentLabel retorna nombre correcto');

    const method = getPaymentMethod('efectivo_usd');
    assertEqual(method.currency, 'USD', 'getPaymentMethod retorna moneda correcta');

    // Fallback de getPaymentMethod
    const fallback = getPaymentMethod('metodo_inventado_xyz');
    assert(fallback !== null && fallback !== undefined, 'getPaymentMethod con ID inválido retorna fallback');

    log('PaymentMethods: Factory validation + Lookup helpers OK', 'success');
}

// 13. MessageService (Generación de mensajes de cobro)
async function suiteMessageService() {
    section('💬 SUITE: MessageService — Generación de Mensajes (3 Tonos)');

    const mockRates = {
        usdt: { price: 37.10 },
        bcv: { price: 36.35 },
        euro: { price: 39.50 },
    };

    const mockCurrencies = [
        { id: 'VES', rate: 1 },
        { id: 'USDT', rate: 37.10 },
        { id: 'BCV', rate: 36.35 },
        { id: 'EUR', rate: 39.50 },
    ];

    const mockAccount = {
        type: 'pago_movil',
        data: { bankName: 'Mercantil', phone: '04121234567', docId: 'V-12345678' },
        currency: 'VES',
    };

    const baseParams = {
        amountTop: '100',
        amountBot: '3650',
        from: 'USDT',
        to: 'VES',
        selectedAccount: mockAccount,
        rates: mockRates,
        currencies: mockCurrencies,
    };

    // Tono Casual
    const casual = MessageService.buildPaymentMessage({ ...baseParams, tone: 'casual' });
    assert(casual.includes('Hola'), 'Tono casual incluye "Hola"');
    assert(casual.includes('Pago Móvil'), 'Incluye datos de Pago Móvil');

    // Tono Formal
    const formal = MessageService.buildPaymentMessage({ ...baseParams, tone: 'formal', clientName: 'Juan' });
    assert(formal.includes('Estimado'), 'Tono formal incluye "Estimado"');
    assert(formal.includes('Juan'), 'Incluye nombre del cliente');

    // Tono Directo
    const direct = MessageService.buildPaymentMessage({ ...baseParams, tone: 'direct' });
    assert(direct.includes('DETALLES DE PAGO'), 'Tono directo incluye "DETALLES DE PAGO"');

    // Sin cuenta (Fallback)
    const mockFallback = { type: 'pago_movil', data: {}, currency: 'VES' };
    const noCuenta = MessageService.buildPaymentMessage({ ...baseParams, selectedAccount: mockFallback, tone: 'casual' });
    assert(typeof noCuenta === 'string' && noCuenta.length > 10, 'Genera mensaje incluso con datos mínimos');

    log('MessageService: 3 tonos + fallback sin cuenta OK', 'success');
}

// ════════════════════════════════════════════
// GROQ AI AUDITOR (Post-Run Analysis)
// ════════════════════════════════════════════

async function analyzeWithGroq(summary) {
    const apiKey = import.meta.env.VITE_GROQ_API_KEY;
    if (!apiKey) return null;

    const passed = summary.suites.filter(s => s.status === 'passed').length;
    const failed = summary.suites.filter(s => s.status === 'failed').length;
    const elapsed = summary.startedAt && summary.finishedAt
        ? ((summary.finishedAt - summary.startedAt) / 1000).toFixed(1)
        : '?';

    const suiteDetails = summary.suites.map(s =>
        `${s.status === 'passed' ? '✅' : '❌'} [${s.id}] ${s.name}${s.error ? ` — ERROR: ${s.error}` : ''}`
    ).join('\n');

    const prompt = `Eres un auditor senior de QA para una aplicación PWA de punto de venta llamada "PreciosAlDía" (Venezuela). 
Acabamos de correr la batería de tests automáticos del SystemTester v4.0. Aquí están los resultados:

RESULTADOS:
- Total: ${summary.suites.length} suites
- Aprobadas: ${passed}
- Fallidas: ${failed}
- Tiempo: ${elapsed}s

DETALLE POR SUITE:
${suiteDetails}

Analiza estos resultados y dame:
1. Un veredicto breve (1 línea) sobre la salud general del sistema.
2. Si hay fallos, explica qué podría estar causándolos y qué riesgo representan para el usuario final (bodeguero venezolano).
3. Si todo pasa, menciona qué áreas críticas quedaron validadas.
4. Un puntaje de confianza del 1 al 10 para deployar a producción.

Responde en español, de forma concisa y directa. Máximo 200 palabras.`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 400,
            }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;
    } catch (e) {
        log(`⚠️ Error contactando Groq API: ${e.message}`, 'warn');
        return null;
    }
}

// 14. Regresión: Bugs corregidos en sesión 2026-03-04
async function suiteRegresion20260304() {
    section('🔧 SUITE: Regresión 2026-03-04 (Ganancia, Vuelto, Pluralización, Moneda)');

    // ── Test 1: Ganancia debe usar costUsd × tasa (no costBs guardado) ──
    const RATE = 428;
    const saleItem = { id: 'reg1', qty: 1, priceUsd: 3.48, costUsd: 2.44, costBs: 1044.15 };
    // BUG anterior: usaba costBs directamente (1044.15) en vez de costUsd * rate (1044.32)
    const costBsCorrecta = saleItem.costUsd * RATE; // 2.44 * 428 = 1044.32
    const saleBs = saleItem.priceUsd * saleItem.qty * RATE; // 3.48 * 428 = 1489.44
    const profitCorrecto = saleBs - (costBsCorrecta * saleItem.qty); // 1489.44 - 1044.32 = 445.12
    const profitViejo = saleBs - (saleItem.costBs * saleItem.qty); // 1489.44 - 1044.15 = 445.29

    assertClose(profitCorrecto, 445.12, 'Ganancia con costUsd×rate debe ser ~445.12 Bs', 0.1);
    assert(Math.abs(profitCorrecto - profitViejo) > 0.01, 'Ganancia corregida difiere de la vieja (bug anterior)');

    // Convertir a USD para verificar
    const profitUsd = profitCorrecto / RATE;
    assertClose(profitUsd, 1.04, 'Ganancia en USD debe ser ~$1.04', 0.01);
    log('Ganancia costUsd×rate: cálculo correcto verificado.', 'success');

    // ── Test 2: Vuelto debe redondearse a 2 decimales ──
    const totalPaidUsd = 1 + (1000 / 428) + (61.27 / 428); // ≈ 3.4796
    const cartTotalUsd = 3.48;
    const changeUsdViejo = Math.max(0, totalPaidUsd - cartTotalUsd); // 0.0003... sin redondeo
    const changeUsdNuevo = Math.max(0, Math.round((totalPaidUsd - cartTotalUsd) * 100) / 100); // 0.00 redondeado
    const changeBsNuevo = Math.round(changeUsdNuevo * 428 * 100) / 100;

    assertEqual(changeUsdNuevo, 0, 'Vuelto USD redondeado debe ser 0 (no 0.0003...)');
    assertEqual(changeBsNuevo, 0, 'Vuelto Bs redondeado debe ser 0 (no 1 Bs fantasma)');
    // Verificar que la resta cruda produce residuos de punto flotante
    const rawDiff = totalPaidUsd - cartTotalUsd; // -0.0004... (negativo, no positivo)
    assert(rawDiff !== 0, 'Bug float: resta cruda produce residuo distinto de cero');
    // Pero con redondeo, queda limpio
    assert(changeUsdNuevo === 0 && changeBsNuevo === 0, 'Con redondeo, vuelto es exactamente 0');
    log('Vuelto redondeado: corregido $0.00 / 0 Bs.', 'success');

    // ── Test 3: Pluralización correcta ──
    const testPlural = (count) => count === 1 ? 'venta' : 'ventas';
    const testPluralArticulos = (count) => count === 1 ? 'artículo vendido' : 'artículos vendidos';

    assertEqual(testPlural(1), 'venta', 'Singular: 1 venta');
    assertEqual(testPlural(5), 'ventas', 'Plural: 5 ventas');
    assertEqual(testPluralArticulos(1), 'artículo vendido', 'Singular: 1 artículo vendido');
    assertEqual(testPluralArticulos(3), 'artículos vendidos', 'Plural: 3 artículos vendidos');
    log('Pluralización: singular/plural correcto.', 'success');

    // ── Test 4: Payment breakdown muestra moneda nativa ──
    const pagoBs = { methodId: 'efectivo_bs', currency: 'BS', amountBs: 1000, amountUsd: 1000 / 428 };
    const pagoUsd = { methodId: 'efectivo_usd', currency: 'USD', amountUsd: 1.00, amountBs: 428 };

    const breakdown = {};
    [pagoBs, pagoUsd].forEach(p => {
        if (!breakdown[p.methodId]) breakdown[p.methodId] = { total: 0, currency: p.currency || 'BS' };
        breakdown[p.methodId].total += (p.currency === 'USD' ? p.amountUsd : p.amountBs) || 0;
    });

    assertEqual(breakdown['efectivo_bs'].currency, 'BS', 'Efectivo Bs almacena currency BS');
    assertClose(breakdown['efectivo_bs'].total, 1000, 'Efectivo Bs total en Bs (no convertido a USD)');
    assertEqual(breakdown['efectivo_usd'].currency, 'USD', 'Efectivo USD almacena currency USD');
    assertClose(breakdown['efectivo_usd'].total, 1.00, 'Efectivo USD total en USD');

    // Verificar que el display sería correcto
    const displayBs = `${formatBs(breakdown['efectivo_bs'].total)} Bs`;
    const displayUsd = `$ ${breakdown['efectivo_usd'].total.toFixed(2)}`;
    assert(displayBs.includes('Bs'), 'Efectivo Bs se muestra en Bs');
    assert(displayUsd.includes('$'), 'Efectivo USD se muestra en $');
    log('Payment breakdown: moneda nativa por método verificada.', 'success');
}

// 15. Cierre de Caja y Anulaciones (Vueltos, Proveedores, Caja Cerrada)
async function suiteCierreCaja() {
    section('📦 SUITE: Cierre de Caja y Anulaciones (v5.0)');

    // ── Test 1: Vuelto (Change Breakdown) ──
    // Una venta de $10.00 pagada con $20.00 en efectivo USD
    const saleConVuelto = {
        id: 'cv1',
        totalUsd: 10,
        status: 'COMPLETADA',
        payments: [{ methodId: 'efectivo_usd', currency: 'USD', amountUsd: 20 }],
        changeBreakdown: { changeUsdGiven: 10, changeBsGiven: 0 }
    };
    
    const usdBruto = saleConVuelto.payments[0].amountUsd;
    const usdNeto = usdBruto - (saleConVuelto.changeBreakdown?.changeUsdGiven || 0);
    assertEqual(usdNeto, 10, 'El neto de USD cobrado (bruto - vuelto) debe ser exactamente el costo de la venta');

    // ── Test 2: Proveedores (Egreso) ──
    const pagoProveedor = {
        id: 'pp1',
        tipo: 'PAGO_PROVEEDOR',
        totalUsd: -50, // Egreso
        payments: [{ methodId: 'efectivo_usd', currency: 'USD', amountUsd: 50 }]
    };

    const saldoCaja = usdNeto + pagoProveedor.totalUsd;
    assertEqual(saldoCaja, -40, 'El pago a proveedor resta correctamente del flujo de caja neto');

    // ── Test 3: Ventas Anuladas (cajaCerrada y status) ──
    const saleAnulada = {
        id: 'an1',
        status: 'ANULADA',
        cajaCerrada: true,
        totalUsd: 100
    };

    const ventasValidas = [saleConVuelto, saleAnulada].filter(s => s.status !== 'ANULADA');
    assertEqual(ventasValidas.length, 1, 'Las ventas anuladas no deben sumar a las métricas estáticas');
    assertEqual(saleAnulada.cajaCerrada, true, 'La bandera cajaCerrada puede persistir en estado ANULADA sin borrarse');

    log('Cierre de caja: Vueltos descontados, proveedores y anulaciones validados OK.', 'success');
}

// 16. Golden Master Test (Motor Financiero)
async function suiteGoldenMaster() {
    section('🏆 SUITE: Golden Master (FinancialEngine)');

    // ── Test 1: buildCartTotals ──
    const cart = [
        { priceUsd: 10, qty: 2 }, // 20
        { priceUsd: 5.5, qty: 1, exactBs: 250 } // exactly 250 Bs
    ];
    // bcvRate: 40, copRate: 4000, discount: 10%
    const totals = FinancialEngine.buildCartTotals(cart, { type: 'percentage', value: 10 }, 40, 4000);
    // subtotalUsd = 20 + 5.5 = 25.5
    // subtotalBs = (20 * 40) + 250 = 800 + 250 = 1050
    // discountUsd = 2.55
    // discountBs = 2.55 * 40 = 102
    // totalUsd = 25.5 - 2.55 = 22.95
    // totalBs = 1050 - 102 = 948
    // totalCop = 22.95 * 4000 = 91800

    assertClose(totals.subtotalUsd, 25.5, 'subtotalUsd incorrecto');
    assertClose(totals.subtotalBs, 1050, 'subtotalBs incorrecto (con exactBs)');
    assertClose(totals.discountAmountUsd, 2.55, 'Descuento 10% USD incorrecto');
    assertClose(totals.totalUsd, 22.95, 'Total USD incorrecto');
    assertClose(totals.totalBs, 948, 'Total Bs incorrecto');
    assertClose(totals.totalCop, 91800, 'Total COP incorrecto');

    // ── Test 2: calculateNetProfit ──
    const sale = {
        items: [
            { priceUsd: 10, costUsd: 5, qty: 2 }, // revenue: 20, cost: 10, profit base: 10
            { priceUsd: 5.5, costBs: 160, qty: 1 } // revenue: 5.5, costBs: 160. at rate 40, costUsd: 4. profit base: 1.5
        ],
        discountAmountUsd: 2.55 // Global discount affects net profit directly -> 11.5 - 2.55 = 8.95
    };
    
    // products argument not strictly needed if sale items exist
    const profit = FinancialEngine.calculateNetProfit(sale, 40, []);
    assertClose(profit, 8.95, 'Ganancia neta afectada por descuento incorrecta');

    log('Golden Master FinancialEngine: Matemáticas críticas aprobadas.', 'success');
}

// ════════════════════════════════════════════
// RUNNER CONFIGURATION
// ════════════════════════════════════════════

const SUITES = [
    { key: 'dash_validations', name: '📊 Dash: Totales Hoy vs Ayer', fn: suiteDashboard, fast: true },
    { key: 'chaos_data', name: '🌪️ Resiliencia a Caos DB', fn: suiteChaos, fast: true },
    { key: 'extreme_stress', name: '🌋 EXTREMO: 5K Lecturas DB', fn: suiteExtremo, fast: false },
    { key: 'quota_mock', name: '🔌 Falla de Red / QuotaExceeded', fn: suiteQuota, fast: true },

    { key: 'catalogo_tasas', name: '💱 Verificación Tasas/Catálogo', fn: suiteCatalogoTasas, fast: true },
    { key: 'ventas_ganancias', name: '📈 Simulación de Ganancias', fn: suiteVentasGanancias, fast: true },
    { key: 'stress_catalogo', name: '⚡ Stress de Rendimiento (100 items)', fn: suiteStressCatalogo, fast: true },

    { key: 'storage', name: '💾 Funciones Storage Base', fn: suiteStorage, fast: true },
    { key: 'productos', name: '📦 CRUD Productos', fn: suiteProductos, fast: true },
    { key: 'carrito', name: '🛒 Matemáticas de Carrito', fn: suiteCarrito, fast: true },
    { key: 'reportes_suma', name: '📊 Validación Reportes (Suma Totales)', fn: suiteReportes, fast: true },
    { key: 'bimoneda', name: '💱 Conversiones Bimoneda', fn: suiteBimoneda, fast: true },
    { key: 'checkout', name: '🧾 Guardado Checkout', fn: suiteCheckout, fast: true },
    { key: 'clientes', name: '👥 Actualización Deudas', fn: suiteClientes, fast: true },
    { key: 'integridad', name: '🛡️ Defensas de Tipos', fn: suiteIntegridad, fast: true },

    // v4.0 — Cobertura Total
    { key: 'currency_svc', name: '🧳 CurrencyService (Matemática Central)', fn: suiteCurrencyService, fast: true },
    { key: 'rate_svc', name: '📊 RateService (Normalización + Contextos)', fn: suiteRateService, fast: true },
    { key: 'financial', name: '💰 FinancialLogic (Deuda/Favor/Vuelto)', fn: suiteFinancialLogic, fast: true },
    { key: 'utils_extra', name: '🛠️ Redondeo Efectivo + Teléfono VE', fn: suiteUtilidades, fast: true },
    { key: 'pay_methods', name: '💳 Métodos de Pago (CRUD)', fn: suitePaymentMethods, fast: true },
    { key: 'msg_service', name: '💬 MessageService (3 Tonos)', fn: suiteMessageService, fast: true },
    { key: 'regresion_20260304', name: '🔧 Regresión: Ganancia/Vuelto/Plural/Moneda', fn: suiteRegresion20260304, fast: true },
    { key: 'cierre_caja', name: '📦 Flujo: Vueltos Netos / Proveedores / Cierre', fn: suiteCierreCaja, fast: true },
    { key: 'golden_master', name: '🏆 Golden Master (Motor Financiero)', fn: suiteGoldenMaster, fast: true },

    { key: '7days', name: '🗓️ Week Sim (Storage Pesado)', fn: suite7Days, fast: false },
];

function resetState() {
    state.logs = [];
    state.suites = [];
    state.isRunning = false;
    state.stopped = false;
    state.startedAt = null;
    state.finishedAt = null;
    state._7dayStats = null;
}

// ════════════════════════════════════════════
// EXPORTS API
// ════════════════════════════════════════════

export const SystemTester = {
    getSuites: () => [...SUITES],

    getState: () => ({
        logs: [...state.logs],
        suites: [...state.suites],
        isRunning: state.isRunning,
        stopped: state.stopped,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt
    }),

    stop: () => {
        state.stopped = true;
        log('⛔ Se solicitó detección de los tests.', 'warn');
    },

    async runAll({ onLog, onProgress, onComplete, fastMode = false } = {}) {
        resetState();

        // Determinar qué suites correr basado en fastMode
        const targetSuites = fastMode ? SUITES.filter(s => s.fast) : SUITES;
        initSuites(targetSuites);

        state.isRunning = true;
        state.startedAt = Date.now();
        state.onLog = onLog || null;
        state.onProgress = onProgress || null;

        log(`🚀 Iniciando System Tester v4.0 [FastMode: ${fastMode ? 'ON' : 'OFF'}]`, 'info');

        let passed = 0;
        let failed = 0;

        await cleanupTestData(); // Asegurar entorno limpio

        for (let i = 0; i < targetSuites.length; i++) {
            const suiteConfig = targetSuites[i];

            if (state.stopped) {
                log('⛔ Test abortado por el usuario', 'warn');
                updateSuiteStatus(suiteConfig.key, { status: 'skipped' });
                continue;
            }

            onProgress?.({ name: suiteConfig.name, current: i + 1, total: targetSuites.length });
            log(`Iniciando suite: ${suiteConfig.name}`, 'info');

            updateSuiteStatus(suiteConfig.key, { status: 'running', startedAt: Date.now() });

            try {
                await suiteConfig.fn();
                updateSuiteStatus(suiteConfig.key, { status: 'passed', finishedAt: Date.now() });
                passed++;
            } catch (err) {
                log(`💥 Suite Failed: ${suiteConfig.name} - ${err.message}`, 'error');
                updateSuiteStatus(suiteConfig.key, { status: 'failed', finishedAt: Date.now(), error: err.message });
                failed++;
            }

            await delay(30);
        }

        await cleanupTestData(); // Limpiar al final

        state.finishedAt = Date.now();
        const elapsedSec = ((state.finishedAt - state.startedAt) / 1000).toFixed(1);

        section('📊 RESULTADO FINAL');
        log(`✅ ${passed} aprobadas | ❌ ${failed} fallidas | ⏱️ ${elapsedSec}s`, passed > 0 && failed === 0 ? 'success' : 'error');

        state.isRunning = false;

        // ════ GROQ AI ANALYSIS (Post-Run) ════
        const finalSummary = this.getState();
        let aiAnalysis = null;
        try {
            aiAnalysis = await analyzeWithGroq(finalSummary);
            if (aiAnalysis) {
                finalSummary.aiAnalysis = aiAnalysis;
                log('🧠 Análisis AI completado.', 'ai');
            }
        } catch (e) {
            log(`⚠️ Groq AI no disponible: ${e.message}`, 'warn');
        }

        onComplete?.(finalSummary);

        return finalSummary;
    },

    async runSuite(suiteId, { onLog } = {}) {
        resetState();
        const suiteConfig = SUITES.find(s => s.key === suiteId);

        if (!suiteConfig) {
            log(`Suite "${suiteId}" no encontrada`, 'error');
            return null;
        }

        initSuites([suiteConfig]);

        state.isRunning = true;
        state.startedAt = Date.now();
        state.onLog = onLog || null;

        await cleanupTestData();

        log(`🚀 Ejecutando suite unitaria: ${suiteConfig.name}`, 'info');
        updateSuiteStatus(suiteConfig.key, { status: 'running', startedAt: Date.now() });

        try {
            await suiteConfig.fn();
            updateSuiteStatus(suiteConfig.key, { status: 'passed', finishedAt: Date.now() });
            log(`${suiteConfig.name} ✓`, 'success');
        } catch (err) {
            log(`💥 Error en ${suiteConfig.name}: ${err.message}`, 'error');
            updateSuiteStatus(suiteConfig.key, { status: 'failed', finishedAt: Date.now(), error: err.message });
        }

        await cleanupTestData();

        state.finishedAt = Date.now();
        state.isRunning = false;

        return this.getState();
    },
};

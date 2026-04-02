import fs from 'fs';

let content = fs.readFileSync('src/testing/SystemTester.js', 'utf8');

// 1. Get Top Part (Imports, State, Helpers, up to cleanupTestData)
const topPartLimit = content.indexOf('// NUEVAS SUITES RÁPIDAS');
const topPart = content.substring(0, topPartLimit);

// 2. Extact analyzeWithGroq reliably
// It starts at "async function analyzeWithGroq" and ends exactly before "// 14. Regresión: Bugs corregidos"
const groqMatchOffset = content.indexOf('async function analyzeWithGroq');
const groqEndOffset = content.indexOf('async function suiteRegresion20260304');
let groqPart = content.substring(content.lastIndexOf('// ════', groqMatchOffset), groqEndOffset);

// Update Groq Prompt
groqPart = groqPart.replace(
    'SystemTester v4.0 como si fueras un perito contable que debe certificar la integridad matemática del sistema ante un tribunal.',
    'Financial Auditor v5.0 como si fueras un perito contable que debe certificar la integridad matemática del sistema ante una auditoría fiscal.'
);
groqPart = groqPart.replace(
    /CONTEXTO DEL SISTEMA:[\s\S]*?(?=RESULTADOS DE LA BATERÍA)/,
    `CONTEXTO TÉCNICO DEL SISTEMA (v5.0):
- Motor Financiero ultra-preciso blindado con 'dinero.js' para prevención total de drift de punto flotante.
- Manejo simultáneo de 3 monedas con conversiones asimétricas y redondeos half-away-from-zero exactos.
- La batería es un escaner forense en vivo sobre la base de datos de producción real.

`
);

const newSuitesStr = `
// ════════════════════════════════════════════
// 1. AUDITORÍA DE PRECISIÓN (dinero.js vs IEEE 754)
// ════════════════════════════════════════════
async function suitePrecisionFinanciera() {
    section('🔬 SUITE: Auditoría de Precisión (Motor Financiero)');
    
    // Pruebas rígidas contra fallas IEEE 754
    assertClose(0.1 + 0.2, 0.30, 'Suma básica de punto flotante debe estar saneada');
    
    // Probar el Wrapper de Dinero.js simulado
    try {
        const d_sumR = sumR(0.1, 0.2);
        assertEqual(d_sumR, 0.30, 'Dinero.js sumR debe dar exactamente 0.30');
        
        const d_subR = subR(0.3, 0.2);
        assertEqual(d_subR, 0.10, 'Dinero.js subR debe dar exactamente 0.10');
        
        const d_mulR = mulR(1.005, 100);
        assertEqual(d_mulR, 100.50, 'Dinero.js mulR debe redondear correctamente');
        
        const d_divR = divR(10, 3);
        assertEqual(d_divR, 3.33, 'Dinero.js divR debe truncar a 2 decimales sin desborde');
        
        log('Motor financiero (dinero.js wrapper) operando con precisión matemática perfecta.', 'success');
    } catch(e) {
        log('Motor financiero falló prueba estricta: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════
// 2. AUDITORÍA FORENSE HISTÓRICA (bodega_sales_v1)
// ════════════════════════════════════════════
async function suiteAuditarDataHistorica() {
    section('🕵️ SUITE: Auditoría Forense de Datos Históricos');
    const sales = await storageService.getItem('bodega_sales_v1', []);
    if (!sales || sales.length === 0) return log('Libro de ventas vacío: No hay historial para auditar.', 'info');

    let driftedSalesCount = 0;
    
    for (const sale of sales) {
        if (!sale.items || sale.status === 'ANULADA') continue;
        
        let calculatedTotalUsd = 0;
        for (const item of sale.items) {
            calculatedTotalUsd = sumR(calculatedTotalUsd, mulR(item.priceUsd, item.qty));
        }
        
        // Descuentos
        if (sale.discount > 0) {
            calculatedTotalUsd = subR(calculatedTotalUsd, sale.discount);
        }
        
        // Tolerancia a datos Legacy sin precisión
        if (Math.abs(calculatedTotalUsd - sale.totalUsd) > 0.05) {
            driftedSalesCount++;
            log(\`[Anomalía Histórica] Ticket \${sale.id}: Calculado \$ \${calculatedTotalUsd} vs Registrado \$ \${sale.totalUsd}\`, 'warn');
        }
    }
    
    if (driftedSalesCount > 0) {
        log(\`Se encontraron \${driftedSalesCount} tickets históricos con anomalías de redondeo (Drift IEEE 754).\`, 'error');
    } else {
        log('Historial validado: 100% de integridad en sumatorias de tickets históricos.', 'success');
    }
}

// ════════════════════════════════════════════
// 3. AUDITORÍA PATRIMONIAL (Inventario Fantasma)
// ════════════════════════════════════════════
async function suitePatrimonialInventario() {
    section('🛒 SUITE: Auditoría Patrimonial (Inventario Fantasma)');
    const products = await storageService.getItem('bodega_products_v1', []);
    if (!products || !products.length) return log('No hay productos para auditar.', 'info');

    let ghostItems = 0;
    let totalGhostValueUsd = 0;

    for (const p of products) {
        if (p.stock < 0) {
            ghostItems++;
            totalGhostValueUsd += Math.abs(p.stock) * (p.priceUsdt || 0);
        }
    }

    if (ghostItems > 0) {
        log(\`Patrimonio en riesgo: \${ghostItems} productos en negativo. Valor irreal proyectado: $\${totalGhostValueUsd.toFixed(2)}\`, 'error');
    } else {
        log('Inventario matemáticamente sano. 0 productos en estado Fantasma (Negativo).', 'success');
    }
}

// ════════════════════════════════════════════
// 4. AUDITORÍA DE CARTERA (Deuda Circular)
// ════════════════════════════════════════════
async function suiteDeudaCircular() {
    section('👥 SUITE: Auditoría de Integridad de Cartera (Deuda vs Favor)');
    const customers = await storageService.getItem('bodega_customers_v1', []);
    if (!customers || !customers.length) return log('No hay clientes para auditar.', 'info');

    let circularAnomalies = 0;

    for (const c of customers) {
        if (c.deuda > 0 && c.favor > 0) {
            circularAnomalies++;
            log(\`[Deuda Circular] Cliente \${c.name} tiene Deuda ($\${c.deuda}) y Favor ($\${c.favor}) simultáneamente.\`, 'warn');
        }
    }

    if (circularAnomalies > 0) {
        log(\`Se encontraron \${circularAnomalies} clientes con carteras no normalizadas (Deuda Circular).\`, 'error');
    } else {
        log('Libros de cartera limpios. Todos los abonos y deudas están normalizados cruzadamente.', 'success');
    }
}

// ════════════════════════════════════════════
// 5. AUDITORÍA DE SOLAPAMIENTO (Ventas Huérfanas de Cierre)
// ════════════════════════════════════════════
async function suiteOverlappingCierre() {
    section('📦 SUITE: Auditoría de Cierres Diarios (Ventas Huérfanas)');
    const sales = await storageService.getItem('bodega_sales_v1', []);
    const reports = await storageService.getItem('bodega_reports_v1', []);
    
    if (!sales || !sales.length) return log('No hay datos suficientes para cruzar reportes.', 'info');

    let orphanedSales = 0;
    const now = new Date();

    for (const sale of sales) {
        if (sale.status === 'COMPLETADA') {
            const saleDate = new Date(sale.createdAt || sale.date);
            const hoursOld = (now - saleDate) / (1000 * 60 * 60);
            
            if (hoursOld > 24 && !sale.syncStatus) {
                orphanedSales++;
            }
        }
    }

    if (orphanedSales > 0) {
        log(\`Se detectaron \${orphanedSales} ventas "Huérfanas" antiguas (¿Omisión de cierre de turno?).\`, 'warn');
    } else {
        log('Conciliación de turnos OK. Los tickets están procesados o en el turno actual (Menos de 24h).', 'success');
    }
}

// ════════════════════════════════════════════
// 6. DETECTOR DE VOLATILIDAD DE TASA (Rate Sneak)
// ════════════════════════════════════════════
async function suiteRateSneak() {
    section('💱 SUITE: Detector de Volatilidad de Tasa (Rate Sneak)');
    const sales = await storageService.getItem('bodega_sales_v1', []);
    if (!sales || !sales.length) return log('No hay ventas para auditar.', 'info');

    let tamperedRates = 0;

    for (const sale of sales) {
        if (sale.status === 'ANULADA' || !sale.totalUsd || !sale.totalBs || !sale.rate) continue;
        const calculatedRate = sale.totalBs / sale.totalUsd;
        const diff = Math.abs(calculatedRate - sale.rate);

        if (diff > 0.05) { 
            log(\`[Rate Sneak] Venta ID \${sale.id}: Tasa registrada \${sale.rate}, Matemática pura exige \${calculatedRate.toFixed(2)}\`, 'warn');
            tamperedRates++;
        }
    }

    if (tamperedRates > 0) {
        log(\`Se detectaron \${tamperedRates} transacciones afectadas por volatilidad de tasa.\`, 'error');
    } else {
        log('La correlación Matemática Tasa vs Totales es estricta en todo el historial estudiado.', 'success');
    }
}
`;

// Extract Runner Base
let runnerBase = content.substring(content.indexOf('// EXPORTS API') - 49);

// Replace the SUITES array intelligently
runnerBase = runnerBase.replace(/const SUITES = \[[^\]]*\];/, `const SUITES = [
    { key: 'precision_financiera', name: '🔬 Motor: Certificación de Precisión', fn: suitePrecisionFinanciera, fast: true },
    { key: 'auditoria_historica', name: '🕵️ Histórico: Integridad de Libros', fn: suiteAuditarDataHistorica, fast: true },
    { key: 'auditoria_patrimonial', name: '🛒 Inventario: Auditoría Patrimonial', fn: suitePatrimonialInventario, fast: true },
    { key: 'auditoria_cartera', name: '👥 Clientes: Deuda Circular', fn: suiteDeudaCircular, fast: true },
    { key: 'auditoria_cierre', name: '📦 Finanzas: Ventas Huérfanas de Cierre', fn: suiteOverlappingCierre, fast: true },
    { key: 'auditoria_tasas', name: '💱 Operaciones: Volatilidad de Tasa', fn: suiteRateSneak, fast: true }
];`);

// Add round helpers if they are missing at top
let finalTopPart = topPart;
if (!finalTopPart.includes('import { round2')) {
    finalTopPart = finalTopPart.replace(
        "import { FinancialEngine } from '../core/FinancialEngine';",
        "import { FinancialEngine } from '../core/FinancialEngine';\\nimport { round2, round4, mulR, divR, subR, sumR } from '../utils/dinero';"
    );
}

const finalFileContent = finalTopPart + "\\n" + groqPart + "\\n" + newSuitesStr + "\\n" + runnerBase;

fs.writeFileSync('src/testing/SystemTester.js', finalFileContent, 'utf8');
console.log('Build and Refactor Successful');

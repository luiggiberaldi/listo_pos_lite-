import { jsPDF } from 'jspdf';
import { formatBs, formatUsd } from './calculatorUtils';

/**
 * Genera un ticket PDF estilo recibo térmico 80mm.
 * Cada dato ocupa su propia línea — nada se solapa.
 */
export async function generateTicketPDF(sale, bcvRate) {
    const WIDTH = 80;
    const M = 6;
    const CX = WIDTH / 2;
    const RIGHT = WIDTH - M;

    const rate = sale.rate || bcvRate || 1;
    const itemCount = sale.items?.length || 0;
    const paymentCount = sale.payments?.length || 0;
    const hasFiado = sale.fiadoUsd > 0;

    // Altura MUY generosa para que nunca se corte
    const H = 160 + (itemCount * 14) + (paymentCount * 7) + (hasFiado ? 18 : 0);

    const doc = new jsPDF({ unit: 'mm', format: [WIDTH, H] });

    // Paleta
    const INK = [33, 37, 41];
    const BODY = [73, 80, 87];
    const MUTED = [134, 142, 150];
    const GREEN = [16, 124, 65];
    const RULE = [206, 212, 218];
    const RED = [220, 53, 69];

    let y = 8;

    // ── Helper: línea punteada ──
    const dash = (yy) => {
        doc.setDrawColor(...RULE);
        doc.setLineWidth(0.3);
        doc.setLineDashPattern([1, 1], 0);
        doc.line(M, yy, RIGHT, yy);
        doc.setLineDashPattern([], 0);
    };

    // ════════════════════════════════════
    //  LOGO
    // ════════════════════════════════════
    try {
        const img = new Image();
        img.src = '/logo.png';
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        const logoW = 50;
        const logoH = 12; // ~4:1 aspect ratio matching original
        doc.addImage(img, 'PNG', CX - logoW / 2, y, logoW, logoH);
        y += logoH + 4;
    } catch (_) { y += 2; }

    dash(y); y += 5;

    // ════════════════════════════════════
    //  INFO DEL TICKET (cada dato en su línea)
    // ════════════════════════════════════
    const saleNum = String(sale.saleNumber || 0).padStart(7, '0');
    const d = new Date(sale.timestamp);
    const fecha = d.toLocaleDateString('es-VE');
    const hora = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...INK);
    doc.text('N°:', M, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`#${saleNum}`, M + 8, y);
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(`${fecha}  ${hora}`, RIGHT, y, { align: 'right' });
    y += 5;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...INK);
    doc.text('Cliente:', M, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...BODY);
    doc.text(sale.customerName || 'Consumidor Final', M + 14, y);
    y += 6;

    if (sale.customerDocument) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(...INK);
        doc.text('C.I/RIF:', M, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...BODY);
        doc.text(sale.customerDocument, M + 14, y);
        y += 6;
    }

    dash(y); y += 5;

    // ════════════════════════════════════
    //  ENCABEZADO DE PRODUCTOS
    // ════════════════════════════════════
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text('CANT', M, y);
    doc.text('DESCRIPCIÓN', M + 10, y);
    doc.text('IMPORTE', RIGHT, y, { align: 'right' });
    y += 5;

    // ════════════════════════════════════
    //  PRODUCTOS
    // ════════════════════════════════════
    if (sale.items && sale.items.length > 0) {
        sale.items.forEach(item => {
            const qty = item.isWeight ? item.qty.toFixed(2) : String(item.qty);
            const unit = item.isWeight ? 'Kg' : 'u';
            const sub = item.priceUsd * item.qty;
            const subBs = sub * rate;
            const name = item.name.length > 20 ? item.name.substring(0, 20) + '…' : item.name;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(...INK);
            doc.text(`${qty}${unit}`, M, y);
            doc.text(name, M + 10, y);
            doc.setFont('helvetica', 'bold');
            doc.text('$' + sub.toFixed(2), RIGHT, y, { align: 'right' });
            y += 4;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(6);
            doc.setTextColor(...MUTED);
            doc.text('$' + item.priceUsd.toFixed(2) + ' c/u  ·  Bs ' + formatBs(subBs), M + 10, y);
            y += 6;
        });
    }

    y += 2;
    dash(y); y += 7;

    // ════════════════════════════════════
    //  TASA DE CAMBIO (centrada, sola)
    // ════════════════════════════════════
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Tasa BCV: Bs ' + formatBs(rate) + ' por $1', CX, y, { align: 'center' });
    y += 5;
    if (sale.tasaCop > 0) {
        doc.text('Tasa COP: ' + sale.tasaCop.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' por $1', CX, y, { align: 'center' });
        y += 5;
    }
    y += 3;

    // ════════════════════════════════════
    //  TOTAL (cada cosa en su propia línea, centrado)
    // ════════════════════════════════════
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    
    if (sale.discountAmountUsd > 0) {
        doc.setTextColor(...BODY);
        doc.text('SUBTOTAL:', M, y);
        doc.text('$' + (sale.cartSubtotalUsd?.toFixed(2) || (sale.totalUsd + sale.discountAmountUsd).toFixed(2)), RIGHT, y, { align: 'right' });
        y += 5;
        doc.setTextColor(...RED);
        const discountLabel = sale.discountType === 'percentage' ? `DESCUENTO (${sale.discountValue}%):` : 'DESCUENTO:';
        doc.text(discountLabel, M, y);
        doc.text('-$' + sale.discountAmountUsd.toFixed(2), RIGHT, y, { align: 'right' });
        y += 7;
    }

    doc.setTextColor(...BODY);
    doc.text('TOTAL A PAGAR', CX, y, { align: 'center' });
    y += 8;

    // Monto USD — GRANDE
    doc.setFontSize(20);
    doc.setTextColor(...GREEN);
    const totalUsdStr = '$' + parseFloat(sale.totalUsd || 0).toFixed(2);
    doc.text(totalUsdStr, CX, y, { align: 'center' });
    y += 8;

    // Monto Bs — debajo
    doc.setFontSize(10);
    doc.setTextColor(...BODY);
    const totalBsStr = 'Bs ' + formatBs(sale.totalBs || 0);
    doc.text(totalBsStr, CX, y, { align: 'center' });
    y += 6;

    // Monto COP
    if (sale.copEnabled && sale.tasaCop > 0) {
        doc.setFontSize(10);
        doc.setTextColor(...BODY);
        const totalCopStr = 'COP ' + (sale.totalCop || (sale.totalUsd * sale.tasaCop)).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        doc.text(totalCopStr, CX, y, { align: 'center' });
        y += 8;
    } else {
        y += 2;
    }

    dash(y); y += 7;

    // ════════════════════════════════════
    //  PAGOS REALIZADOS
    // ════════════════════════════════════
    const showPayments = (sale.payments && sale.payments.length > 0) || hasFiado;
    if (showPayments) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(...MUTED);
        doc.text('PAGOS REALIZADOS', M, y);
        y += 5;

        if (sale.payments && sale.payments.length > 0) {
            sale.payments.forEach(p => {
                const isCop = p.currency === 'COP';
                const isBs = !isCop && (p.currency ? p.currency !== 'USD' : (p.methodId.includes('_bs') || p.methodId === 'pago_movil'));
                const val = isCop
                    ? 'COP ' + (p.amountBs || (p.amountUsd * (sale.tasaCop || 1))).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : isBs
                    ? 'Bs ' + formatBs(p.amountBs || (p.amountUsd * rate))
                    : '$' + (p.amountUsd || 0).toFixed(2);

                doc.setFont('helvetica', 'normal');
                doc.setFontSize(7.5);
                doc.setTextColor(...BODY);
                doc.text(p.methodLabel || 'Pago', M, y);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(...INK);
                doc.text(val, RIGHT, y, { align: 'right' });
                y += 5;
            });
        }

        if (hasFiado) {
            y += 2;
            const fiadoRate = bcvRate || rate; // Usar tasa actual para deuda pendiente
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(...RED);
            doc.text('Deuda pendiente:', M, y);
            doc.text('$' + sale.fiadoUsd.toFixed(2), RIGHT, y, { align: 'right' });
            y += 4;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(6.5);
            doc.text('Bs ' + formatBs(sale.fiadoUsd * fiadoRate) + ' (tasa actual)', RIGHT, y, { align: 'right' });
            y += 6;
        }

        y += 2;
        dash(y); y += 7;
    }

    // ════════════════════════════════════
    //  PIE
    // ════════════════════════════════════
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text('¡Gracias por tu compra!', CX, y, { align: 'center' });
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(...MUTED);
    doc.text('Este documento no constituye factura', CX, y, { align: 'center' });
    y += 3.5;
    doc.text('fiscal. Es un comprobante de control', CX, y, { align: 'center' });
    y += 3.5;
    doc.text('interno sin validez tributaria.', CX, y, { align: 'center' });

    // ── DESCARGAR / COMPARTIR ──
    const filename = 'ticket_' + saleNum + '.pdf';
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });

    // En PC (desktop) siempre descarga directo; en móvil usa Share API
    const isMobile = 'ontouchstart' in window && window.innerWidth < 768;
    if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ title: 'Ticket #' + saleNum, files: [file] })
            .catch(() => doc.save(filename));
    } else {
        doc.save(filename);
    }
}

/**
 * Imprime un ticket de venta en impresora termica via window.print().
 * Genera un HTML optimizado para papel termico 58mm/80mm.
 * Compatible con impresoras USB (PC) y Bluetooth emparejadas (movil Android/iOS).
 */
export function printThermalTicket(sale, bcvRate) {
    const paperWidth = localStorage.getItem('printer_paper_width') || '58';
    const is80 = paperWidth === '80';

    // ── CONFIGURACIÓN DE TAMAÑOS (58mm vs 80mm) ──
    const cssPageSize = is80 ? '80mm auto' : '58mm auto';
    const cssBodyWidth = is80 ? '76mm' : '48mm';
    const cssLogoW = is80 ? '60mm' : '44mm';
    const fDisclaimer = is80 ? '9px' : '7.5px';
    const fTiny = is80 ? '11px' : '9px';     // Secundaria (detalles, RIF, c/u)
    const fSmall = is80 ? '12px' : '10px';   // Info general (fechas, nro)
    const fBase = is80 ? '14px' : '11px';    // Primaria (Items, label totales)
    const fTitle = is80 ? '18px' : '14px';   // Nombre negocio
    const fTotalU = is80 ? '32px' : '24px';  // Total $
    const fTotalB = is80 ? '18px' : '14px';  // Total Bs

    // ── OBTENER CONFIGURACIÓN DEL NEGOCIO ──
    const settings = { 
        name: localStorage.getItem('business_name') || 'Bodega Sin Nombre', 
        rif: localStorage.getItem('business_rif') || '', 
        address: localStorage.getItem('business_address') || '', 
        phone: localStorage.getItem('business_phone') || '', 
        instagram: localStorage.getItem('business_instagram') || '' 
    };

    const rate = sale.rate || bcvRate || 1;
    const saleNum = String(sale.saleNumber || 0).padStart(7, '0');
    const d = new Date(sale.timestamp);
    const fecha = d.toLocaleDateString('es-VE');
    const hora = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    const hasFiado = sale.fiadoUsd > 0;

    // Generar filas de productos
    const itemsHtml = (sale.items || []).map(item => {
        const qty = item.isWeight ? item.qty.toFixed(2) : String(item.qty);
        const unit = item.isWeight ? 'Kg' : 'u';
        const sub = item.priceUsd * item.qty;
        const subBs = sub * rate;
        const maxLen = is80 ? 32 : 22;
        const name = item.name.length > maxLen ? item.name.substring(0, maxLen) + '...' : item.name;
        return `
            <tr>
                <td style="text-align:left;font-size:${fBase};padding:2px 0;">${qty}${unit}</td>
                <td style="text-align:left;font-size:${fBase};padding:2px 0;line-height:1.2;">${name}</td>
                <td style="text-align:right;font-size:${fBase};font-weight:bold;padding:2px 0;">$${sub.toFixed(2)}</td>
            </tr>
            <tr>
                <td></td>
                <td colspan="2" style="font-size:${fTiny};color:#888;padding:0 0 4px;">$${item.priceUsd.toFixed(2)} c/u - Bs ${formatBs(subBs)}</td>
            </tr>`;
    }).join('');

    // Generar filas de pagos
    const paymentsHtml = (sale.payments || []).map(p => {
        const isCop = p.currency === 'COP';
        const isBs = !isCop && (p.currency ? p.currency !== 'USD' : (p.methodId?.includes('_bs') || p.methodId === 'pago_movil'));
        const val = isCop
            ? 'COP ' + (p.amountBs || (p.amountUsd * (sale.tasaCop || 1))).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : isBs
            ? 'Bs ' + formatBs(p.amountBs || (p.amountUsd * rate))
            : '$' + (p.amountUsd || 0).toFixed(2);
        return `
            <tr>
                <td style="font-size:11px;padding:2px 0;">${p.methodLabel || 'Pago'}</td>
                <td style="font-size:11px;font-weight:bold;text-align:right;padding:2px 0;">${val}</td>
            </tr>`;
    }).join('');

    const fiadoRate = bcvRate || rate; // Usar tasa actual para deuda pendiente
    const fiadoHtml = hasFiado ? `
        <div style="margin-top:6px;padding:4px 0;border-top:1px dashed #ccc;">
            <table style="width:100%"><tr>
                <td style="color:#dc3545;font-weight:bold;font-size:11px;">Deuda pendiente:</td>
                <td style="color:#dc3545;font-weight:bold;font-size:11px;text-align:right;">$${sale.fiadoUsd.toFixed(2)}</td>
            </tr><tr>
                <td></td>
                <td style="color:#dc3545;font-size:9px;text-align:right;">Bs ${formatBs(sale.fiadoUsd * fiadoRate)} (tasa actual)</td>
            </tr></table>
        </div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Ticket #${saleNum}</title>
<style>
    @page {
        size: ${cssPageSize};
        margin: 0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Courier New', 'Lucida Console', monospace;
        width: ${cssBodyWidth};
        max-width: ${cssBodyWidth};
        margin: 0 auto;
        padding: 4mm 2mm;
        color: #000;
        background: #fff;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .dash {
        border: none;
        border-top: 1px dashed #555;
        margin: ${is80 ? '8px 0' : '6px 0'};
    }
    .total-usd {
        font-size: ${fTotalU};
        font-weight: 900;
        color: #107c41;
        text-align: center;
        margin: 4px 0;
    }
    .total-bs {
        font-size: ${fTotalB};
        font-weight: bold;
        text-align: center;
        margin-bottom: 4px;
    }
    table { width: 100%; border-collapse: collapse; }
    @media print {
        body { width: ${cssBodyWidth}; max-width: ${cssBodyWidth}; }
    }
    @media screen {
        body {
            border: 1px solid #ccc;
            margin-top: 10px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }
    }
</style>
</head>
<body>
    <!-- Logo -->
    <div class="center" style="margin-bottom:6px;">
        <img src="/logo.png" alt="Logo" style="max-width:${cssLogoW};max-height:16mm;" onerror="this.style.display='none'">
    </div>

    <!-- Info del Negocio -->
    <div class="center" style="margin-bottom:6px;line-height:1.2;">
        ${settings.name ? `<div class="bold" style="font-size:${fTitle};text-transform:uppercase;">${settings.name}</div>` : ''}
        ${settings.rif ? `<div style="font-size:${fTiny};">RIF: ${settings.rif}</div>` : ''}
        ${settings.address ? `<div style="font-size:${fTiny};">${settings.address}</div>` : ''}
        ${settings.phone ? `<div style="font-size:${fTiny};">Tel: ${settings.phone}</div>` : ''}
        ${settings.instagram ? `<div style="font-size:${fTiny};">Ig: ${settings.instagram}</div>` : ''}
    </div>

    <hr class="dash">

    <!-- Info -->
    <table>
        <tr>
            <td style="font-size:${fSmall};font-weight:bold;">N: #${saleNum}</td>
            <td style="font-size:${fTiny};color:#555;text-align:right;">${fecha} ${hora}</td>
        </tr>
    </table>
    <div style="font-size:${fSmall};margin:3px 0 2px;">
        <span style="font-weight:bold;">Cliente:</span> ${sale.customerName || 'Consumidor Final'}
    </div>
    ${sale.customerDocument ? `<div style="font-size:${fTiny};color:#555;">C.I/RIF: ${sale.customerDocument}</div>` : ''}

    <hr class="dash">

    <!-- Productos Header -->
    <table style="margin-bottom:4px;">
        <tr style="font-size:${fTiny};color:#777;font-weight:bold;">
            <td style="text-align:left;">CANT</td>
            <td style="text-align:left;">DESCRIPCION</td>
            <td style="text-align:right;">IMPORTE</td>
        </tr>
    </table>

    <!-- Productos -->
    <table>${itemsHtml}</table>

    <hr class="dash">

    <!-- Tasa -->
    <div class="center" style="font-size:${fTiny};color:#555;margin:4px 0;">
        <div style="margin-bottom:2px;">Tasa BCV: Bs ${formatBs(rate)} por $1</div>
        ${sale.tasaCop > 0 ? `<div>Tasa COP: ${sale.tasaCop.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por $1</div>` : ''}
    </div>

    <!-- Total -->
    <div style="margin:8px 0;">
        ${sale.discountAmountUsd > 0 ? `
        <table style="margin-bottom:6px; font-size:${fTiny}; border-bottom: 1px dashed #ccc; padding-bottom: 4px;">
            <tr>
                <td style="text-align:left; color:#555; font-weight:bold;">SUBTOTAL:</td>
                <td style="text-align:right; color:#555; font-weight:bold;">$${sale.cartSubtotalUsd?.toFixed(2) || (sale.totalUsd + sale.discountAmountUsd).toFixed(2)}</td>
            </tr>
            <tr>
                <td style="text-align:left; color:#dc3545; font-weight:bold;">${sale.discountType === 'percentage' ? `DESCUENTO (${sale.discountValue}%):` : 'DESCUENTO:'}</td>
                <td style="text-align:right; color:#dc3545; font-weight:bold;">-$${sale.discountAmountUsd.toFixed(2)}</td>
            </tr>
        </table>
        ` : ''}
        <div class="center bold" style="font-size:${fSmall};color:#555;margin-bottom:4px;">TOTAL A PAGAR</div>
        <div class="total-usd">$${parseFloat(sale.totalUsd || 0).toFixed(2)}</div>
        <div class="total-bs" style="margin-bottom:${sale.copEnabled && sale.tasaCop > 0 ? '2px' : '4px'}">Bs ${formatBs(sale.totalBs || 0)}</div>
        ${sale.copEnabled && sale.tasaCop > 0 ? `<div class="total-bs" style="font-size:${is80 ? '16px' : '13px'};">COP ${(sale.totalCop || (sale.totalUsd * sale.tasaCop)).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
    </div>

    <hr class="dash">

    <!-- Pagos -->
    ${(sale.payments && sale.payments.length > 0) || hasFiado ? `
    <div style="margin:4px 0;">
        <div style="font-size:${fTiny};color:#777;font-weight:bold;margin-bottom:4px;">PAGOS REALIZADOS</div>
        <table>${paymentsHtml}</table>
        ${fiadoHtml}
    </div>
    <hr class="dash">
    ` : ''}

    <!-- Pie -->
    <div class="center bold" style="font-size:${fBase};margin:8px 0 4px;">Gracias por tu compra!</div>
    <div class="center" style="font-size:${fDisclaimer};color:#888;margin-top:4px;line-height:1.4;">Este documento no constituye factura fiscal.<br>Comprobante de control interno sin validez tributaria.</div>
</body>
</html>`;

    // Abrir ventana de impresion
    const printWindow = window.open('', '_blank', 'width=350,height=600');
    if (!printWindow) {
        // Fallback: iframe oculto
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:auto;';
        document.body.appendChild(iframe);
        iframe.contentDocument.open();
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();
        iframe.onload = () => {
            setTimeout(() => {
                iframe.contentWindow.print();
                setTimeout(() => document.body.removeChild(iframe), 2000);
            }, 300);
        };
        return;
    }
    
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    
    // Esperar a que cargue la imagen del logo antes de imprimir
    printWindow.onload = () => {
        setTimeout(() => {
            printWindow.print();
            // No cerramos automáticamente para que el usuario pueda re-imprimir
        }, 400);
    };
    
    // Fallback si onload no dispara
    setTimeout(() => {
        try { printWindow.print(); } catch(_) {}
    }, 1500);
}

/**
 * GENERADOR DE ETIQUETAS "ONE-CLICK"
 * Genera el documento PDF 58mm y dispara la impresión térmica directa.
 */
export const generarEtiquetas = async (productos, effectiveRate, copEnabled, tasaCop) => {
    // 🚀 Dynamic import for lazy loading jsPDF (no penaliza tiempo de carga inicial)
    const { default: jsPDF } = await import('jspdf');

    if (!productos || productos.length === 0) return;

    // Configuración base fija: 58mm, térmica
    const width = 58;
    const height = 40;
    const orientation = 'landscape'; // En jsPDF con mm y dimensiones personalizadas > 58x40 usamos landscape 
    const marginX = 2;
    const marginY = 2;

    const doc = new jsPDF({
        orientation: width > height ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [width, height]
    });

    productos.forEach((p, index) => {
        if (index > 0) doc.addPage([width, height], orientation);

        const printableWidth = width - (marginX * 2);
        const centerX = width / 2;
        let safeY = marginY + 2;

        // --- 1. TÍTULO DEL PRODUCTO ---
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);

        // Cortar texto si es muy largo
        const titleLines = doc.splitTextToSize(p.name.toUpperCase(), printableWidth - 2);
        const safeLines = titleLines.slice(0, 2); // Max 2 lineas
        doc.text(safeLines, centerX, safeY, { align: "center", baseline: "top" });
        
        const titleHeight = safeLines.length * (11 * 0.3527 * 1.2);
        safeY += titleHeight + 2;

        // --- 2. PRECIO PRINCIPAL (USD) ---
        doc.setFont("helvetica", "bold");
        doc.setFontSize(26);
        
        const priceUsdRaw = p.priceUsdt || 0;
        const textUsd = `$${priceUsdRaw.toFixed(2)}`;
        
        doc.text(textUsd, centerX, safeY, { align: "center", baseline: "top" });
        safeY += (26 * 0.3527 * 0.8) + 2;

        // --- 3. PRECIOS SECUNDARIOS (BS / COP) ---
        doc.setFont("helvetica", "normal");
        doc.setFontSize(12);
        
        const priceBsRaw = priceUsdRaw * effectiveRate;
        // Redondeo inteligente de Bs hacia arriba como en Listo POS si se quiere, o exacto.
        const textBs = `Bs ${Math.ceil(priceBsRaw).toLocaleString('es-VE')}`;
        
        doc.text(textBs, centerX, safeY, { align: "center", baseline: "top" });
        safeY += (12 * 0.3527 * 0.8) + 1;

        if (copEnabled && tasaCop > 0) {
            doc.setFontSize(10);
            const textCop = `${(priceUsdRaw * tasaCop).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} COP`;
            doc.text(textCop, centerX, safeY, { align: "center", baseline: "top" });
        }

        // --- 4. FOOTER (Fecha y Unidad) ---
        const footerY = height - marginY - 1;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(80);

        const fechaStr = new Date().toLocaleDateString();
        const infoExtra = p.barcode || (p.unit ? p.unit.toUpperCase() : 'UND');
        
        doc.text(`${infoExtra}  |  ${fechaStr}`, centerX, footerY, { align: "center", baseline: "bottom" });
    });

    // Auto-impresión
    doc.autoPrint();
    const blobUrl = doc.output('bloburl');
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
    iframe.src = blobUrl;
    document.body.appendChild(iframe);

    iframe.onload = () => {
        try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
        } catch (e) {
            console.error("Error printing from iframe:", e);
            window.open(blobUrl, '_blank');
        }
    };
};

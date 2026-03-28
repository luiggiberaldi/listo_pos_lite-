/**
 * GENERADOR DE ETIQUETAS "ONE-CLICK"
 * Genera el documento PDF 58mm y dispara la impresión térmica directa.
 */
import { formatUsd } from './calculatorUtils';

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

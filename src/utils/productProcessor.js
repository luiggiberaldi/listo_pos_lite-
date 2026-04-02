import { round2, mulR, divR } from './dinero';

export function buildProductPayload(formData, effectiveRate) {
    const {
        name,
        barcode,
        priceUsd,
        priceBs,
        costUsd,
        costBs,
        stock,
        stockInLotes,
        packagingType,
        unitsPerPackage,
        granelUnit,
        sellByUnit,
        unitPriceUsd,
        category,
        lowStockAlert
    } = formData;

    const formattedName = name.replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase());
    const finalPriceUsd = priceUsd ? parseFloat(priceUsd) : (priceBs ? divR(parseFloat(priceBs), effectiveRate) : 0);
    const finalCostUsd = costUsd ? parseFloat(costUsd) : (costBs ? divR(parseFloat(costBs), effectiveRate) : 0);
    const finalCostBs = costBs ? parseFloat(costBs) : (costUsd ? mulR(parseFloat(costUsd), effectiveRate) : 0);

    // Map packagingType → unit legacy
    let legacyUnit = 'unidad';
    if (packagingType === 'lote') legacyUnit = 'paquete';
    else if (packagingType === 'granel') legacyUnit = granelUnit;

    const isLote = packagingType === 'lote';
    const parsedUnitsPerPkg = isLote && unitsPerPackage ? parseInt(unitsPerPackage) : 1;
    const autoUnitPrice = parsedUnitsPerPkg > 1 ? divR(finalPriceUsd, parsedUnitsPerPkg) : finalPriceUsd;
    const finalUnitPrice = sellByUnit && unitPriceUsd ? parseFloat(unitPriceUsd) : autoUnitPrice;

    // Stock: for lote, convert lotes → units
    let finalStock = stock ? parseInt(stock) : 0;
    if (isLote && stockInLotes && parsedUnitsPerPkg > 0) {
        finalStock = parseInt(stockInLotes) * parsedUnitsPerPkg;
    }

    return {
        name: formattedName,
        barcode: barcode ? barcode.trim() : null,
        priceUsdt: finalPriceUsd,
        costUsd: finalCostUsd,
        costBs: finalCostBs,
        stock: finalStock,
        unit: legacyUnit,
        packagingType: packagingType,
        unitsPerPackage: parsedUnitsPerPkg,
        sellByUnit: isLote ? sellByUnit : false,
        unitPriceUsd: isLote && sellByUnit ? finalUnitPrice : null,
        stockInLotes: isLote && stockInLotes ? parseInt(stockInLotes) : null,
        category: category,
        lowStockAlert: lowStockAlert ? parseInt(lowStockAlert) : 5,
    };
}

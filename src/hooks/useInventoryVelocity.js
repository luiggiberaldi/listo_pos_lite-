import { useState, useEffect } from 'react';
import { storageService } from '../utils/storageService';

export function useInventoryVelocity(productsTrigger) {
    const [salesVelocityMap, setSalesVelocityMap] = useState({});

    useEffect(() => {
        const computeVelocity = async () => {
            try {
                const allSales = await storageService.getItem('bodega_sales_v1', []);
                if (!allSales.length) return;
                
                // Últimos 14 días
                const now = new Date();
                const fourteenDaysAgo = new Date(now);
                fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
                
                const recentSales = allSales.filter(s => 
                    s.timestamp && new Date(s.timestamp) >= fourteenDaysAgo &&
                    s.tipo !== 'COBRO_DEUDA' && s.status !== 'ANULADA'
                );
                
                // Contar ventas por producto
                const velocityMap = {};
                recentSales.forEach(sale => {
                    (sale.items || []).forEach(item => {
                        const key = item.id || item.name;
                        if (!velocityMap[key]) velocityMap[key] = 0;
                        velocityMap[key] += item.qty;
                    });
                });
                
                // Dividir entre 14 para obtener promedio diario
                Object.keys(velocityMap).forEach(k => {
                    velocityMap[k] = velocityMap[k] / 14;
                });
                
                setSalesVelocityMap(velocityMap);
            } catch (e) {
                // Silenciar errores
                console.error("Error computing sales velocity", e);
            }
        };
        computeVelocity();
    }, [productsTrigger]);

    return { salesVelocityMap };
}

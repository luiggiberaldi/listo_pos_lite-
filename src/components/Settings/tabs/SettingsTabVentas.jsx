import React, { useState } from 'react';
import { Package, CreditCard } from 'lucide-react';
import { SectionCard, Toggle } from '../../SettingsShared';
import PaymentMethodsManager from '../PaymentMethodsManager';
import CasheaIcon from '../../CasheaIcon';

export default function SettingsTabVentas({
    allowNegativeStock, setAllowNegativeStock,
    forceHeartbeat, showToast, triggerHaptic
}) {
    const [casheaEnabled, setCasheaEnabled] = useState(localStorage.getItem('cashea_enabled') === 'true');

    return (
        <>
            <SectionCard icon={Package} title="Inventario" subtitle="Reglas de ventas" iconColor="text-emerald-500">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Vender sin Stock</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Permitir ventas si el inventario es 0</p>
                    </div>
                    <Toggle
                        enabled={allowNegativeStock}
                        onChange={() => {
                            const newVal = !allowNegativeStock;
                            setAllowNegativeStock(newVal);
                            localStorage.setItem('allow_negative_stock', newVal.toString());
                            forceHeartbeat();
                            showToast(newVal ? 'Se permite vender sin stock' : 'No se permite vender sin stock', 'success');
                            triggerHaptic?.();
                        }}
                    />
                </div>
            </SectionCard>

            <SectionCard icon={CasheaIcon} title="Módulo Cashea" subtitle="Financiamiento buy-now-pay-later" iconColor="text-purple-500">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Activar Cashea</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Habilita el botón Cashea en el cobro. El cliente paga su porción; Cashea financia el resto (cuenta por cobrar).</p>
                    </div>
                    <Toggle
                        enabled={casheaEnabled}
                        onChange={() => {
                            const newVal = !casheaEnabled;
                            setCasheaEnabled(newVal);
                            localStorage.setItem('cashea_enabled', newVal.toString());
                            showToast(newVal ? 'Módulo Cashea activado' : 'Módulo Cashea desactivado', 'success');
                            triggerHaptic?.();
                        }}
                    />
                </div>
                {casheaEnabled && (
                    <div className="mt-3 p-3 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/40 rounded-xl">
                        <p className="text-[10px] font-bold text-purple-700 dark:text-purple-400 leading-relaxed">
                            Cuando el módulo está activo, en el cobro aparece la sección <strong>Cashea</strong>. El cajero selecciona el % que financia Cashea, el cliente paga su parte con cualquier método y la venta se registra como completada. El monto de Cashea queda como cuenta por cobrar.
                        </p>
                    </div>
                )}
            </SectionCard>

            <SectionCard icon={CreditCard} title="Metodos de Pago" subtitle="Configura como te pagan" iconColor="text-blue-500">
                <PaymentMethodsManager triggerHaptic={triggerHaptic} />
            </SectionCard>
        </>
    );
}


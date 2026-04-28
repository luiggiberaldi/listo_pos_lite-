import React from 'react';
import { Store, Printer, Coins, Check, FileText } from 'lucide-react';
import { SectionCard, Toggle } from '../../SettingsShared';
import PrinterSerialSection from '../PrinterSerialSection';

export default function SettingsTabNegocio({
    businessName, setBusinessName,
    businessRif, setBusinessRif,
    paperWidth, setPaperWidth,
    printerMode, setPrinterMode,
    copEnabled, setCopEnabled,
    autoCopEnabled, setAutoCopEnabled,
    tasaCopManual, setTasaCopManual,
    calculatedTasaCop,
    handleSaveBusinessData,
    forceHeartbeat,
    showToast,
    triggerHaptic,
}) {

    return (
        <>
            {/* Mi Negocio */}
            <SectionCard icon={Store} title="Mi Negocio" subtitle="Datos que aparecen en tickets" iconColor="text-indigo-500">
                <div>
                    <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">Nombre del Negocio</label>
                    <input
                        type="text"
                        placeholder="Ej: Mi Bodega C.A."
                        value={businessName}
                        onChange={e => setBusinessName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">RIF o Documento</label>
                    <input
                        type="text"
                        placeholder="Ej: J-12345678"
                        value={businessRif}
                        onChange={e => setBusinessRif(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                    />
                </div>
                <button
                    onClick={handleSaveBusinessData}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 font-bold text-xs uppercase tracking-wider rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors active:scale-[0.98]"
                >
                    <Check size={16} /> Guardar
                </button>
            </SectionCard>

            {/* Impresora */}
            <SectionCard icon={Printer} title="Impresora" subtitle="Tipo de impresion y papel" iconColor="text-violet-500">
                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">Modo de Impresion</label>
                <div className="grid grid-cols-2 gap-2 mb-3">
                    {[
                        { val: 'thermal', label: 'Termica', desc: 'Papel rollo 58/80mm' },
                        { val: 'inkjet_carta', label: 'Tinta Carta', desc: 'Hoja carta normal' },
                    ].map(opt => (
                        <button
                            key={opt.val}
                            onClick={() => {
                                setPrinterMode(opt.val);
                                localStorage.setItem('printer_mode', opt.val);
                                triggerHaptic?.();
                            }}
                            className={`py-2.5 px-3 text-xs font-bold rounded-xl transition-all border ${printerMode === opt.val
                                ? 'bg-violet-50 dark:bg-violet-900/20 border-violet-400 text-violet-700 dark:text-violet-300 shadow-sm'
                                : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                        >
                            <div>{opt.label}</div>
                            <div className={`text-[9px] font-medium mt-0.5 ${printerMode === opt.val ? 'text-violet-500/70' : 'text-slate-400'}`}>{opt.desc}</div>
                        </button>
                    ))}
                </div>

                {printerMode === 'thermal' && (
                    <>
                        <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">Ancho de Papel</label>
                        <div className="grid grid-cols-2 gap-2">
                            {[{ val: '58', label: '58 mm (Pequena)' }, { val: '80', label: '80 mm (Estandar)' }].map(opt => (
                                <button
                                    key={opt.val}
                                    onClick={() => { setPaperWidth(opt.val); localStorage.setItem('printer_paper_width', opt.val); triggerHaptic?.(); }}
                                    className={`py-2.5 px-3 text-xs font-bold rounded-xl transition-all border ${paperWidth === opt.val
                                        ? 'bg-violet-50 dark:bg-violet-900/20 border-violet-400 text-violet-700 dark:text-violet-300 shadow-sm'
                                        : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </>
                )}

                {printerMode === 'inkjet_carta' && (
                    <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-xl p-3">
                        <div className="flex items-start gap-2">
                            <FileText size={14} className="text-blue-500 mt-0.5 shrink-0" />
                            <p className="text-[10px] text-blue-600 dark:text-blue-400 leading-relaxed">
                                Los tickets se imprimiran en formato carta (216 x 279 mm) optimizado para impresoras de tinta convencionales. El diseno se adapta automaticamente.
                            </p>
                        </div>
                    </div>
                )}
            </SectionCard>

            {/* Impresora USB & Cajón — oculta */}

            {/* Monedas COP */}
            <SectionCard icon={Coins} title="Peso Colombiano (COP)" subtitle="Habilitar pagos y calculos en COP" iconColor="text-amber-500">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Habilitar COP</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Pagos y calculos rapidos</p>
                    </div>
                    <Toggle
                        enabled={copEnabled}
                        color="amber"
                        onChange={() => {
                            const newVal = !copEnabled;
                            setCopEnabled(newVal);
                            localStorage.setItem('cop_enabled', newVal.toString());
                            forceHeartbeat();
                            showToast(newVal ? 'COP Habilitado' : 'COP Deshabilitado', 'success');
                            triggerHaptic?.();
                        }}
                    />
                </div>
                {copEnabled && (
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-[13px] font-bold text-slate-700 dark:text-slate-200">Calcular Automaticamente</p>
                                <p className="text-[10px] text-slate-400 mt-0.5">TRM Oficial + Binance USDT</p>
                            </div>
                            <Toggle
                                enabled={autoCopEnabled}
                                color="amber"
                                onChange={() => {
                                    const newVal = !autoCopEnabled;
                                    setAutoCopEnabled(newVal);
                                    localStorage.setItem('auto_cop_enabled', newVal.toString());
                                    triggerHaptic?.();
                                }}
                            />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">
                                {autoCopEnabled ? 'Tasa Actual Calculada' : 'Tasa Manual (COP por 1 USD)'}
                            </label>
                            <input
                                type="number"
                                placeholder="Ej: 4150"
                                value={autoCopEnabled ? (calculatedTasaCop > 0 ? calculatedTasaCop.toFixed(2) : '') : tasaCopManual}
                                readOnly={autoCopEnabled}
                                onChange={e => {
                                    if (!autoCopEnabled) {
                                        setTasaCopManual(e.target.value);
                                        localStorage.setItem('tasa_cop', e.target.value);
                                    }
                                }}
                                className={`w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/30 ${autoCopEnabled ? 'text-slate-400 cursor-not-allowed bg-slate-100 dark:bg-slate-800/80' : 'text-amber-600 dark:text-amber-500'}`}
                            />
                            {autoCopEnabled && (
                                <p className="text-[9px] text-amber-600/70 dark:text-amber-400/70 mt-1.5 font-medium">Se actualiza automaticamente cada 30 segundos.</p>
                            )}
                        </div>
                    </div>
                )}
            </SectionCard>
        </>
    );
}


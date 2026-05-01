import { RefreshCw, ShoppingCart, Keyboard, Lock } from 'lucide-react';
import Tooltip from '../Tooltip';
import { useAuthStore } from '../../hooks/store/useAuthStore';

const formatBs = (n) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export default function SalesHeader({
    effectiveRate,
    useAutoRate,
    setUseAutoRate,
    customRate,
    setCustomRate,
    showRateConfig,
    setShowRateConfig,
    setShowKeyboardHelp,
    triggerHaptic
}) {
    const usuarioActivo = useAuthStore(s => s.usuarioActivo);
    const isLocked = usuarioActivo?.rol === 'CAJERO';

    const handleRateToggle = () => {
        if (isLocked) return;
        setShowRateConfig(!showRateConfig);
    };

    return (
        <div className="shrink-0 mb-2 lg:mb-1.5 bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl p-3 sm:p-4 lg:p-3 shadow-sm border border-slate-100 dark:border-slate-800">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-2 lg:mb-1">
                <div className="flex justify-between items-center">
                    <h2 className="text-xl sm:text-2xl font-black text-slate-800 dark:text-white tracking-tight flex items-center gap-2">
                        <div className="bg-emerald-500 text-white p-1.5 sm:p-2 rounded-xl shadow-lg shadow-emerald-500/30">
                            <ShoppingCart size={20} className="sm:w-[22px] sm:h-[22px]" />
                        </div>
                        Punto de Venta
                    </h2>
                    {/* Tasa Móvil (visible solo en sm) */}
                    <div className="sm:hidden">
                        <button 
                            onClick={handleRateToggle} 
                            disabled={isLocked}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border transition-all ${isLocked ? 'bg-slate-100 border-slate-200 opacity-80 cursor-not-allowed dark:bg-slate-800/50' : 'bg-slate-50 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50 active:scale-95 dark:bg-slate-800 dark:border-slate-700'}`}
                        >
                            {isLocked ? <Lock size={12} className="text-slate-400" /> : <RefreshCw size={12} className={showRateConfig ? "text-emerald-500" : "text-slate-400"} />}
                            <strong className="text-xs text-emerald-600 dark:text-emerald-400">{formatBs(effectiveRate)}</strong>
                        </button>
                    </div>
                </div>

                {/* Tasa Desktop y Botones (oculto en sm) */}
                <div className="hidden sm:flex items-center gap-2">
                    <button 
                        onClick={() => setShowKeyboardHelp(true)}
                        className="hidden md:flex items-center gap-1.5 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-xl transition-colors hover:bg-indigo-100 dark:hover:bg-indigo-900/40"
                    >
                        <Keyboard size={14} />
                        <span className="text-xs font-bold">Atajos (PC)</span>
                    </button>

                    <Tooltip text={isLocked ? "Solo los administradores pueden fijar la tasa" : (useAutoRate ? "Tasa oficial sincronizada (BCV)" : "Usando tasa manual fijada por ti")} position="bottom">
                        <button 
                            onClick={handleRateToggle} 
                            disabled={isLocked}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all group ${isLocked ? 'bg-slate-100 border-slate-200 dark:bg-slate-800/80 dark:border-slate-800 cursor-not-allowed opacity-80' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-emerald-500 hover:shadow-sm'}`}
                        >
                            <span className="text-xs text-slate-500 dark:text-slate-400 font-bold flex items-center gap-1.5">
                                {isLocked ? <Lock size={12} className="text-slate-400" /> : <RefreshCw size={12} className={showRateConfig ? "text-emerald-500" : "group-hover:text-emerald-500"} />}
                                BCV:
                            </span>
                            <strong className="text-sm text-emerald-600 dark:text-emerald-400">{formatBs(effectiveRate)} Bs</strong>
                            {!useAutoRate && <span className="text-[10px] bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-1 rounded-md font-bold">MAN</span>}
                        </button>
                    </Tooltip>
                </div>
            </div>

            {/* Rate Config Panel */}
            {showRateConfig && (
                <div className="bg-slate-50 dark:bg-slate-950 rounded-xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 p-3 mb-3 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-slate-500">Tasa de Cambio</span>
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] font-bold text-slate-400">
                                {useAutoRate ? <span className="text-emerald-500">Auto Dólar BCV</span> : <span>Manual</span>}
                            </span>
                            <button onClick={() => { triggerHaptic && triggerHaptic(); setUseAutoRate(!useAutoRate); }}
                                className={`relative w-10 h-6 rounded-full transition-colors ${useAutoRate ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}>
                                <span className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${useAutoRate ? 'translate-x-4' : 'translate-x-0'}`} />
                            </button>
                        </div>
                    </div>
                    {!useAutoRate && (
                        <input type="number" value={customRate} onChange={e => setCustomRate(e.target.value)}
                            className="w-full p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold text-indigo-600 dark:text-indigo-400 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            placeholder="Ingresa Tasa Manual (Bs por $)" autoFocus />
                    )}
                    <button
                        onClick={() => { triggerHaptic && triggerHaptic(); setShowRateConfig(false); }}
                        className="w-full mt-2 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm rounded-xl shadow-sm shadow-emerald-500/20 active:scale-95 transition-all"
                    >
                        Aceptar
                    </button>
                </div>
            )}
        </div>
    );
}

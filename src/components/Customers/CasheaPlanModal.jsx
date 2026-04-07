import { useState } from 'react';
import { X, Plus, Calendar, DollarSign, ChevronDown, ChevronUp, Info } from 'lucide-react';

/**
 * CasheaPlanModal — Registrar un nuevo plan de cuotas Cashea para un cliente
 */
export default function CasheaPlanModal({ customer, onClose, onSave, bcvRate }) {
    const [totalAmount, setTotalAmount] = useState('');
    const [downPayment, setDownPayment] = useState('');
    const [installmentCount, setInstallmentCount] = useState('3');
    const [daysPerInstallment, setDaysPerInstallment] = useState('14');
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);

    const total = parseFloat(totalAmount) || 0;
    const down = parseFloat(downPayment) || 0;
    const remaining = Math.max(0, total - down);
    const count = Math.max(1, parseInt(installmentCount) || 1);
    const cuota = count > 0 ? Math.round((remaining / count) * 100) / 100 : 0;
    const days = parseInt(daysPerInstallment) || 14;

    const isValid = total > 0 && count >= 1;

    const getDueDate = (n) => {
        const d = new Date();
        d.setDate(d.getDate() + days * n);
        return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: '2-digit' });
    };

    const handleSave = async () => {
        if (!isValid) return;
        setSaving(true);
        await onSave({
            customerId: customer.id,
            customerName: customer.name,
            totalAmount: total,
            downPayment: down,
            installmentCount: count,
            daysPerInstallment: days,
            notes: notes.trim() || null
        });
        setSaving(false);
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-cyan-50 dark:bg-cyan-950/30">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-xl bg-cyan-500 flex items-center justify-center text-white text-sm font-black">C</div>
                        <div>
                            <h3 className="text-base font-black text-slate-800 dark:text-white">Nuevo Plan Cashea</h3>
                            <p className="text-[11px] text-slate-500">{customer.name}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
                    {/* Info banner */}
                    <div className="flex items-start gap-2 bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800/40 rounded-xl px-3 py-2.5">
                        <Info size={14} className="text-cyan-500 mt-0.5 shrink-0" />
                        <p className="text-[11px] text-cyan-700 dark:text-cyan-300">Registra el plan de cuotas del cliente para llevar seguimiento desde su ficha.</p>
                    </div>

                    {/* Monto total */}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Monto Total de la Compra *</label>
                        <div className="flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-cyan-500/40">
                            <span className="px-3 text-sm font-black text-cyan-500 border-r border-slate-200 dark:border-slate-700 py-3 bg-slate-100 dark:bg-slate-800">$</span>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="0.00"
                                value={totalAmount}
                                onChange={e => setTotalAmount(e.target.value)}
                                className="flex-1 bg-transparent px-3 py-3 text-slate-800 dark:text-white outline-none text-sm font-medium"
                                autoFocus
                            />
                        </div>
                        {total > 0 && bcvRate > 0 && (
                            <p className="text-[10px] text-slate-400 mt-1 ml-1">{(total * bcvRate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs</p>
                        )}
                    </div>

                    {/* Entrada */}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Entrada Pagada (Opcional)</label>
                        <div className="flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-cyan-500/40">
                            <span className="px-3 text-sm font-black text-emerald-500 border-r border-slate-200 dark:border-slate-700 py-3 bg-slate-100 dark:bg-slate-800">$</span>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="0.00"
                                value={downPayment}
                                onChange={e => setDownPayment(e.target.value)}
                                className="flex-1 bg-transparent px-3 py-3 text-slate-800 dark:text-white outline-none text-sm font-medium"
                            />
                        </div>
                        {total > 0 && down > 0 && (
                            <p className="text-[10px] text-slate-400 mt-1 ml-1">
                                Restante a financiar: <span className="font-bold text-amber-500">${remaining.toFixed(2)}</span>
                                {bcvRate > 0 && ` · ${(remaining * bcvRate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`}
                            </p>
                        )}
                    </div>

                    {/* Cuotas y días */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">N° de Cuotas *</label>
                            <div className="flex items-center gap-1">
                                {[3, 6, 9, 12].map(n => (
                                    <button
                                        key={n}
                                        onClick={() => setInstallmentCount(String(n))}
                                        className={`flex-1 py-2 rounded-lg text-xs font-black transition-colors ${String(n) === installmentCount ? 'bg-cyan-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                                    >
                                        {n}
                                    </button>
                                ))}
                            </div>
                            <input
                                type="number"
                                min="1"
                                max="36"
                                value={installmentCount}
                                onChange={e => setInstallmentCount(e.target.value)}
                                className="mt-1.5 w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm font-medium text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                                placeholder="Personalizado"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Días entre Cuotas</label>
                            <div className="flex items-center gap-1">
                                {[7, 14, 30].map(n => (
                                    <button
                                        key={n}
                                        onClick={() => setDaysPerInstallment(String(n))}
                                        className={`flex-1 py-2 rounded-lg text-xs font-black transition-colors ${String(n) === daysPerInstallment ? 'bg-cyan-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                                    >
                                        {n}d
                                    </button>
                                ))}
                            </div>
                            <input
                                type="number"
                                min="1"
                                max="90"
                                value={daysPerInstallment}
                                onChange={e => setDaysPerInstallment(e.target.value)}
                                className="mt-1.5 w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm font-medium text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                                placeholder="Personalizado"
                            />
                        </div>
                    </div>

                    {/* Preview de cuotas */}
                    {isValid && remaining > 0 && (
                        <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
                            <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Vista Previa del Plan</p>
                            <div className="space-y-1.5">
                                {Array.from({ length: Math.min(count, 12) }, (_, i) => (
                                    <div key={i} className="flex justify-between items-center">
                                        <span className="text-xs text-slate-500 flex items-center gap-1.5">
                                            <Calendar size={10} className="text-cyan-400" />
                                            Cuota {i + 1} — {getDueDate(i + 1)}
                                        </span>
                                        <span className="text-xs font-black text-cyan-600 dark:text-cyan-400">
                                            ${i === count - 1
                                                ? Math.round((remaining - cuota * (count - 1)) * 100) / 100
                                                : cuota
                                            }
                                        </span>
                                    </div>
                                ))}
                                {count > 12 && (
                                    <p className="text-[10px] text-slate-400 text-center">... y {count - 12} cuotas más</p>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Notas */}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Notas (Opcional)</label>
                        <input
                            type="text"
                            placeholder="Ej: iPhone 15, Ref: CASH-20240407"
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-cyan-500/40 placeholder:text-slate-400"
                        />
                    </div>

                    {/* Resumen */}
                    {isValid && (
                        <div className="bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800/40 rounded-xl px-4 py-3 flex justify-between items-center">
                            <div>
                                <p className="text-[10px] font-bold text-cyan-400 uppercase">Total a Financiar</p>
                                <p className="text-xl font-black text-cyan-600 dark:text-cyan-400">${remaining.toFixed(2)}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-[10px] font-bold text-slate-400">{count} cuotas de</p>
                                <p className="text-lg font-black text-slate-700 dark:text-slate-200">${cuota.toFixed(2)}</p>
                            </div>
                        </div>
                    )}

                    {/* Botones */}
                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={onClose}
                            className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={!isValid || saving}
                            className="flex-1 py-3 bg-cyan-500 text-white rounded-xl text-sm font-black hover:bg-cyan-600 transition-colors active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            <Plus size={16} />
                            {saving ? 'Guardando...' : 'Registrar Plan'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Equal, Package, Check, ArrowRight } from 'lucide-react';
import { Modal } from '../Modal';
import { computeStockAdjustment, normalizeStockQuantity } from '../../utils/stockUtils';

export default function QuickStockModal({
    isOpen,
    onClose,
    product,
    onSave,
    triggerHaptic
}) {
    const [mode, setMode] = useState('add'); // 'add' | 'set'
    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef(null);

    // Resetear formulario al abrir con un nuevo producto
    useEffect(() => {
        if (isOpen && product) {
            setMode('add');
            setInputValue('');
            // Foco con pequeño delay para garantizar renderizado del DOM
            const timer = setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                    inputRef.current.select();
                }
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [isOpen, product]);

    if (!isOpen || !product) return null;

    const currentStock = Number(product.stock ?? 0);
    const unit = product.unit || 'unidad';
    const isDecimal = ['kg', 'litro'].includes(unit);
    const unitsPerPackage = Number(product.unitsPerPackage) || 0;

    // Parse del valor actual del input
    const parsedInput = parseFloat(inputValue);
    const allowNegative = localStorage.getItem('allow_negative_stock') === 'true';

    // Calcular nuevo stock resultante según el modo
    const { targetStock: cleanTargetStock, delta: cleanDelta } = computeStockAdjustment({
        currentStock,
        inputValue: inputValue.trim() === '' ? 0 : inputValue,
        mode,
        unit,
        allowNegative
    });

    // Chips contextuales según la unidad y configuración de empaque
    const getQuickChips = () => {
        if (isDecimal) {
            return [
                { label: '+0.25', value: 0.25 },
                { label: '+0.5', value: 0.5 },
                { label: '+1', value: 1 },
                { label: '+5', value: 5 },
                { label: '+10', value: 10 },
            ];
        }

        const chips = [
            { label: '+1', value: 1 },
            { label: '+5', value: 5 },
            { label: '+10', value: 10 },
            { label: '+12', value: 12 },
            { label: '+24', value: 24 },
        ];

        // Si tiene unidades por paquete y no es 12 ni 24, agregamos chip de lote
        if (unitsPerPackage > 1 && unitsPerPackage !== 12 && unitsPerPackage !== 24) {
            chips.push({ label: `+${unitsPerPackage} (caja)`, value: unitsPerPackage });
        }

        return chips;
    };

    const handleChipClick = (chipVal) => {
        triggerHaptic && triggerHaptic();
        if (mode === 'add') {
            const current = parseFloat(inputValue) || 0;
            const next = isDecimal ? Math.round((current + chipVal) * 1000) / 1000 : current + chipVal;
            setInputValue(next.toString());
        } else {
            // En modo fijar, sumar el chip al stock actual como sugerencia
            const next = isDecimal ? Math.round((currentStock + chipVal) * 1000) / 1000 : currentStock + chipVal;
            setInputValue(next.toString());
        }
        if (inputRef.current) inputRef.current.focus();
    };

    const handleSave = (e) => {
        if (e) e.preventDefault();
        if (inputValue.trim() === '' || isNaN(parsedInput)) return;

        triggerHaptic && triggerHaptic();
        onSave(product.id, cleanTargetStock, mode, cleanDelta);
        onClose();
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Ajuste Rápido de Stock" className="max-w-md">
            <div className="space-y-4">
                {/* Info del Producto */}
                <div className="bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-2xl border border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <div className="min-w-0 pr-2">
                        <h4 className="text-sm font-black text-slate-800 dark:text-white truncate">
                            {product.name}
                        </h4>
                        <p className="text-xs text-slate-400 font-medium capitalize">
                            Unidad: <span className="font-bold text-slate-600 dark:text-slate-300">{unit}</span>
                            {unitsPerPackage > 1 && ` · ${unitsPerPackage} uds/paquete`}
                        </p>
                    </div>
                    <div className="text-right shrink-0">
                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block">
                            Stock Actual
                        </span>
                        <span className="text-lg font-black text-brand dark:text-emerald-400">
                            {currentStock} <span className="text-xs font-semibold text-slate-400">{unit}</span>
                        </span>
                    </div>
                </div>

                {/* Tabs de Modo */}
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
                    <button
                        type="button"
                        onClick={() => {
                            setMode('add');
                            triggerHaptic && triggerHaptic();
                            if (inputRef.current) inputRef.current.focus();
                        }}
                        className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-black transition-all ${
                            mode === 'add'
                                ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-emerald-400 shadow-sm'
                                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                        }`}
                    >
                        <Plus size={15} strokeWidth={2.5} />
                        Añadir Mercancía
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setMode('set');
                            triggerHaptic && triggerHaptic();
                            if (inputRef.current) inputRef.current.focus();
                        }}
                        className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-black transition-all ${
                            mode === 'set'
                                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                        }`}
                    >
                        <Equal size={15} strokeWidth={2.5} />
                        Fijar Conteo Total
                    </button>
                </div>

                {/* Formulario Principal */}
                <form onSubmit={handleSave} className="space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1.5">
                            {mode === 'add' ? 'Cantidad a ingresar (+):' : 'Nuevo stock total exacto (=):'}
                        </label>
                        <div className="relative">
                            <input
                                ref={inputRef}
                                type="number"
                                inputMode="decimal"
                                step={isDecimal ? '0.001' : '1'}
                                min={localStorage.getItem('allow_negative_stock') === 'true' ? undefined : 0}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={mode === 'add' ? 'Ej: 24' : currentStock.toString()}
                                className="w-full text-center text-3xl font-black py-3 px-4 rounded-2xl bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 focus:border-brand dark:focus:border-brand outline-none text-slate-800 dark:text-white transition-all shadow-inner"
                            />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                                {unit}
                            </span>
                        </div>
                    </div>

                    {/* Chips de un toque */}
                    <div className="space-y-1.5">
                        <span className="text-[11px] font-bold text-slate-400 block">
                            Atajos rápidos:
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                            {getQuickChips().map((chip, idx) => (
                                <button
                                    key={idx}
                                    type="button"
                                    onClick={() => handleChipClick(chip.value)}
                                    className="px-3 py-1.5 text-xs font-black rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-all active:scale-95 border border-slate-200/50 dark:border-slate-700/50"
                                >
                                    {chip.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Preview en Vivo */}
                    <div className="p-3 bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/30 rounded-2xl flex items-center justify-between text-xs">
                        <div className="text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1.5">
                            <span>{currentStock}</span>
                            <ArrowRight size={13} className="text-emerald-500" />
                            <span className="font-black text-slate-800 dark:text-white text-sm">
                                {cleanTargetStock} {unit}
                            </span>
                        </div>
                        <span className={`font-black px-2 py-0.5 rounded-lg text-xs ${
                            cleanDelta > 0
                                ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                                : cleanDelta < 0
                                ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                        }`}>
                            {cleanDelta > 0 ? `+${cleanDelta}` : cleanDelta} {unit}
                        </span>
                    </div>

                    {/* Botones de Acción */}
                    <div className="grid grid-cols-2 gap-2 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="w-full py-3 text-xs font-black text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={inputValue.trim() === '' || isNaN(parsedInput)}
                            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-black rounded-xl shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-1.5 transition-all active:scale-95"
                        >
                            <Check size={16} strokeWidth={2.5} />
                            Guardar Stock
                        </button>
                    </div>
                </form>
            </div>
        </Modal>
    );
}

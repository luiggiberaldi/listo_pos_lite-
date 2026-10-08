import React, { useState, useEffect, useRef, useMemo } from 'react';
import { RotateCcw, AlertTriangle, Layers, CheckSquare, Package, ChevronDown } from 'lucide-react';
import { Modal } from '../Modal';
import { filterProductsByZeroScope } from '../../utils/stockUtils';

export default function ZeroStockModal({
    isOpen,
    onClose,
    products = [],
    categories = [],
    selectedIds = new Set(),
    initialScope = 'all',
    initialCategory = 'todos',
    onConfirm,
    triggerHaptic,
}) {
    const hasSelection = selectedIds instanceof Set ? selectedIds.size > 0 : Boolean(selectedIds?.length);
    const [scope, setScope] = useState(initialScope); // 'all' | 'category' | 'selected'
    const [selectedCategory, setSelectedCategory] = useState(initialCategory || 'todos');
    const [isConfirming, setIsConfirming] = useState(false);
    const timerRef = useRef(null);

    // Limpiar timeout de seguridad
    const clearSafetyTimer = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    };

    // Sincronizar estado al abrir modal
    useEffect(() => {
        if (isOpen) {
            setScope(initialScope === 'selected' && hasSelection ? 'selected' : (initialScope || 'all'));
            setSelectedCategory(initialCategory && initialCategory !== 'todos' ? initialCategory : 'todos');
            setIsConfirming(false);
            clearSafetyTimer();
        } else {
            clearSafetyTimer();
            setIsConfirming(false);
        }
        return () => clearSafetyTimer();
    }, [isOpen, initialScope, initialCategory, hasSelection]);

    // Calcular cuántos productos coinciden con el alcance actual
    const affectedProducts = useMemo(() => {
        return filterProductsByZeroScope(products, {
            scope,
            category: selectedCategory,
            selectedIds,
        });
    }, [products, scope, selectedCategory, selectedIds]);

    const affectedCount = affectedProducts.length;

    // Manejar flujo de confirmación de 2 pasos
    const handleButtonClick = () => {
        triggerHaptic && triggerHaptic();

        if (!isConfirming) {
            setIsConfirming(true);
            clearSafetyTimer();
            // Si el usuario no confirma en 4 segundos, volvemos al estado inicial
            timerRef.current = setTimeout(() => {
                setIsConfirming(false);
            }, 4000);
        } else {
            clearSafetyTimer();
            onConfirm && onConfirm({
                scope,
                category: selectedCategory,
                selectedIds,
                affectedCount,
            });
            onClose();
        }
    };

    const handleCancel = () => {
        clearSafetyTimer();
        setIsConfirming(false);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={handleCancel} title="Vaciar Existencias de Inventario" className="max-w-md">
            <div className="space-y-4">
                {/* Header Icon + Explicación */}
                <div className="flex items-center gap-3 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-2xl border border-amber-200 dark:border-amber-800/40">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                        <RotateCcw size={20} className="stroke-[2.5]" />
                    </div>
                    <div>
                        <h4 className="text-sm font-black text-slate-800 dark:text-white">
                            Poner Stock en Cero
                        </h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                            Coloca las existencias en 0 sin borrar los productos del catálogo.
                        </p>
                    </div>
                </div>

                {/* Selector de Alcance */}
                <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                        Selecciona el lote o alcance:
                    </label>

                    <div className="grid grid-cols-1 gap-2">
                        {/* Opción 1: Todo el inventario */}
                        <button
                            type="button"
                            onClick={() => {
                                setScope('all');
                                setIsConfirming(false);
                                clearSafetyTimer();
                            }}
                            className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                                scope === 'all'
                                    ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-500 text-amber-900 dark:text-amber-100 ring-2 ring-amber-500/20'
                                    : 'bg-white dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                        >
                            <div className="flex items-center gap-2.5">
                                <Package size={18} className={scope === 'all' ? 'text-amber-500' : 'text-slate-400'} />
                                <div>
                                    <p className="text-sm font-bold">Todo el inventario</p>
                                    <p className="text-xs text-slate-400">Todos los productos registrados</p>
                                </div>
                            </div>
                            <span className="text-xs font-black bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                                {products.length} prods
                            </span>
                        </button>

                        {/* Opción 2: Por categoría */}
                        <button
                            type="button"
                            onClick={() => {
                                setScope('category');
                                setIsConfirming(false);
                                clearSafetyTimer();
                            }}
                            className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                                scope === 'category'
                                    ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-500 text-amber-900 dark:text-amber-100 ring-2 ring-amber-500/20'
                                    : 'bg-white dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                        >
                            <div className="flex items-center gap-2.5">
                                <Layers size={18} className={scope === 'category' ? 'text-amber-500' : 'text-slate-400'} />
                                <div>
                                    <p className="text-sm font-bold">Por categoría / lote</p>
                                    <p className="text-xs text-slate-400">Filtrar por departamento específico</p>
                                </div>
                            </div>
                            <span className="text-xs font-black bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                                Por lote
                            </span>
                        </button>

                        {/* Opción 3: Selección activa (si existe) */}
                        {hasSelection && (
                            <button
                                type="button"
                                onClick={() => {
                                    setScope('selected');
                                    setIsConfirming(false);
                                    clearSafetyTimer();
                                }}
                                className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                                    scope === 'selected'
                                        ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-500 text-amber-900 dark:text-amber-100 ring-2 ring-amber-500/20'
                                        : 'bg-white dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                                }`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <CheckSquare size={18} className={scope === 'selected' ? 'text-amber-500' : 'text-slate-400'} />
                                    <div>
                                        <p className="text-sm font-bold">Productos seleccionados</p>
                                        <p className="text-xs text-slate-400">Solo los ítems marcados en la lista</p>
                                    </div>
                                </div>
                                <span className="text-xs font-black bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300 px-2 py-0.5 rounded-full">
                                    {selectedIds.size} seleccionados
                                </span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Desplegable de Categoría si el alcance es 'category' */}
                {scope === 'category' && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-2 animate-in fade-in duration-200">
                        <label className="text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                            Selecciona la categoría:
                        </label>
                        <div className="relative">
                            <select
                                value={selectedCategory}
                                onChange={(e) => {
                                    setSelectedCategory(e.target.value);
                                    setIsConfirming(false);
                                    clearSafetyTimer();
                                }}
                                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3 text-sm font-bold text-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-amber-500 appearance-none pr-8 cursor-pointer"
                            >
                                <option value="todos">Todas las categorías ({products.length} productos)</option>
                                {categories.map((cat) => {
                                    const count = products.filter(p => p.category === cat.id).length;
                                    return (
                                        <option key={cat.id} value={cat.id}>
                                            {cat.icon || '📦'} {cat.label} ({count} productos)
                                        </option>
                                    );
                                })}
                            </select>
                            <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                    </div>
                )}

                {/* Banner Informativo de Seguridad */}
                <div className="p-3.5 bg-slate-100 dark:bg-slate-800/70 rounded-2xl border border-slate-200 dark:border-slate-700/80 space-y-1.5">
                    <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-xs font-black uppercase tracking-wider">
                        <AlertTriangle size={15} />
                        <span>Resumen de la acción</span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                        Se colocarán en <strong>0</strong> las existencias de{' '}
                        <strong className="text-amber-600 dark:text-amber-400 font-black text-sm">
                            {affectedCount} {affectedCount === 1 ? 'producto' : 'productos'}
                        </strong>.
                    </p>
                    <p className="text-[11px] text-slate-400 font-medium">
                        ✓ Nombres, precios, costos, imágenes y códigos de barra quedarán 100% intactos.
                    </p>
                </div>

                {/* Botones de Acción */}
                <div className="flex gap-2.5 pt-2">
                    <button
                        type="button"
                        onClick={handleCancel}
                        className="flex-1 py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl active:scale-[0.98] transition-all text-sm"
                    >
                        Cancelar
                    </button>

                    <button
                        type="button"
                        onClick={handleButtonClick}
                        disabled={affectedCount === 0}
                        className={`flex-1 py-3 text-white font-black rounded-xl active:scale-[0.98] transition-all text-sm flex items-center justify-center gap-2 shadow-md ${
                            affectedCount === 0
                                ? 'bg-slate-300 dark:bg-slate-700 cursor-not-allowed shadow-none'
                                : isConfirming
                                ? 'bg-red-500 hover:bg-red-600 shadow-red-500/30 animate-pulse'
                                : 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20'
                        }`}
                    >
                        <RotateCcw size={16} className={`stroke-[2.5] ${isConfirming ? 'animate-spin' : ''}`} />
                        <span>
                            {isConfirming ? '¿Estás seguro? Sí, poner en 0' : 'Poner en 0'}
                        </span>
                    </button>
                </div>
            </div>
        </Modal>
    );
}

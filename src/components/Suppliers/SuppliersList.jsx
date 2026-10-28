import React, { useState } from 'react';
import { Truck, Plus, Search, CheckCircle2, Phone } from 'lucide-react';
import { formatUsd, formatBs } from '../../utils/calculatorUtils';
import EmptyState from '../EmptyState';
import SwipeableItem from '../SwipeableItem';

export default function SuppliersList({ 
    suppliers, 
    bcvRate,
    tasaCop,
    copEnabled,
    triggerHaptic, 
    isAdmin,
    onAddSupplier, 
    onSelectSupplier, 
    onDeleteSupplier 
}) {
    const [searchTerm, setSearchTerm] = useState('');
    const [filterType, setFilterType] = useState('all'); // 'all' | 'deuda'

    const filteredSuppliers = suppliers.filter(s => {
        const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) || (s.phone && s.phone.includes(searchTerm));
        if (!matchesSearch) return false;
        if (filterType === 'deuda') return s.deuda > 0.01;
        return true;
    });

    const totalDebtUsd = suppliers.reduce((acc, s) => acc + (s.deuda || 0), 0);

    return (
        <div className="flex flex-col h-full overflow-y-auto scrollbar-hide">
            {/* Banner de Cuentas por Pagar (Premium) */}
            <div className="px-3 sm:px-6 pt-3 shrink-0">
                <div className="bg-gradient-to-br from-purple-500 to-indigo-600 rounded-3xl p-5 text-white shadow-xl shadow-purple-500/20 relative overflow-hidden group">
                    <div className="absolute -top-10 -right-10 opacity-10 group-hover:scale-110 transition-transform duration-700">
                        <Truck size={160} />
                    </div>
                    <div className="relative z-10 flex justify-between items-start">
                        <div>
                            <p className="text-sm font-medium text-purple-100 flex items-center gap-1.5 mb-1">
                                Cuentas por Pagar
                            </p>
                            <h3 className="text-4xl font-black tracking-tight">${formatUsd(totalDebtUsd)}</h3>
                            <div className="flex flex-col mt-1">
                                {bcvRate > 0 && <p className="text-sm font-bold text-purple-200">{formatBs(totalDebtUsd * bcvRate)} Bs</p>}
                                {copEnabled && tasaCop > 0 && <p className="text-sm font-bold text-amber-200">{(totalDebtUsd * tasaCop).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} COP</p>}
                            </div>
                        </div>
                        {isAdmin && (
                            <button
                                onClick={() => { triggerHaptic && triggerHaptic(); onAddSupplier(); }}
                                className="bg-white/20 hover:bg-white/30 backdrop-blur-md text-white rounded-xl p-2.5 shadow-sm active:scale-95 transition-all"
                            >
                                <Plus size={20} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Búsqueda y Filtros */}
            <div className="mt-5 px-3 sm:px-6 shrink-0 flex flex-col gap-3">
                <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                    <input
                        type="text"
                        placeholder="Buscar proveedor..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl py-3.5 pl-11 pr-4 text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500/50 shadow-sm"
                    />
                </div>
                {/* Filtros tipo Chips */}
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1">
                    <button 
                        onClick={() => { setFilterType('all'); triggerHaptic && triggerHaptic(); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${filterType === 'all' ? 'bg-purple-500 text-white shadow-sm shadow-purple-500/30' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'}`}
                    >
                        Todos
                    </button>
                    <button 
                        onClick={() => { setFilterType('deuda'); triggerHaptic && triggerHaptic(); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors flex items-center gap-1.5 ${filterType === 'deuda' ? 'bg-red-500 text-white shadow-sm shadow-red-500/30' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'}`}
                    >
                        <div className={`w-2 h-2 rounded-full ${filterType === 'deuda' ? 'bg-white' : 'bg-red-500'}`}></div>
                        Al Debe
                    </button>
                </div>
            </div>

            {/* Listado */}
            <div className="flex-1 space-y-3 mt-4 px-3 sm:px-6 pb-4">
                {suppliers.length === 0 ? (
                    <EmptyState
                        icon={Truck}
                        title="Sin Proveedores"
                        description="Registra a tus distribuidores y proveedores para llevar control de cuentas por pagar."
                        actionLabel={isAdmin ? "NUEVO PROVEEDOR" : undefined}
                        onAction={isAdmin ? () => { triggerHaptic && triggerHaptic(); onAddSupplier(); } : undefined}
                    />
                ) : filteredSuppliers.length === 0 ? (
                    <EmptyState
                        icon={Search}
                        title="Sin resultados"
                        description={`No encontramos ningún proveedor con el término "${searchTerm}".`}
                        secondaryActionLabel="Limpiar Búsqueda"
                        onSecondaryAction={() => { setSearchTerm(''); triggerHaptic && triggerHaptic(); }}
                    />
                ) : (
                    filteredSuppliers.map(supplier => (
                        <SwipeableItem
                            key={supplier.id}
                            onDelete={isAdmin ? () => onDeleteSupplier && onDeleteSupplier(supplier) : undefined}
                            triggerHaptic={triggerHaptic}
                        >
                            <div 
                                onClick={() => { triggerHaptic && triggerHaptic(); onSelectSupplier(supplier); }}
                                className="bg-white dark:bg-slate-900 rounded-2xl px-4 py-3.5 border border-slate-100 dark:border-slate-800 shadow-sm transition-all active:scale-[0.98] flex items-center gap-3 relative cursor-pointer hover:border-purple-200 dark:hover:border-purple-800/50 group"
                            >
                                <div className="w-12 h-12 rounded-full bg-purple-50 dark:bg-purple-900/20 group-hover:bg-purple-100 dark:group-hover:bg-purple-900/40 flex items-center justify-center shrink-0 border border-purple-100 dark:border-purple-800/20 transition-colors">
                                    <span className="text-xl font-black text-purple-600 dark:text-purple-400">
                                        {supplier.name.charAt(0).toUpperCase()}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-black text-slate-800 dark:text-white text-sm truncate">{supplier.name}</h3>
                                    <div className="flex items-center gap-2 mt-1">
                                        {supplier.documentId && (
                                            <p className="text-[10px] font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700">
                                                {supplier.documentId}
                                            </p>
                                        )}
                                        {supplier.phone && (
                                            <p className="text-[10px] text-slate-400 flex items-center gap-1 font-medium">
                                                <Phone size={10} /> {supplier.phone}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    {supplier.deuda > 0 ? (
                                        <>
                                            <p className="text-sm font-black text-red-500 leading-tight">-${formatUsd(supplier.deuda)}</p>
                                            {bcvRate > 0 && <p className="text-[10px] font-bold text-red-400/80">-{formatBs(supplier.deuda * bcvRate)} Bs</p>}
                                            {copEnabled && tasaCop > 0 && <p className="text-[10px] font-bold text-amber-500/80">-{(supplier.deuda * tasaCop).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} COP</p>}
                                            <p className="text-[9px] font-bold text-red-500 bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 rounded inline-block mt-0.5 uppercase tracking-wider">Deuda</p>
                                        </>
                                    ) : (
                                        <p className="text-[10px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/30 px-2 py-1 rounded-lg flex items-center gap-1">
                                            <CheckCircle2 size={12} className="text-emerald-500" /> Solvente
                                        </p>
                                    )}
                                </div>
                            </div>
                        </SwipeableItem>
                    ))
                )}
            </div>
        </div>
    );
}

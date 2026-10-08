import React from 'react';
import { UserCheck, ShieldCheck, ShoppingBag } from 'lucide-react';
import AnimatedCounter from '../AnimatedCounter';

export default function CashierHeroCard({
    cashierName = 'Cajero',
    salesCount = 0,
    itemsCount = 0,
    operatingDate = new Date().toISOString().slice(0, 10),
}) {
    const formattedDate = (() => {
        try {
            const d = new Date(`${operatingDate}T12:00:00`);
            const days = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
            const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
            return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
        } catch {
            return operatingDate;
        }
    })();

    return (
        <div
            className="relative rounded-[1.5rem] overflow-hidden text-white shadow-lg"
            style={{ background: 'linear-gradient(135deg, #0EA5E9 0%, #06B6D4 50%, #14B8A6 100%)' }}
        >
            <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-white/10 pointer-events-none" />
            <div className="absolute -left-8 -bottom-8 w-36 h-36 rounded-full bg-white/5 pointer-events-none" />

            <div className="relative z-10 p-5 lg:p-4">
                {/* Header row */}
                <div className="flex items-start justify-between mb-3 lg:mb-2">
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 bg-emerald-400/20 text-emerald-100 border border-emerald-300/30 px-2.5 py-0.5 rounded-full text-[10px] font-black tracking-wider uppercase backdrop-blur-sm">
                            <span className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse" />
                            Turno Operativo
                        </span>
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-wider bg-white/20 text-white px-2.5 py-1 rounded-full backdrop-blur-sm">
                        {formattedDate}
                    </span>
                </div>

                {/* Content row */}
                <div className="flex items-end justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <div className="w-8 h-8 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
                                <UserCheck size={18} className="text-white" />
                            </div>
                            <div className="truncate">
                                <p className="text-white/70 text-[10px] font-bold uppercase tracking-wider">Operador en Caja</p>
                                <p className="text-xl font-black text-white truncate leading-tight">{cashierName}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 text-white/75 text-[11px] font-medium mt-2">
                            <ShieldCheck size={13} className="shrink-0 text-emerald-200" />
                            <span>Modo de turno protegido</span>
                        </div>
                    </div>

                    <div className="text-right shrink-0">
                        <div className="bg-white/20 backdrop-blur-sm rounded-2xl px-4 py-2.5 mb-1.5 text-center min-w-[110px]">
                            <p className="text-2xl font-black text-white leading-none">
                                <AnimatedCounter value={salesCount} />
                            </p>
                            <p className="text-white/80 text-[10px] font-black tracking-wider mt-0.5">
                                {salesCount === 1 ? 'VENTA' : 'VENTAS'}
                            </p>
                        </div>
                        <p className="text-white/80 text-[10px] font-bold flex items-center justify-end gap-1">
                            <ShoppingBag size={11} className="inline opacity-80" />
                            <AnimatedCounter value={itemsCount} /> {itemsCount === 1 ? 'artículo' : 'artículos'}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

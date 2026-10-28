import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Desplegable con bordes redondeados (botón y lista). Reemplaza al <select>
 * nativo, cuya lista abierta el navegador dibuja cuadrada.
 * options: [{ value, label }]
 */
export default function RoundedSelect({ value, onChange, options = [], className = '', ariaLabel }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const current = options.find(o => o.value === value) || options[0];

    useEffect(() => {
        if (!open) return undefined;
        const onDown = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('touchstart', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('touchstart', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div ref={ref} className={`relative ${className}`}>
            <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200 active:scale-[0.99] transition-colors">
                <span className="truncate">{current?.label}</span>
                <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div role="listbox" className="absolute right-0 z-20 mt-1 min-w-full w-max max-w-[16rem] p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg animate-in fade-in zoom-in-95 duration-100">
                    {options.map(o => (
                        <button key={o.value} type="button" role="option" aria-selected={o.value === value}
                            onClick={() => { onChange(o.value); setOpen(false); }}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors ${o.value === value ? 'bg-brand/10 text-brand font-bold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                            <span>{o.label}</span>
                            {o.value === value && <Check size={14} className="shrink-0" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

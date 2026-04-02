import { useState } from 'react';
import { Share2, Download, X, Copy, Check, Loader2, AlertTriangle, Package, Users, ShoppingBag, Database, CheckSquare, Square } from 'lucide-react';

// Comprimir imagen a thumbnail para compartir (max 200px, WebP 50%)
function compressImageForShare(base64) {
    return new Promise((resolve) => {
        if (!base64) return resolve(null);
        const img = new Image();
        img.onload = () => {
            const MAX = 200;
            let w = img.width, h = img.height;
            if (w > h) { h = (h / w) * MAX; w = MAX; }
            else { w = (w / h) * MAX; h = MAX; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/webp', 0.5));
        };
        img.onerror = () => resolve(null);
        img.src = base64;
    });
}

const DATA_OPTIONS = [
    {
        id: 'inventory',
        label: 'Inventario',
        desc: 'Productos y categorías',
        icon: Package,
        color: 'indigo',
    },
    {
        id: 'customers',
        label: 'Clientes',
        desc: 'Clientes y proveedores',
        icon: Users,
        color: 'emerald',
    },
    {
        id: 'sales',
        label: 'Historial de Ventas',
        desc: 'Todas las transacciones',
        icon: ShoppingBag,
        color: 'amber',
    },
];

const COLOR_MAP = {
    indigo: {
        bg: 'bg-indigo-50 dark:bg-indigo-900/20',
        icon: 'text-indigo-500',
        border: 'border-indigo-400',
        check: 'bg-indigo-500',
    },
    emerald: {
        bg: 'bg-emerald-50 dark:bg-emerald-900/20',
        icon: 'text-emerald-500',
        border: 'border-emerald-400',
        check: 'bg-emerald-500',
    },
    amber: {
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        icon: 'text-amber-500',
        border: 'border-amber-400',
        check: 'bg-amber-500',
    },
};

export default function ShareInventoryModal({
    isOpen, onClose,
    products = [], categories = [],
    customers = [], sales = [],
    onImport,
}) {
    const [tab, setTab] = useState('share');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [shareCode, setShareCode] = useState('');
    const [importCode, setImportCode] = useState('');
    const [importResult, setImportResult] = useState(null);
    const [copied, setCopied] = useState(false);
    // Selección de datos a compartir
    const [selected, setSelected] = useState({ inventory: true, customers: false, sales: false });

    if (!isOpen) return null;

    const API_URL = '/api/share';
    const noneSelected = !selected.inventory && !selected.customers && !selected.sales;

    const toggleOption = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));

    const getTotalCount = () => {
        let n = 0;
        if (selected.inventory) n += products.length;
        if (selected.customers) n += customers.length;
        if (selected.sales) n += sales.length;
        return n;
    };

    const handleShare = async () => {
        if (noneSelected) return;
        setLoading(true);
        setError('');
        setShareCode('');

        try {
            const payload = {};

            if (selected.inventory) {
                const compressedProducts = await Promise.all(
                    products.map(async (p) => ({ ...p, image: await compressImageForShare(p.image) }))
                );
                payload.products = compressedProducts;
                payload.categories = categories;
            }

            if (selected.customers) {
                payload.customers = customers;
            }

            if (selected.sales) {
                // Omitir campos pesados innecesarios para reducir payload
                payload.sales = sales.map(s => ({
                    ...s,
                    // No hay imágenes en ventas, se envía todo
                }));
            }

            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error al compartir');
            setShareCode(data.code);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(shareCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleImport = async () => {
        if (!importCode.replace(/[-\s]/g, '').trim()) return;
        setLoading(true);
        setError('');
        setImportResult(null);

        try {
            const clean = importCode.replace(/[-\s]/g, '');
            const res = await fetch(`${API_URL}?code=${clean}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error al importar');
            setImportResult(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const confirmImport = () => {
        if (!importResult) return;
        onImport(importResult);
        setImportResult(null);
        setImportCode('');
        onClose();
    };

    const handleClose = () => {
        setShareCode('');
        setImportCode('');
        setError('');
        setImportResult(null);
        setLoading(false);
        setSelected({ inventory: true, customers: false, sales: false });
        onClose();
    };

    const handleCodeInput = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 6);
        setImportCode(digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits);
    };

    // Resumen de qué trae el resultado importado
    const getImportSummary = () => {
        if (!importResult) return '';
        const parts = [];
        if (importResult.products?.length) parts.push(`${importResult.products.length} productos`);
        if (importResult.customers?.length) parts.push(`${importResult.customers.length} clientes`);
        if (importResult.sales?.length) parts.push(`${importResult.sales.length} ventas`);
        return parts.join(', ');
    };

    return (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200" onClick={handleClose}>
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-[2rem] sm:rounded-[2rem] p-6 shadow-2xl animate-in slide-in-from-bottom-10 duration-200" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg flex items-center justify-center">
                            <Database size={16} className="text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <h2 className="text-lg font-black text-slate-800 dark:text-white">Compartir Base de Datos</h2>
                    </div>
                    <button onClick={handleClose} className="p-2 text-slate-400 hover:text-slate-600 rounded-xl transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex bg-slate-100 dark:bg-slate-800 rounded-xl p-1 mb-5">
                    <button
                        onClick={() => { setTab('share'); setError(''); setShareCode(''); }}
                        className={`flex-1 py-2.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-all ${tab === 'share' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-slate-400'}`}
                    >
                        <Share2 size={14} /> Exportar
                    </button>
                    <button
                        onClick={() => { setTab('import'); setError(''); }}
                        className={`flex-1 py-2.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-all ${tab === 'import' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-slate-400'}`}
                    >
                        <Download size={14} /> Importar
                    </button>
                </div>

                {/* Error */}
                {error && (
                    <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl text-xs font-medium mb-4">
                        <AlertTriangle size={14} /> {error}
                    </div>
                )}

                {/* TAB: Exportar */}
                {tab === 'share' && (
                    <div className="space-y-4">
                        {!shareCode ? (
                            <>
                                {/* Selección de datos */}
                                <div>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                                        ¿Qué deseas compartir?
                                    </p>
                                    <div className="space-y-2">
                                        {DATA_OPTIONS.map(opt => {
                                            const isSelected = selected[opt.id];
                                            const c = COLOR_MAP[opt.color];
                                            const Icon = opt.icon;
                                            // Conteo de items
                                            const count = opt.id === 'inventory' ? products.length
                                                : opt.id === 'customers' ? customers.length
                                                : sales.length;

                                            return (
                                                <button
                                                    key={opt.id}
                                                    onClick={() => toggleOption(opt.id)}
                                                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all active:scale-[0.98] ${
                                                        isSelected
                                                            ? `${c.border} ${c.bg}`
                                                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
                                                    }`}
                                                >
                                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isSelected ? c.bg : 'bg-slate-100 dark:bg-slate-700'}`}>
                                                        <Icon size={18} className={isSelected ? c.icon : 'text-slate-400'} />
                                                    </div>
                                                    <div className="flex-1 text-left">
                                                        <p className={`text-sm font-bold ${isSelected ? 'text-slate-800 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                                                            {opt.label}
                                                        </p>
                                                        <p className="text-[10px] text-slate-400">{opt.desc} · {count} registros</p>
                                                    </div>
                                                    <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 transition-all ${isSelected ? `${c.check} text-white` : 'bg-slate-200 dark:bg-slate-600'}`}>
                                                        {isSelected
                                                            ? <Check size={12} strokeWidth={3} />
                                                            : <span className="w-2 h-2 rounded-sm bg-slate-300 dark:bg-slate-500" />
                                                        }
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Resumen */}
                                {!noneSelected && (
                                    <div className="flex items-center gap-2 p-2.5 bg-slate-50 dark:bg-slate-800 rounded-xl">
                                        <Database size={12} className="text-slate-400 shrink-0" />
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                            Se compartirán <strong className="text-slate-700 dark:text-white">{getTotalCount()} registros</strong> · El código expira en 24h.
                                        </p>
                                    </div>
                                )}

                                <button
                                    onClick={handleShare}
                                    disabled={loading || noneSelected}
                                    className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-40"
                                >
                                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Share2 size={18} />}
                                    {loading ? 'Generando código...' : 'Generar Código'}
                                </button>
                            </>
                        ) : (
                            <div className="text-center py-2">
                                <div className="w-14 h-14 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl flex items-center justify-center mx-auto mb-3">
                                    <Check size={28} className="text-emerald-500" />
                                </div>
                                <p className="text-xs text-slate-400 mb-2">Tu código para compartir:</p>
                                <div className="bg-slate-50 dark:bg-slate-800 rounded-2xl p-6 mb-3">
                                    <p className="text-4xl font-black text-indigo-600 dark:text-indigo-400 tracking-[0.3em] font-mono">{shareCode}</p>
                                </div>
                                <p className="text-[10px] text-slate-400 mb-4">
                                    El receptor debe ir a Configuración → Compartir BD → Importar y escribir este código.
                                </p>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setShareCode('')}
                                        className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-500 font-bold rounded-xl text-sm transition-all hover:bg-slate-200"
                                    >
                                        Compartir otro
                                    </button>
                                    <button
                                        onClick={handleCopy}
                                        className="flex-1 py-3 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 font-bold rounded-xl flex items-center justify-center gap-2 text-sm transition-all hover:bg-indigo-200"
                                    >
                                        {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                                        {copied ? '¡Copiado!' : 'Copiar'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* TAB: Importar */}
                {tab === 'import' && (
                    <div className="space-y-4">
                        {!importResult ? (
                            <>
                                <div className="text-center py-2">
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                        Escribe el código de 6 dígitos para importar la base de datos.
                                    </p>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={importCode}
                                        onChange={(e) => handleCodeInput(e.target.value)}
                                        placeholder="000-000"
                                        maxLength={7}
                                        className="w-full text-center text-3xl font-black font-mono tracking-[0.3em] p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 outline-none focus:border-indigo-400 text-slate-800 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600 transition-colors"
                                    />
                                </div>
                                <button
                                    onClick={handleImport}
                                    disabled={loading || importCode.replace(/\D/g, '').length !== 6}
                                    className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-40"
                                >
                                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
                                    {loading ? 'Buscando...' : 'Importar Datos'}
                                </button>
                            </>
                        ) : (
                            <div className="text-center py-2">
                                <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl flex items-center justify-center mx-auto mb-3">
                                    <Check size={32} className="text-emerald-500" />
                                </div>
                                <p className="text-sm font-black text-slate-700 dark:text-white mb-1">
                                    ¡Datos encontrados!
                                </p>
                                <p className="text-xs text-slate-500 mb-1">
                                    <strong className="text-slate-700 dark:text-slate-200">{getImportSummary()}</strong>
                                </p>

                                {/* Detalle de qué viene */}
                                <div className="flex flex-wrap justify-center gap-2 my-3">
                                    {importResult.products?.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold rounded-full">
                                            <Package size={10} /> {importResult.products.length} productos
                                        </span>
                                    )}
                                    {importResult.customers?.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold rounded-full">
                                            <Users size={10} /> {importResult.customers.length} clientes
                                        </span>
                                    )}
                                    {importResult.sales?.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold rounded-full">
                                            <ShoppingBag size={10} /> {importResult.sales.length} ventas
                                        </span>
                                    )}
                                </div>

                                <p className="text-[10px] text-amber-500 font-medium mb-4">
                                    ⚠️ Los datos existentes serán reemplazados por los importados.
                                </p>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setImportResult(null)}
                                        className="flex-1 py-3 text-sm font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        onClick={confirmImport}
                                        className="flex-1 py-3 text-sm font-bold text-white bg-emerald-500 hover:bg-emerald-600 rounded-xl active:scale-95 transition-all"
                                    >
                                        Confirmar
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

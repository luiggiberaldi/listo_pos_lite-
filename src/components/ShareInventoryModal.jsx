import { useState, useEffect } from 'react';
import { storageService } from '../utils/storageService';
import { Share2, Download, X, Copy, Check, Loader2, AlertTriangle, Package, Users, ShoppingBag, Database } from 'lucide-react';

// IDB keys per group
const SHARE_GROUPS = {
    inventory: {
        label: 'Inventario',
        desc: 'Productos y categorías',
        icon: Package,
        color: 'indigo',
        idbKeys: ['bodega_products_v1', 'my_categories_v1'],
    },
    customers: {
        label: 'Clientes',
        desc: 'Clientes y proveedores',
        icon: Users,
        color: 'emerald',
        idbKeys: ['bodega_customers_v1'],
    },
    sales: {
        label: 'Historial de Ventas',
        desc: 'Todas las transacciones',
        icon: ShoppingBag,
        color: 'amber',
        idbKeys: ['bodega_sales_v1'],
    },
};

const COLOR_MAP = {
    indigo: { bg: 'bg-indigo-50 dark:bg-indigo-900/20', icon: 'text-indigo-500', border: 'border-indigo-400', check: 'bg-indigo-500' },
    emerald: { bg: 'bg-emerald-50 dark:bg-emerald-900/20', icon: 'text-emerald-500', border: 'border-emerald-400', check: 'bg-emerald-500' },
    amber: { bg: 'bg-amber-50 dark:bg-amber-900/20', icon: 'text-amber-500', border: 'border-amber-400', check: 'bg-amber-500' },
};

// Strip product images to keep payload small
function stripImages(products) {
    if (!Array.isArray(products)) return products;
    return products.map(p => { const { image, ...rest } = p; return rest; });
}

export default function ShareInventoryModal({ isOpen, onClose }) {
    const [tab, setTab] = useState('share');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [shareCode, setShareCode] = useState('');
    const [importCode, setImportCode] = useState('');
    const [importResult, setImportResult] = useState(null);
    const [copied, setCopied] = useState(false);
    const [selected, setSelected] = useState({ inventory: true, customers: false, sales: false });
    const [counts, setCounts] = useState({ inventory: 0, customers: 0, sales: 0 });

    // Load counts from IDB when modal opens
    useEffect(() => {
        if (!isOpen) return;
        (async () => {
            const products = await storageService.getItem('bodega_products_v1', []);
            const customers = await storageService.getItem('bodega_customers_v1', []);
            const sales = await storageService.getItem('bodega_sales_v1', []);
            setCounts({
                inventory: Array.isArray(products) ? products.length : 0,
                customers: Array.isArray(customers) ? customers.length : 0,
                sales: Array.isArray(sales) ? sales.length : 0,
            });
        })();
    }, [isOpen]);

    if (!isOpen) return null;

    const API_URL = '/api/share';
    const noneSelected = !selected.inventory && !selected.customers && !selected.sales;

    const toggleOption = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));

    const getTotalCount = () =>
        Object.entries(selected).reduce((n, [id, on]) => n + (on ? counts[id] : 0), 0);

    const handleShare = async () => {
        if (noneSelected) return;
        setLoading(true);
        setError('');
        setShareCode('');

        try {
            const idb = {};
            const groups = Object.keys(selected).filter(id => selected[id]);

            for (const groupId of groups) {
                for (const key of SHARE_GROUPS[groupId].idbKeys) {
                    const data = await storageService.getItem(key, null);
                    if (data !== null && data !== undefined) {
                        // Strip images from products to reduce payload size
                        idb[key] = key === 'bodega_products_v1' ? stripImages(data) : data;
                    }
                }
            }

            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idb, groups }),
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
        if (importCode.replace(/[-\s]/g, '').length !== 6) return;
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

    const confirmImport = async () => {
        if (!importResult) return;
        setLoading(true);
        try {
            if (importResult.idb && typeof importResult.idb === 'object') {
                for (const [key, value] of Object.entries(importResult.idb)) {
                    await storageService.setItem(key, value);
                }
                if (importResult.ls && typeof importResult.ls === 'object') {
                    for (const [key, value] of Object.entries(importResult.ls)) {
                        localStorage.setItem(key, value);
                    }
                }
            } else {
                if (Array.isArray(importResult.products) && importResult.products.length > 0)
                    await storageService.setItem('bodega_products_v1', importResult.products);
                if (Array.isArray(importResult.categories) && importResult.categories.length > 0)
                    await storageService.setItem('my_categories_v1', importResult.categories);
                if (Array.isArray(importResult.customers) && importResult.customers.length > 0)
                    await storageService.setItem('bodega_customers_v1', importResult.customers);
                if (Array.isArray(importResult.sales) && importResult.sales.length > 0)
                    await storageService.setItem('bodega_sales_v1', importResult.sales);
            }
            // Marcar que se acaba de importar: CloudSync debe saltarse el Pull inicial
            // para que no sobreescriba con datos viejos de Supabase.
            // sessionStorage sobrevive a window.location.reload() dentro del mismo tab.
            sessionStorage.setItem('skip_cloud_pull', '1');
            setTimeout(() => window.location.reload(), 300);
        } catch (err) {
            setError('Error al restaurar: ' + err.message);
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (loading) return;
        setShareCode('');
        setImportCode('');
        setError('');
        setImportResult(null);
        setSelected({ inventory: true, customers: false, sales: false });
        onClose();
    };

    const handleCodeInput = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 6);
        setImportCode(digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits);
    };

    // Summary of what the import result contains
    const getImportSummary = () => {
        if (!importResult) return '';
        const parts = [];
        // New format
        const products = importResult.idb?.['bodega_products_v1'] ?? importResult.products;
        const customers = importResult.idb?.['bodega_customers_v1'] ?? importResult.customers;
        const sales = importResult.idb?.['bodega_sales_v1'] ?? importResult.sales;
        if (Array.isArray(products) && products.length) parts.push(`${products.length} productos`);
        if (Array.isArray(customers) && customers.length) parts.push(`${customers.length} clientes`);
        if (Array.isArray(sales) && sales.length) parts.push(`${sales.length} ventas`);
        return parts.join(', ') || `${importResult.groups?.join(', ') || 'datos'} importados`;
    };

    // Counts for badge chips (supports both formats)
    const importProducts = importResult?.idb?.['bodega_products_v1'] ?? importResult?.products;
    const importCustomers = importResult?.idb?.['bodega_customers_v1'] ?? importResult?.customers;
    const importSales = importResult?.idb?.['bodega_sales_v1'] ?? importResult?.sales;

    return (
        <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200"
            onClick={handleClose}
        >
            <div
                className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-[2rem] sm:rounded-[2rem] p-6 shadow-2xl animate-in slide-in-from-bottom-10 duration-200"
                onClick={e => e.stopPropagation()}
            >
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
                                <div>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                                        ¿Qué deseas compartir?
                                    </p>
                                    <div className="space-y-2">
                                        {Object.entries(SHARE_GROUPS).map(([id, opt]) => {
                                            const isSelected = selected[id];
                                            const c = COLOR_MAP[opt.color];
                                            const Icon = opt.icon;
                                            return (
                                                <button
                                                    key={id}
                                                    onClick={() => toggleOption(id)}
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
                                                        <p className="text-[10px] text-slate-400">{opt.desc} · {counts[id]} registros</p>
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
                                <p className="text-sm font-black text-slate-700 dark:text-white mb-1">¡Datos encontrados!</p>
                                <p className="text-xs text-slate-500 mb-1">
                                    <strong className="text-slate-700 dark:text-slate-200">{getImportSummary()}</strong>
                                </p>

                                <div className="flex flex-wrap justify-center gap-2 my-3">
                                    {Array.isArray(importProducts) && importProducts.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold rounded-full">
                                            <Package size={10} /> {importProducts.length} productos
                                        </span>
                                    )}
                                    {Array.isArray(importCustomers) && importCustomers.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold rounded-full">
                                            <Users size={10} /> {importCustomers.length} clientes
                                        </span>
                                    )}
                                    {Array.isArray(importSales) && importSales.length > 0 && (
                                        <span className="flex items-center gap-1 px-2.5 py-1 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold rounded-full">
                                            <ShoppingBag size={10} /> {importSales.length} ventas
                                        </span>
                                    )}
                                </div>

                                <p className="text-[10px] text-amber-500 font-medium mb-4">
                                    ⚠️ Los datos existentes serán reemplazados por los importados.
                                </p>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setImportResult(null)}
                                        disabled={loading}
                                        className="flex-1 py-3 text-sm font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-40"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        onClick={confirmImport}
                                        disabled={loading}
                                        className="flex-1 py-3 text-sm font-bold text-white bg-emerald-500 hover:bg-emerald-600 rounded-xl active:scale-95 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                                    >
                                        {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                                        {loading ? 'Importando...' : 'Confirmar'}
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

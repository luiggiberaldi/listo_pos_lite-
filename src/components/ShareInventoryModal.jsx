import { useState } from 'react';
import { Share2, Download, X, Copy, Check, Loader2, AlertTriangle, Package } from 'lucide-react';

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
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/webp', 0.5));
        };
        img.onerror = () => resolve(null);
        img.src = base64;
    });
}

export default function ShareInventoryModal({ isOpen, onClose, products, categories = [], onImport }) {
    const [tab, setTab] = useState('share'); // 'share' | 'import'
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [shareCode, setShareCode] = useState('');
    const [importCode, setImportCode] = useState('');
    const [importResult, setImportResult] = useState(null);
    const [copied, setCopied] = useState(false);

    if (!isOpen) return null;

    // Usamos el backend relativo del mismo dominio para asegurar que incluye los últimos cambios
    const API_URL = '/api/share';

    const handleShare = async () => {
        setLoading(true);
        setError('');
        setShareCode('');

        try {
            // Comprimir imágenes antes de enviar
            const compressedProducts = await Promise.all(
                products.map(async (p) => ({
                    ...p,
                    image: await compressImageForShare(p.image),
                }))
            );

            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ products: compressedProducts, categories }),
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
        if (importResult?.products) {
            onImport({ products: importResult.products, categories: importResult.categories || null });
            setImportResult(null);
            setImportCode('');
            onClose();
        }
    };

    const handleClose = () => {
        setShareCode('');
        setImportCode('');
        setError('');
        setImportResult(null);
        setLoading(false);
        onClose();
    };

    // Formatear input como XXX-XXX
    const handleCodeInput = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 6);
        if (digits.length > 3) {
            setImportCode(`${digits.slice(0, 3)}-${digits.slice(3)}`);
        } else {
            setImportCode(digits);
        }
    };

    return (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200" onClick={handleClose}>
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-[2rem] sm:rounded-[2rem] p-6 shadow-2xl animate-in slide-in-from-bottom-10 duration-200" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="flex items-center justify-between mb-5">
                    <h2 className="text-lg font-black text-slate-800 dark:text-white">Compartir Inventario</h2>
                    <button onClick={handleClose} className="p-2 text-slate-400 hover:text-slate-600 rounded-xl transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex bg-slate-100 dark:bg-slate-800 rounded-xl p-1 mb-5">
                    <button
                        onClick={() => { setTab('share'); setError(''); }}
                        className={`flex-1 py-2.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-all ${tab === 'share' ? 'bg-white dark:bg-slate-700 text-brand-dark shadow-sm' : 'text-slate-400'
                            }`}
                    >
                        <Share2 size={14} /> Compartir
                    </button>
                    <button
                        onClick={() => { setTab('import'); setError(''); }}
                        className={`flex-1 py-2.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-all ${tab === 'import' ? 'bg-white dark:bg-slate-700 text-brand-dark shadow-sm' : 'text-slate-400'
                            }`}
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

                {/* TAB: Compartir */}
                {tab === 'share' && (
                    <div className="space-y-4">
                        {!shareCode ? (
                            <>
                                <div className="text-center py-4">
                                    <div className="w-16 h-16 bg-brand/10 rounded-2xl flex items-center justify-center mx-auto mb-3">
                                        <Package size={32} className="text-brand-dark" />
                                    </div>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        Se compartirán <strong className="text-slate-700 dark:text-white">{products.length} productos</strong> con imágenes comprimidas.
                                    </p>
                                    <p className="text-[10px] text-slate-400 mt-1">El código expira en 24 horas.</p>
                                </div>
                                <button
                                    onClick={handleShare}
                                    disabled={loading || products.length === 0}
                                    className="w-full py-3.5 bg-brand hover:bg-brand/90 text-slate-900 font-black rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                                >
                                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Share2 size={18} />}
                                    {loading ? 'Generando código...' : 'Generar Código'}
                                </button>
                            </>
                        ) : (
                            <div className="text-center py-2">
                                <p className="text-xs text-slate-400 mb-2">Tu código para compartir:</p>
                                <div className="bg-slate-50 dark:bg-slate-800 rounded-2xl p-6 mb-4">
                                    <p className="text-4xl font-black text-brand-dark tracking-[0.3em] font-mono">{shareCode}</p>
                                </div>
                                <p className="text-[10px] text-slate-400 mb-4">El receptor debe ir a Inventario → Compartir → Importar y escribir este código.</p>
                                <button
                                    onClick={handleCopy}
                                    className="w-full py-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
                                >
                                    {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                                    {copied ? '¡Copiado!' : 'Copiar Código'}
                                </button>
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
                                        Escribe el código de 6 dígitos para importar el inventario.
                                    </p>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={importCode}
                                        onChange={(e) => handleCodeInput(e.target.value)}
                                        placeholder="000-000"
                                        maxLength={7}
                                        className="w-full text-center text-3xl font-black font-mono tracking-[0.3em] p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 outline-none focus:border-brand text-slate-800 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600 transition-colors"
                                    />
                                </div>
                                <button
                                    onClick={handleImport}
                                    disabled={loading || importCode.replace(/\D/g, '').length !== 6}
                                    className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                                >
                                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
                                    {loading ? 'Buscando...' : 'Importar Inventario'}
                                </button>
                            </>
                        ) : (
                            <div className="text-center py-2">
                                <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl flex items-center justify-center mx-auto mb-3">
                                    <Check size={32} className="text-emerald-500" />
                                </div>
                                <p className="text-sm font-bold text-slate-700 dark:text-white mb-1">
                                    ¡Inventario encontrado!
                                </p>
                                <p className="text-xs text-slate-400 mb-1">
                                    <strong className="text-slate-600 dark:text-slate-200">{importResult.count} productos</strong> listos para importar.
                                </p>
                                <p className="text-[10px] text-amber-500 font-medium mb-4">
                                    ⚠️ Esto reemplazará tu inventario actual.
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

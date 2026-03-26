import React, { useState, useRef } from 'react';
import {
    ArrowLeft, Store, Printer, Coins, Package, CreditCard, Database,
    Palette, Fingerprint, Upload, Download, Share2, Check, X,
    AlertTriangle, Copy, Sun, Moon, ChevronRight, Trash2
} from 'lucide-react';
import { storageService } from '../utils/storageService';
import localforage from 'localforage';
import { showToast } from '../components/Toast';
import PaymentMethodsManager from '../components/Settings/PaymentMethodsManager';
import { useSecurity } from '../hooks/useSecurity';
import { useProductContext } from '../context/ProductContext';
import ShareInventoryModal from '../components/ShareInventoryModal';

// ───────────────────────────────────────────────────── Toggle
function Toggle({ enabled, onChange, color = 'emerald' }) {
    const colors = {
        emerald: enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
        amber: enabled ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600',
        indigo: enabled ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600',
    };
    return (
        <button
            onClick={onChange}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${colors[color]}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    );
}

// ───────────────────────────────────────────────────── Section Card
function SectionCard({ icon: Icon, title, subtitle, iconColor = 'text-slate-500', children }) {
    return (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-50 dark:border-slate-800/50 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center ${iconColor}`}>
                    <Icon size={18} />
                </div>
                <div>
                    <h3 className="text-sm font-black text-slate-800 dark:text-white">{title}</h3>
                    {subtitle && <p className="text-[10px] text-slate-400 mt-0.5">{subtitle}</p>}
                </div>
            </div>
            <div className="p-5 space-y-4">{children}</div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════ MAIN
export default function SettingsView({ onClose, theme, toggleTheme, triggerHaptic }) {
    const {
        products, categories, setProducts, setCategories,
        copEnabled, setCopEnabled,
        autoCopEnabled, setAutoCopEnabled,
        tasaCopManual, setTasaCopManual,
        tasaCop: calculatedTasaCop
    } = useProductContext();

    const { deviceId, forceHeartbeat } = useSecurity();
    const fileInputRef = useRef(null);
    const [idCopied, setIdCopied] = useState(false);
    const [isShareOpen, setIsShareOpen] = useState(false);
    const [importStatus, setImportStatus] = useState(null);
    const [statusMessage, setStatusMessage] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleteInput, setDeleteInput] = useState('');

    // Business Data
    const [businessName, setBusinessName] = useState(() => localStorage.getItem('business_name') || '');
    const [businessRif, setBusinessRif] = useState(() => localStorage.getItem('business_rif') || '');
    const [paperWidth, setPaperWidth] = useState(() => localStorage.getItem('printer_paper_width') || '58');
    const [allowNegativeStock, setAllowNegativeStock] = useState(() => localStorage.getItem('allow_negative_stock') === 'true');

    // ─── HANDLERS ─────────────────────────────────────────
    const handleSaveBusinessData = () => {
        localStorage.setItem('business_name', businessName);
        localStorage.setItem('business_rif', businessRif);
        localStorage.setItem('printer_paper_width', paperWidth);
        forceHeartbeat();
        showToast('Datos del negocio guardados', 'success');
        triggerHaptic?.();
    };

    const handleExport = async () => {
        try {
            setImportStatus('loading');
            setStatusMessage('Generando backup...');
            const allProducts = await storageService.getItem('bodega_products_v1', []);
            const accounts = await storageService.getItem('bodega_accounts_v2', []);
            const categories = await storageService.getItem('my_categories_v1', []);
            const backupData = {
                timestamp: new Date().toISOString(), version: '1.0',
                data: {
                    bodega_products_v1: JSON.stringify(allProducts),
                    bodega_accounts_v2: JSON.stringify(accounts),
                    my_categories_v1: JSON.stringify(categories),
                    premium_token: localStorage.getItem('premium_token'),
                    street_rate_bs: localStorage.getItem('street_rate_bs'),
                    catalog_use_auto_usdt: localStorage.getItem('catalog_use_auto_usdt'),
                    catalog_custom_usdt_price: localStorage.getItem('catalog_custom_usdt_price'),
                    catalog_show_cash_price: localStorage.getItem('catalog_show_cash_price'),
                    monitor_rates_v12: localStorage.getItem('monitor_rates_v12'),
                    business_name: localStorage.getItem('business_name'),
                    business_rif: localStorage.getItem('business_rif'),
                }
            };
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `backup_tasasaldia_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatusMessage('Backup descargado.');
            setImportStatus('success');
            setTimeout(() => setImportStatus(null), 3000);
        } catch (error) {
            console.error(error);
            setStatusMessage('Error al generar backup.');
            setImportStatus('error');
        }
    };

    const handleImportClick = () => fileInputRef.current?.click();

    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                setImportStatus('loading');
                setStatusMessage('Restaurando datos...');
                const json = JSON.parse(e.target.result);
                if (!json.data || (!json.data.bodega_products_v1 && !json.data.bodega_accounts_v2)) {
                    throw new Error('Formato invalido.');
                }
                const lf = localforage.createInstance({ name: 'BodegaApp', storeName: 'bodega_app_data' });
                if (json.data.bodega_products_v1) {
                    await lf.setItem('bodega_products_v1', typeof json.data.bodega_products_v1 === 'string' ? JSON.parse(json.data.bodega_products_v1) : json.data.bodega_products_v1);
                }
                if (json.data.bodega_accounts_v2) {
                    await lf.setItem('bodega_accounts_v2', typeof json.data.bodega_accounts_v2 === 'string' ? JSON.parse(json.data.bodega_accounts_v2) : json.data.bodega_accounts_v2);
                }
                if (json.data.street_rate_bs) localStorage.setItem('street_rate_bs', json.data.street_rate_bs);
                if (json.data.catalog_use_auto_usdt) localStorage.setItem('catalog_use_auto_usdt', json.data.catalog_use_auto_usdt);
                if (json.data.catalog_custom_usdt_price) localStorage.setItem('catalog_custom_usdt_price', json.data.catalog_custom_usdt_price);
                if (json.data.catalog_show_cash_price) localStorage.setItem('catalog_show_cash_price', json.data.catalog_show_cash_price);
                if (json.data.monitor_rates_v12) localStorage.setItem('monitor_rates_v12', json.data.monitor_rates_v12);
                if (json.data.business_name) localStorage.setItem('business_name', json.data.business_name);
                if (json.data.business_rif) localStorage.setItem('business_rif', json.data.business_rif);
                if (json.data.my_categories_v1) {
                    const cats = typeof json.data.my_categories_v1 === 'string' ? JSON.parse(json.data.my_categories_v1) : json.data.my_categories_v1;
                    await lf.setItem('my_categories_v1', cats);
                }
                setImportStatus('success');
                setStatusMessage('Datos restaurados. Recargando...');
                setTimeout(() => window.location.reload(), 1200);
            } catch (error) {
                console.error(error);
                setImportStatus('error');
                setStatusMessage('Error: El archivo no es valido.');
            }
        };
        reader.readAsText(file);
    };

    // ─── RENDER ───────────────────────────────────────────
    return (
        <div className="fixed inset-0 z-[150] bg-slate-50 dark:bg-slate-950 flex flex-col h-[100dvh] max-h-[100dvh] w-full overflow-hidden animate-in slide-in-from-right duration-300">
            {/* Header */}
            <div className="shrink-0 px-4 pt-[env(safe-area-inset-top)] bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 shadow-sm">
                <div className="flex items-center gap-3 py-4">
                    <button
                        onClick={onClose}
                        className="p-2 -ml-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors active:scale-95"
                    >
                        <ArrowLeft size={20} className="text-slate-600 dark:text-slate-300" />
                    </button>
                    <h1 className="text-lg font-black text-slate-800 dark:text-white tracking-tight">Configuracion</h1>
                </div>
            </div>

            {/* Body - scroll */}
            <div className="flex-1 overflow-y-auto pb-[calc(3rem+env(safe-area-inset-bottom))]">
                <div className="max-w-md mx-auto p-4 space-y-4">

                    {/* 1. Mi Negocio */}
                    <SectionCard icon={Store} title="Mi Negocio" subtitle="Datos que aparecen en tickets" iconColor="text-indigo-500">
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">Nombre del Negocio</label>
                            <input
                                type="text"
                                placeholder="Ej: Mi Bodega C.A."
                                value={businessName}
                                onChange={e => setBusinessName(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">RIF o Documento</label>
                            <input
                                type="text"
                                placeholder="Ej: J-12345678"
                                value={businessRif}
                                onChange={e => setBusinessRif(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                            />
                        </div>
                        <button
                            onClick={handleSaveBusinessData}
                            className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 font-bold text-xs uppercase tracking-wider rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors active:scale-[0.98]"
                        >
                            <Check size={16} /> Guardar
                        </button>
                    </SectionCard>

                    {/* 2. Impresora */}
                    <SectionCard icon={Printer} title="Impresora" subtitle="Configuracion de papel termico" iconColor="text-violet-500">
                        <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">Ancho de Papel</label>
                        <div className="grid grid-cols-2 gap-2">
                            {[{ val: '58', label: '58 mm (Pequena)' }, { val: '80', label: '80 mm (Estandar)' }].map(opt => (
                                <button
                                    key={opt.val}
                                    onClick={() => { setPaperWidth(opt.val); localStorage.setItem('printer_paper_width', opt.val); triggerHaptic?.(); }}
                                    className={`py-2.5 px-3 text-xs font-bold rounded-xl transition-all border ${paperWidth === opt.val
                                        ? 'bg-violet-50 dark:bg-violet-900/20 border-violet-400 text-violet-700 dark:text-violet-300 shadow-sm'
                                        : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </SectionCard>

                    {/* 3. Monedas (COP) */}
                    <SectionCard icon={Coins} title="Peso Colombiano (COP)" subtitle="Habilitar pagos y calculos en COP" iconColor="text-amber-500">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Habilitar COP</p>
                                <p className="text-[10px] text-slate-400 mt-0.5">Pagos y calculos rapidos</p>
                            </div>
                            <Toggle
                                enabled={copEnabled}
                                color="amber"
                                onChange={() => {
                                    const newVal = !copEnabled;
                                    setCopEnabled(newVal);
                                    localStorage.setItem('cop_enabled', newVal.toString());
                                    forceHeartbeat();
                                    showToast(newVal ? 'COP Habilitado' : 'COP Deshabilitado', 'success');
                                    triggerHaptic?.();
                                }}
                            />
                        </div>
                        {copEnabled && (
                            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-[13px] font-bold text-slate-700 dark:text-slate-200">Calcular Automaticamente</p>
                                        <p className="text-[10px] text-slate-400 mt-0.5">TRM Oficial + Binance USDT</p>
                                    </div>
                                    <Toggle
                                        enabled={autoCopEnabled}
                                        color="amber"
                                        onChange={() => {
                                            const newVal = !autoCopEnabled;
                                            setAutoCopEnabled(newVal);
                                            localStorage.setItem('auto_cop_enabled', newVal.toString());
                                            triggerHaptic?.();
                                        }}
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5">
                                        {autoCopEnabled ? 'Tasa Actual Calculada' : 'Tasa Manual (COP por 1 USD)'}
                                    </label>
                                    <input
                                        type="number"
                                        placeholder="Ej: 4150"
                                        value={autoCopEnabled ? (calculatedTasaCop > 0 ? calculatedTasaCop.toFixed(2) : '') : tasaCopManual}
                                        readOnly={autoCopEnabled}
                                        onChange={e => {
                                            if (!autoCopEnabled) {
                                                setTasaCopManual(e.target.value);
                                                localStorage.setItem('tasa_cop', e.target.value);
                                            }
                                        }}
                                        className={`w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/30 ${autoCopEnabled ? 'text-slate-400 cursor-not-allowed bg-slate-100 dark:bg-slate-800/80' : 'text-amber-600 dark:text-amber-500'}`}
                                    />
                                    {autoCopEnabled && (
                                        <p className="text-[9px] text-amber-600/70 dark:text-amber-400/70 mt-1.5 font-medium">Se actualiza automaticamente cada 30 segundos.</p>
                                    )}
                                </div>
                            </div>
                        )}
                    </SectionCard>

                    {/* 4. Inventario */}
                    <SectionCard icon={Package} title="Inventario" subtitle="Reglas de ventas" iconColor="text-emerald-500">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Vender sin Stock</p>
                                <p className="text-[10px] text-slate-400 mt-0.5">Permitir ventas si el inventario es 0</p>
                            </div>
                            <Toggle
                                enabled={allowNegativeStock}
                                onChange={() => {
                                    const newVal = !allowNegativeStock;
                                    setAllowNegativeStock(newVal);
                                    localStorage.setItem('allow_negative_stock', newVal.toString());
                                    forceHeartbeat();
                                    showToast(newVal ? 'Se permite vender sin stock' : 'No se permite vender sin stock', 'success');
                                    triggerHaptic?.();
                                }}
                            />
                        </div>
                    </SectionCard>

                    {/* 5. Metodos de Pago */}
                    <SectionCard icon={CreditCard} title="Metodos de Pago" subtitle="Configura como te pagan" iconColor="text-blue-500">
                        <PaymentMethodsManager triggerHaptic={triggerHaptic} />
                    </SectionCard>

                    {/* 6. Datos y Respaldo */}
                    <SectionCard icon={Database} title="Datos y Respaldo" subtitle="Exportar, importar y compartir" iconColor="text-cyan-500">
                        <div className="p-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/30 rounded-xl flex gap-2.5">
                            <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                            <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed">
                                Al importar un backup, los datos actuales seran reemplazados.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <button onClick={handleExport} className="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                                <div className="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg"><Download size={18} className="text-blue-500" /></div>
                                <div className="text-left flex-1">
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Exportar Backup</p>
                                    <p className="text-[10px] text-slate-400">Descargar archivo .json</p>
                                </div>
                                <ChevronRight size={16} className="text-slate-300" />
                            </button>

                            <button onClick={handleImportClick} className="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                                <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 rounded-lg"><Upload size={18} className="text-emerald-500" /></div>
                                <div className="text-left flex-1">
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Importar Backup</p>
                                    <p className="text-[10px] text-slate-400">Restaurar desde archivo</p>
                                </div>
                                <ChevronRight size={16} className="text-slate-300" />
                            </button>

                                <button onClick={() => setIsShareOpen(true)} className="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                                    <div className="p-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg"><Share2 size={18} className="text-indigo-500" /></div>
                                    <div className="text-left flex-1">
                                        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Compartir Inventario</p>
                                        <p className="text-[10px] text-slate-400">Codigo de 6 digitos, 24h</p>
                                    </div>
                                    <ChevronRight size={16} className="text-slate-300" />
                                </button>
                        </div>

                        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".json" className="hidden" />

                        {importStatus && (
                            <div className={`p-2.5 rounded-xl text-xs font-bold text-center flex items-center justify-center gap-2 ${importStatus === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                                {importStatus === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                                {statusMessage}
                            </div>
                        )}
                    </SectionCard>

                    {/* 7. Apariencia */}
                    <SectionCard icon={Palette} title="Apariencia" subtitle="Estilo visual de la app" iconColor="text-pink-500">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                {theme === 'dark' ? <Moon size={18} className="text-indigo-400" /> : <Sun size={18} className="text-amber-500" />}
                                <div>
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{theme === 'dark' ? 'Modo Oscuro' : 'Modo Claro'}</p>
                                    <p className="text-[10px] text-slate-400 mt-0.5">Toca para cambiar</p>
                                </div>
                            </div>
                            <Toggle
                                enabled={theme === 'dark'}
                                color="indigo"
                                onChange={() => { toggleTheme(); triggerHaptic?.(); }}
                            />
                        </div>
                    </SectionCard>

                    {/* 8. Dispositivo */}
                    <SectionCard icon={Fingerprint} title="Dispositivo" subtitle="Informacion tecnica" iconColor="text-slate-500">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400 mb-1">ID de Instalacion</p>
                                <p className="font-mono text-xs font-black text-slate-600 dark:text-slate-300 select-all truncate">{deviceId || '...'}</p>
                            </div>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(deviceId).then(() => {
                                        setIdCopied(true);
                                        setTimeout(() => setIdCopied(false), 2000);
                                    });
                                }}
                                className="shrink-0 p-2 rounded-lg text-slate-400 hover:text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all"
                            >
                                {idCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="text-[9px] text-slate-400">Comparte este ID si necesitas soporte tecnico.</p>
                    </SectionCard>

                    {/* 9. Zona de Peligro */}
                    <SectionCard icon={AlertTriangle} title="Zona de Peligro" subtitle="Acciones irreversibles" iconColor="text-red-500">
                        <div className="p-2.5 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/30 rounded-xl mb-3">
                            <p className="text-[10px] text-red-700 dark:text-red-400 leading-relaxed font-bold">
                                Esta acción eliminará todo el historial de ventas y reportes estadísticos. El inventario NO será afectado.
                            </p>
                        </div>
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="w-full flex items-center gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors group active:scale-[0.98]"
                        >
                            <div className="p-2 bg-red-100 dark:bg-red-900/40 rounded-lg"><Trash2 size={18} className="text-red-600 dark:text-red-400" /></div>
                            <div className="text-left flex-1">
                                <p className="text-sm font-bold text-red-700 dark:text-red-400">Borrar Historial de Ventas</p>
                                <p className="text-[10px] text-red-500/80 dark:text-red-400/80">El inventario no se borrará</p>
                            </div>
                        </button>
                    </SectionCard>



                    {/* Version footer */}
                    <div className="text-center py-4">
                        <p className="text-[10px] text-slate-300 dark:text-slate-600 font-bold">PreciosAlDia Bodegas v1.0</p>
                    </div>
                </div>
            </div>

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowDeleteConfirm(false)}>
                    <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-200 text-center" onClick={e => e.stopPropagation()}>
                        <div className="w-16 h-16 mx-auto bg-red-100 dark:bg-red-900/30 text-red-500 rounded-full flex items-center justify-center mb-4">
                            <AlertTriangle size={32} />
                        </div>
                        <h3 className="text-xl font-black text-slate-800 dark:text-white mb-2">¿Estás seguro?</h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                            Esta acción eliminará <strong>todo el historial de ventas</strong> y dejará las estadísticas en cero.
                            <br/><br/>
                            Para confirmar, escribe <span className="font-mono font-bold text-red-500 bg-red-50 dark:bg-red-900/40 px-1 rounded">ELIMINAR</span> abajo:
                        </p>
                        <input
                            type="text"
                            value={deleteInput}
                            onChange={e => setDeleteInput(e.target.value.toUpperCase())}
                            placeholder="Escribe ELIMINAR"
                            className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-center font-mono font-bold text-slate-800 dark:text-white mb-4 focus:ring-2 focus:ring-red-500/50 outline-none uppercase transition-colors"
                            autoFocus
                        />
                        <div className="flex gap-3">
                            <button
                                onClick={() => { setShowDeleteConfirm(false); setDeleteInput(''); }}
                                className="flex-1 py-3 text-sm font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 transition-all"
                            >
                                Cancelar
                            </button>
                            <button
                                disabled={deleteInput !== 'ELIMINAR'}
                                onClick={async () => {
                                    if (deleteInput === 'ELIMINAR') {
                                        try {
                                            triggerHaptic && triggerHaptic();
                                            await storageService.removeItem('bodega_sales_v1');
                                            showToast('Historial de ventas eliminado exitosamente', 'success');
                                            setTimeout(() => window.location.reload(), 1500);
                                        } catch (err) {
                                            showToast('Error eliminando historial', 'error');
                                        }
                                    }
                                }}
                                className="flex-1 py-3 text-sm font-bold text-white bg-red-500 rounded-xl hover:bg-red-600 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Sí, borrar todo
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ShareInventoryModal
                isOpen={isShareOpen} 
                onClose={() => setIsShareOpen(false)} 
                products={products} 
                categories={categories}
                onImport={({ products: imported, categories: importedCats }) => {
                    if (importedCats && importedCats.length > 0) setCategories(importedCats);
                    if (imported && imported.length > 0) setProducts(imported);
                    showToast('Inventario importado correctamente', 'success');
                    setIsShareOpen(false);
                }}
            />
        </div>
    );
}

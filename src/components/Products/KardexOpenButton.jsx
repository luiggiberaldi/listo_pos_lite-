import React, { useEffect, useState } from 'react';
import { BookOpen, CheckCircle } from 'lucide-react';
import { Modal } from '../Modal';
import { fetchKardexStatus, openKardex } from '../../services/kardexService';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

/**
 * Corte de apertura del Kardex (solo dueño/administrador). Toma el stock que
 * se ve en ESTE dispositivo como saldo inicial de cada producto, una sola vez
 * por negocio. Se puede contar antes o empezar tal cual.
 */
export default function KardexOpenButton({ products, actor, triggerHaptic, showToast }) {
    const [status, setStatus] = useState({ checked: false, opening: null });
    const [isOpen, setIsOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);

    useEffect(() => {
        let alive = true;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
        fetchKardexStatus()
            .then(data => { if (alive) setStatus({ checked: true, opening: data?.opening || null }); })
            .catch(() => { /* sin conexión o sin sesión: el botón no se muestra */ });
        return () => { alive = false; };
    }, []);

    if (!status.checked) return null;

    // Con la ventana abierta se sigue mostrando el resultado de la apertura.
    if (status.opening && !isOpen) {
        return (
            <span className="hidden sm:flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded-full" title="Kardex iniciado">
                <BookOpen size={12} /> Kardex desde {fmtDate(status.opening.opened_at)}
            </span>
        );
    }

    const handleConfirm = async () => {
        setBusy(true);
        try {
            const deviceId = typeof localStorage !== 'undefined' ? localStorage.getItem('pda_device_id') : null;
            const res = await openKardex({ products, actor, deviceId });
            setResult(res);
            if (res?.status === 'opened' || res?.status === 'already_opened') {
                setStatus({ checked: true, opening: { opened_at: res.opened_at } });
                showToast && showToast('Kardex iniciado', 'success');
            } else {
                showToast && showToast(res?.message || 'No se pudo iniciar el Kardex', 'error');
            }
        } catch (err) {
            setResult({ status: 'error', message: err?.message || 'Error de conexión' });
            showToast && showToast('No se pudo iniciar el Kardex', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button onClick={() => { triggerHaptic && triggerHaptic(); setResult(null); setIsOpen(true); }}
                className="p-2 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-xl transition-all active:scale-95" title="Iniciar Kardex">
                <BookOpen size={16} strokeWidth={2.5} />
            </button>
            <Modal isOpen={isOpen} onClose={() => !busy && setIsOpen(false)} title="Iniciar Kardex">
                <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
                    {!result && (
                        <>
                            <p>El Kardex es la <b>libreta de movimientos</b> de cada producto: ventas, anulaciones, ajustes y conteos, con el saldo después de cada uno.</p>
                            <p>Al iniciarlo, el stock que ves <b>ahora en este dispositivo</b> queda como <b>saldo inicial</b> de cada uno de tus {products.length} productos. Se hace <b>una sola vez</b>.</p>
                            <p className="text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 rounded-xl p-3">
                                Puedes contar la mercancía antes (lo ideal, sobre todo los productos por caja) o empezar tal cual está. Si cuentas después, cada corrección quedará anotada en la libreta como "Conteo".
                            </p>
                            <button onClick={handleConfirm} disabled={busy || products.length === 0}
                                className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white py-3 rounded-2xl font-black uppercase tracking-wider active:scale-95 transition-all">
                                {busy ? 'Iniciando…' : 'Iniciar Kardex ahora'}
                            </button>
                        </>
                    )}
                    {result && (result.status === 'opened' || result.status === 'already_opened') && (
                        <div className="space-y-2">
                            <p className="flex items-center gap-2 font-bold text-emerald-600"><CheckCircle size={18} /> Kardex iniciado el {fmtDate(result.opened_at)}</p>
                            {result.status === 'opened' && (
                                <ul className="text-xs space-y-1">
                                    <li>{result.product_count} productos con saldo inicial.</li>
                                    {result.adjusted > 0 && <li>{result.adjusted} tenían en el servidor un stock distinto al de este dispositivo; quedó el de este dispositivo y la diferencia anotada.</li>}
                                    {(result.unknown_products?.length || 0) + (result.skipped?.length || 0) + (result.skippedLocal || 0) > 0 && (
                                        <li>{(result.unknown_products?.length || 0) + (result.skipped?.length || 0) + (result.skippedLocal || 0)} productos no se incluyeron (sin registro en el servidor o con datos inválidos); tendrán saldo inicial cuando lleguen al servidor.</li>
                                    )}
                                </ul>
                            )}
                            {result.status === 'already_opened' && <p className="text-xs">Este negocio ya tenía el Kardex iniciado; no se cambió nada.</p>}
                            <button onClick={() => setIsOpen(false)} className="w-full bg-slate-100 dark:bg-slate-800 py-3 rounded-2xl font-bold">Listo</button>
                        </div>
                    )}
                    {result && result.status !== 'opened' && result.status !== 'already_opened' && (
                        <div className="space-y-2">
                            <p className="text-rose-500 font-bold">No se pudo iniciar el Kardex.</p>
                            <p className="text-xs">{result.message || 'Revisa tu conexión.'} Puedes intentarlo de nuevo sin riesgo: el Kardex nunca se inicia dos veces.</p>
                            <button onClick={() => setResult(null)} className="w-full bg-slate-100 dark:bg-slate-800 py-3 rounded-2xl font-bold">Volver</button>
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
}

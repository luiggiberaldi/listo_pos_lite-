import React, { useState, useEffect } from 'react';
import { Lock, EyeOff, Eye, CheckCircle, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { supabaseCloud } from '../config/supabaseCloud';
import { translateAuthError, MIN_PASSWORD_LENGTH } from '../utils/authErrors';
import { AUTH_PREFILL_EMAIL_KEY, AUTH_OPEN_RECOVERY_KEY } from '../hooks/useCloudAuthLogic';
import { showToast } from '../components/Toast';

// Si en este tiempo no aparece la sesión del enlace, el enlace no sirve.
const LINK_TIMEOUT_MS = 10000;

// ─── Pantalla: Elegir nueva contraseña ────────────────────────────────────────
function ChangePasswordScreen({ onPasswordChanged, onRequestNewLink }) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [showPass, setShowPass] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [status, setStatus] = useState('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [sessionReady, setSessionReady] = useState(false);
    const [linkFailed, setLinkFailed] = useState(false);

    useEffect(() => {
        let ready = false;
        const markReady = () => { ready = true; setSessionReady(true); setLinkFailed(false); };
        // El enlace puede procesarse antes de montar esta pantalla: además del
        // evento, se consulta la sesión directamente.
        const { data: { subscription } } = supabaseCloud.auth.onAuthStateChange(
            (event, session) => {
                if (session && ['PASSWORD_RECOVERY', 'SIGNED_IN', 'INITIAL_SESSION', 'TOKEN_REFRESHED'].includes(event)) {
                    markReady();
                }
            }
        );
        supabaseCloud.auth.getSession().then(({ data }) => { if (data?.session) markReady(); });
        const timer = setTimeout(() => { if (!ready) setLinkFailed(true); }, LINK_TIMEOUT_MS);
        return () => { subscription.unsubscribe(); clearTimeout(timer); };
    }, []);

    const strength = (() => {
        if (!password) return 0;
        let s = 0;
        if (password.length >= MIN_PASSWORD_LENGTH) s++;
        if (password.length >= 10) s++;
        if (/[A-Z]/.test(password)) s++;
        if (/[0-9]/.test(password)) s++;
        if (/[^A-Za-z0-9]/.test(password)) s++;
        return s;
    })();

    const strengthLabel = ['', 'Muy débil', 'Débil', 'Regular', 'Fuerte', 'Muy fuerte'][strength];
    const strengthColor = ['', 'bg-red-500', 'bg-orange-400', 'bg-yellow-400', 'bg-emerald-400', 'bg-emerald-500'][strength];

    const handleSubmit = async (e) => {
        e.preventDefault();
        setErrorMsg('');
        if (password.length < MIN_PASSWORD_LENGTH) { setErrorMsg(`Mínimo ${MIN_PASSWORD_LENGTH} caracteres.`); return; }
        if (password !== confirm) { setErrorMsg('Las contraseñas no coinciden.'); return; }

        setStatus('loading');
        try {
            const { data, error } = await supabaseCloud.auth.updateUser({ password });
            if (error) throw error;

            // Cerrar la sesión del enlace y volver a la entrada normal (que
            // registra el equipo y restaura los datos) con el correo ya escrito.
            const email = data?.user?.email || '';
            await supabaseCloud.auth.signOut();
            try { if (email) sessionStorage.setItem(AUTH_PREFILL_EMAIL_KEY, email); } catch { /* sin acceso */ }
            onPasswordChanged();
        } catch (err) {
            setErrorMsg(translateAuthError(err, 'No se pudo guardar la contraseña.'));
            setStatus('idle');
        }
    };

    return (
        <>
            <div className="w-16 h-16 bg-gradient-to-br from-sky-500 to-teal-500 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl shadow-sky-500/20">
                <ShieldCheck size={30} className="text-white" />
            </div>
            <h1 className="text-2xl font-black text-slate-800 text-center mb-1">Nueva contraseña</h1>
            <p className="text-slate-500 text-sm text-center mb-8">Elige una contraseña segura para tu cuenta.</p>

            {!sessionReady && !linkFailed && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2" role="status">
                    <Loader2 size={14} className="text-amber-500 animate-spin shrink-0" />
                    <p className="text-xs text-amber-700">Verificando enlace de recuperación...</p>
                </div>
            )}
            {linkFailed && !sessionReady && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl" role="alert">
                    <p className="text-xs text-red-700 font-bold">Este enlace no es válido o ya venció.</p>
                    <button
                        type="button"
                        onClick={onRequestNewLink}
                        className="mt-2 text-xs font-black text-sky-600 hover:underline"
                    >
                        Pedir un enlace nuevo
                    </button>
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
                {/* Nueva contraseña */}
                <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1">Nueva contraseña</label>
                    <div className="relative">
                        <input
                            type={showPass ? 'text' : 'password'}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-11 pr-11 py-3.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500 transition-all"
                            autoFocus
                            disabled={!sessionReady || status === 'loading'}
                        />
                        <Lock size={16} className="absolute left-4 top-4 text-slate-500" />
                        <button type="button" onClick={() => setShowPass(p => !p)} className="absolute right-4 top-3.5 text-slate-500 hover:text-slate-300 transition-colors">
                            {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                    </div>
                    {password.length > 0 && (
                        <div className="px-1 animate-in fade-in duration-200">
                            <div className="flex gap-1 mt-2">
                                {[1, 2, 3, 4, 5].map(i => (
                                    <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= strength ? strengthColor : 'bg-slate-700'}`} />
                                ))}
                            </div>
                            <p className={`text-[10px] font-bold mt-1.5 ${['', 'text-red-400', 'text-orange-400', 'text-yellow-400', 'text-emerald-400', 'text-emerald-400'][strength]}`}>
                                {strengthLabel}
                            </p>
                        </div>
                    )}
                </div>

                {/* Confirmar */}
                <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1">Confirmar contraseña</label>
                    <div className="relative">
                        <input
                            type={showConfirm ? 'text' : 'password'}
                            value={confirm}
                            onChange={e => setConfirm(e.target.value)}
                            placeholder="Repite la contraseña"
                            className={`w-full bg-slate-50 border rounded-2xl pl-11 pr-11 py-3.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 transition-all ${
                                confirm && confirm !== password ? 'border-red-500/50 focus:ring-red-500/30'
                                : confirm && confirm === password ? 'border-emerald-500/50 focus:ring-emerald-500/30'
                                : 'border-slate-200 focus:ring-sky-500/50 focus:border-sky-500'
                            }`}
                            disabled={!sessionReady || status === 'loading'}
                        />
                        <Lock size={16} className="absolute left-4 top-4 text-slate-500" />
                        <button type="button" onClick={() => setShowConfirm(p => !p)} className="absolute right-4 top-3.5 text-slate-500 hover:text-slate-300 transition-colors">
                            {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                    </div>
                    {confirm && confirm === password && (
                        <p className="text-[10px] text-emerald-400 font-bold ml-1 flex items-center gap-1 animate-in fade-in">
                            <CheckCircle size={10} /> Las contraseñas coinciden
                        </p>
                    )}
                    {confirm && confirm !== password && (
                        <p className="text-[10px] text-red-400 font-bold ml-1 animate-in fade-in">Las contraseñas no coinciden</p>
                    )}
                </div>

                {errorMsg && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2 animate-in fade-in">
                        <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-red-300">{errorMsg}</p>
                    </div>
                )}

                <button
                    type="submit"
                    disabled={!sessionReady || status === 'loading' || !password || password !== confirm}
                    className="w-full py-3.5 bg-sky-500 hover:bg-sky-600 disabled:bg-slate-100 disabled:text-slate-400 text-white font-bold rounded-2xl transition-all active:scale-95 shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2 mt-2"
                >
                    {status === 'loading' ? (
                        <><Loader2 size={16} className="animate-spin" /> Guardando...</>
                    ) : (
                        <><ShieldCheck size={16} /> Guardar nueva contraseña</>
                    )}
                </button>
            </form>
        </>
    );
}

// ─── Componente Raíz ──────────────────────────────────────────────────────────
export default function ResetPasswordView({ onDone }) {
    const handleChanged = () => {
        showToast('Contraseña actualizada. Entra con tu nueva contraseña.', 'success');
        onDone();
    };
    const handleRequestNewLink = async () => {
        await supabaseCloud.auth.signOut().catch(() => {});
        try { sessionStorage.setItem(AUTH_OPEN_RECOVERY_KEY, 'true'); } catch { /* sin acceso */ }
        onDone();
    };

    return (
        <div className="fixed inset-0 z-[300] bg-white flex items-center justify-center p-6 font-sans">
            {/* Background glow */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-32 -left-32 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]" />
                <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-teal-400/10 rounded-full blur-[100px]" />
            </div>

            <div className="relative w-full max-w-sm animate-in slide-in-from-bottom-6 duration-300">
                <ChangePasswordScreen onPasswordChanged={handleChanged} onRequestNewLink={handleRequestNewLink} />
            </div>
        </div>
    );
}

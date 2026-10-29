import React from 'react';
import { AlertTriangle, Mail, LogIn } from 'lucide-react';
import { AUTH_OPEN_RECOVERY_KEY } from '../hooks/useCloudAuthLogic';

/**
 * Se muestra cuando el usuario abre un enlace de correo (confirmar cuenta o
 * cambiar contraseña) que venció o ya se usó. Antes la app abría normal y la
 * persona no entendía qué había pasado.
 */
export default function AuthLinkErrorView({ error, onDone }) {
    const requestNewLink = () => {
        try { sessionStorage.setItem(AUTH_OPEN_RECOVERY_KEY, 'true'); } catch { /* sin acceso */ }
        onDone();
    };

    return (
        <div className="fixed inset-0 z-[300] bg-white flex items-center justify-center p-6 font-sans">
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-32 -left-32 w-96 h-96 bg-amber-400/10 rounded-full blur-[100px]" />
                <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-sky-400/10 rounded-full blur-[100px]" />
            </div>

            <div className="relative w-full max-w-sm flex flex-col items-center text-center" role="alert">
                <div className="w-16 h-16 bg-amber-50 rounded-3xl flex items-center justify-center mb-6">
                    <AlertTriangle size={30} className="text-amber-500" />
                </div>
                <h1 className="text-2xl font-black text-slate-800 mb-2">Este enlace ya no sirve</h1>
                <p className="text-slate-500 text-sm leading-relaxed mb-8 max-w-xs">
                    {error?.message || 'El enlace venció o ya se usó. Pide uno nuevo.'}
                </p>

                <button
                    onClick={requestNewLink}
                    className="w-full py-3.5 bg-sky-500 hover:bg-sky-600 text-white font-bold rounded-2xl transition-all active:scale-95 shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2"
                >
                    <Mail size={16} /> Pedir un enlace nuevo
                </button>
                <button
                    onClick={onDone}
                    className="w-full py-3 mt-2 text-sm font-bold text-slate-500 hover:text-slate-800 transition-colors flex items-center justify-center gap-2"
                >
                    <LogIn size={15} /> Ir a iniciar sesión
                </button>
            </div>
        </div>
    );
}

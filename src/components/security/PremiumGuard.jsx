import React, { useState } from 'react';
import { Lock, Copy, Check, Star, Sparkles, Send, Bot, Store, MessageCircle, Database, Crown, CreditCard, Gift, BarChart3, Bell, Volume2, Search } from 'lucide-react';
import { useSecurity } from '../../hooks/useSecurity';
import { useAuthStore } from '../../hooks/store/useAuthStore';
import { Modal } from '../Modal';
import { SUPPORT_WHATSAPP } from '../../config/tenant';
import CloudAuthModal from './CloudAuthModal';

export default function PremiumGuard({ children, featureName = "Esta función", isShop = false }) {
    const { deviceId, isPremium, loading, unlockApp, activateDemo, demoUsed } = useSecurity();
    
    // Cloud Auth Check
    const adminEmail = useAuthStore(state => state.adminEmail);
    const adminPassword = useAuthStore(state => state.adminPassword);
    const isCloudConfigured = Boolean(adminEmail);

    const [copied, setCopied] = useState(false);
    const [demoLoading, setDemoLoading] = useState(false);
    const [isCloudModalOpen, setIsCloudModalOpen] = useState(false);

    // Estado para Modales
    const [messageModal, setMessageModal] = useState({ open: false, title: '', content: '' });

    if (loading) return <div className="p-10 text-center text-slate-400">Verificando licencia...</div>;
    if (isPremium || isCloudConfigured) return children;

    // --- Handlers ---

    const handleActivateDemo = async () => {
        setDemoLoading(true);
        const result = await activateDemo();
        setDemoLoading(false);

        if (result.success) {
            setMessageModal({
                open: true,
                title: '🎉 ¡Demo Activada!',
                content: 'Disfruta de todas las funciones premium durante 7 días. Aprovecha al máximo la herramienta.'
            });
        } else if (result.status === 'DEMO_USED') {
            setMessageModal({
                open: true,
                title: '🚫 Demo ya utilizada',
                content: 'El periodo de prueba ya fue utilizado en este dispositivo. Contacta soporte para adquirir tu licencia.'
            });
        }
    };

    const copyToClipboard = () => {
        if (typeof window !== 'undefined') {
            navigator.clipboard.writeText(deviceId);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const openWhatsApp = () => {
        const message = `Hola! Quiero adquirir una licencia para Listo POS Lite. Mi ID de instalación es: ${deviceId}`;
        const url = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
    };

    // --- Config por variante ---
    let title, message, Icon, iconColor, benefits;

    if (isShop) {
        title = <span>Listo POS Lite <span className="text-amber-500">Business</span> 👑</span>;
        message = "Desbloquea el potencial completo para tu negocio.";
        Icon = Store;
        iconColor = "text-indigo-600 dark:text-indigo-400 animate-pulse";
        benefits = (
            <>
                <BenefitItem icon={<Store size={15} className="text-indigo-500" />} text="Inventario ilimitado de productos" />
                <BenefitItem icon={<CreditCard size={15} className="text-blue-500" />} text="Sistema de Ventas y POS completo" />
                <BenefitItem icon={<BarChart3 size={15} className="text-purple-500" />} text="Reportes históricos con PDF" />
                <BenefitItem icon={<Bell size={15} className="text-amber-500" />} text="Notificaciones inteligentes" />
                <BenefitItem icon={<Search size={15} className="text-emerald-500" />} text="Categorías y búsqueda por voz" />
                <BenefitItem icon={<Volume2 size={15} className="text-rose-500" />} text="Sonidos inmersivos" />
            </>
        );
    } else {
        title = <span>Listo <span className="text-amber-500">POS Lite</span> 👑</span>;
        message = <span>Activa tu acceso para usar <strong>{featureName}</strong>.</span>;
        Icon = Lock;
        iconColor = "text-amber-500";
        benefits = (
            <>
                <BenefitItem icon={<Sparkles size={15} className="text-purple-600 dark:text-purple-400" />} text="Gestión completa de inventario" />
                <BenefitItem icon={<Star size={15} className="text-amber-500" />} text="Punto de Venta integrado" />
                <BenefitItem icon={<BarChart3 size={15} className="text-indigo-500" />} text="Reportes con descarga PDF" />
                <BenefitItem icon={<Bell size={15} className="text-rose-500" />} text="Alertas de stock y cierre de caja" />
                <BenefitItem icon={<Check size={15} className="text-green-600 dark:text-green-500" />} text="Soporte Prioritario" />
            </>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center h-full p-2 text-center overflow-hidden px-4">
            <style>{`
                @media (max-height: 600px) {
                    .benefits-list { display: none; }
                }
            `}</style>

            <div className="w-full max-w-[320px] sm:max-w-sm max-h-[95%] overflow-hidden rounded-[2rem] p-4 relative bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-2xl shadow-slate-200/50 dark:shadow-none">

                {/* Decorative Background */}
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
                <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

                {/* Icon & Title */}
                <div className="mb-2 relative z-10">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-2 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 shadow-sm">
                        <Icon className={iconColor} size={24} strokeWidth={2} />
                    </div>
                    <h2 className="text-xl font-black mb-1 tracking-tight text-slate-900 dark:text-white leading-tight">
                        {title}
                    </h2>
                    <p className="text-xs font-medium leading-tight text-slate-500 dark:text-slate-400 px-1">
                        {message}
                    </p>
                </div>

                {/* Benefits */}
                <div className="benefits-list space-y-1 mb-3 text-left relative z-10 px-1">
                    {benefits}
                </div>

                {/* CTA: Solicitar Licencia */}
                <button
                    onClick={openWhatsApp}
                    className="w-full bg-[#10B981] hover:bg-[#059669] text-white font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 mb-2 transition-all shadow-lg shadow-emerald-500/20 hover:-translate-y-0.5 active:scale-95 text-sm"
                >
                    <Send size={16} fill="white" />
                    <span>Solicitar Licencia</span>
                </button>

                {/* CTA: Probar demo */}
                <button
                    onClick={handleActivateDemo}
                    disabled={demoUsed || demoLoading}
                    className={`w-full py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 mb-3 text-sm font-bold transition-all active:scale-95
                        ${demoUsed
                            ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                            : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                        }`}
                >
                    <Gift size={16} />
                    <span>{demoUsed ? 'Demo ya utilizada' : demoLoading ? 'Activando...' : 'Probar gratis 7 días'}</span>
                </button>

                {/* Device ID */}
                <div className="bg-slate-50 dark:bg-slate-800 rounded-xl p-2 mb-3 border border-slate-100 dark:border-slate-700/50">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-0.5 font-bold leading-tight">Tu ID de Instalación</p>
                    <div className="flex items-center justify-between gap-2">
                        <code className="text-base font-mono font-bold text-slate-900 dark:text-slate-200 tracking-wider">
                            {deviceId}
                        </code>
                        <button
                            onClick={copyToClipboard}
                            className="p-1.5 bg-white dark:bg-slate-700 hover:scale-105 shadow-sm border border-slate-100 dark:border-slate-600 rounded-lg transition-all text-slate-400 dark:text-slate-300 hover:text-amber-500"
                            title="Copiar ID"
                        >
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                    </div>
                </div>

                {/* Cloud Auth Button replaces Activation Form */}
                <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2 font-bold uppercase tracking-wide leading-tight text-center">Desbloquear Nube</p>
                    <button
                        onClick={() => setIsCloudModalOpen(true)}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-md active:scale-95 text-sm"
                    >
                        <Database size={16} />
                        <span>Iniciar Sesión a la Nube</span>
                    </button>
                    {isCloudConfigured && (
                        <p className="text-[9px] text-teal-600 dark:text-teal-400 text-center font-bold mt-2">
                            Sesión iniciada como: {adminEmail}
                        </p>
                    )}
                </div>

                {/* Modal de Mensajes */}
                <Modal
                    isOpen={messageModal.open}
                    onClose={() => setMessageModal({ ...messageModal, open: false })}
                    title={messageModal.title}
                >
                    <div className="text-center py-4">
                        <p className="text-slate-600 dark:text-slate-300 mb-6 leading-relaxed">
                            {messageModal.content}
                        </p>
                        <button
                            onClick={() => {
                                setMessageModal({ ...messageModal, open: false });
                                if (messageModal.title.includes('Activada')) window.location.reload();
                            }}
                            className="w-full py-3 bg-brand text-slate-900 font-bold rounded-xl shadow-lg shadow-brand/20 active:scale-95 transition-transform"
                        >
                            Entendido
                        </button>
                    </div>
                </Modal>

                <CloudAuthModal isOpen={isCloudModalOpen} onClose={() => setIsCloudModalOpen(false)} />

            </div>
        </div>
    );
}

function BenefitItem({ icon, text }) {
    return (
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 shadow-sm">
                {icon}
            </div>
            <span>{text}</span>
        </div>
    );
}

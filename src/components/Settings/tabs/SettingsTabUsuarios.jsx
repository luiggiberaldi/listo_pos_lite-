import React, { useState } from 'react';
import {
    Users, Lock, Rocket, Clock, Timer
} from 'lucide-react';
import { SectionCard, Toggle } from '../../SettingsShared';
import UsersManager from '../UsersManager';
import CloudAuthModal from '../../security/CloudAuthModal';
import { getLockOnTabChange, setLockOnTabChange } from '../../../utils/lockOnTabChange';

// ─── CONTROL DE PRÓXIMAMENTE ────────────────────────────────────────────────
const SHOW_COMING_SOON = false;
// ────────────────────────────────────────────────────────────────────────────

const LOCK_PRESETS = [
    { val: '1', label: '1m' },
    { val: '2', label: '2m' },
    { val: '3', label: '3m' },
    { val: '5', label: '5m' },
    { val: '10', label: '10m' },
    { val: '15', label: '15m' },
    { val: '30', label: '30m' },
];

function AutoLockSelector({ autoLockMinutes, setAutoLockMinutes, triggerHaptic }) {
    const isCustom = !LOCK_PRESETS.some(p => p.val === autoLockMinutes);
    const [customVal, setCustomVal] = useState(isCustom ? autoLockMinutes : '');

    const applyMinutes = (val) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) return;
        const str = String(n);
        setAutoLockMinutes(str);
        localStorage.setItem('admin_auto_lock_minutes', str);
        triggerHaptic?.();
    };

    return (
        <div>
            <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1.5 flex items-center gap-1.5">
                <Timer size={11} /> Bloqueo Automático
            </label>
            <p className="text-[10px] text-slate-400 mb-3">Sesión bloqueada tras minutos de inactividad.</p>
            <div className="grid grid-cols-4 gap-2 mb-2">
                {LOCK_PRESETS.map(opt => (
                    <button
                        key={opt.val}
                        onClick={() => { setCustomVal(''); applyMinutes(opt.val); }}
                        className={`py-2 text-xs font-bold rounded-xl transition-all border ${autoLockMinutes === opt.val && !isCustom
                            ? 'bg-rose-50 dark:bg-rose-900/20 border-rose-400 text-rose-700 dark:text-rose-300 shadow-sm'
                            : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                    >
                        {opt.label}
                    </button>
                ))}
                <button
                    onClick={() => document.getElementById('auto-lock-custom-input')?.focus()}
                    className={`py-2 text-xs font-bold rounded-xl transition-all border col-span-4 ${isCustom
                        ? 'bg-rose-50 dark:bg-rose-900/20 border-rose-400 text-rose-700 dark:text-rose-300'
                        : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-400'
                    }`}
                >
                    {isCustom ? `${autoLockMinutes} min (personalizado)` : 'Personalizado'}
                </button>
            </div>
            <div className="flex items-center gap-2">
                <input
                    id="auto-lock-custom-input"
                    type="number"
                    min="1"
                    max="120"
                    placeholder="Ej: 20"
                    value={customVal}
                    onChange={e => setCustomVal(e.target.value)}
                    onBlur={() => { if (customVal) applyMinutes(customVal); }}
                    onKeyDown={e => { if (e.key === 'Enter' && customVal) { applyMinutes(customVal); e.target.blur(); } }}
                    className="flex-1 px-3 py-2 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-200 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-rose-300 dark:focus:ring-rose-900 font-bold"
                />
                <span className="text-[10px] text-slate-400 font-bold">min</span>
            </div>
        </div>
    );
}

function ComingSoonOverlay() {
    return (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm rounded-2xl">
            <div className="flex flex-col items-center gap-4 px-8 text-center max-w-xs">
                <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-xl shadow-indigo-500/30">
                    <Rocket size={36} className="text-white" strokeWidth={1.5} />
                </div>
                <div>
                    <h2 className="text-xl font-black text-slate-800 dark:text-white tracking-tight">Próximamente</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                        Esta sección está en desarrollo y estará disponible muy pronto.
                    </p>
                </div>
                <div className="flex items-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 rounded-full px-4 py-2">
                    <Clock size={13} className="text-indigo-500" />
                    <span className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 tracking-wide uppercase">En desarrollo</span>
                </div>
            </div>
        </div>
    );
}

function CloudLicenseViewer({ adminEmail, showToast }) {
    const [devices, setDevices] = useState([]);
    const [license, setLicense] = useState(null);
    const [loading, setLoading] = useState(true);
    const confirm = useConfirm();

    const loadData = async () => {
        setLoading(true);
        const [devRes, licRes] = await Promise.all([
            supabaseCloud.from('account_devices').select('*').eq('email', adminEmail).order('created_at', { ascending: true }),
            supabaseCloud.from('cloud_licenses').select('*').eq('email', adminEmail).maybeSingle()
        ]);
        if (!devRes.error && devRes.data) setDevices(devRes.data);
        if (!licRes.error && licRes.data) setLicense(licRes.data);
        setLoading(false);
    }

    useEffect(() => {
        if (adminEmail) loadData();
    }, [adminEmail]);

    const handleRemoveDevice = async (deviceId, alias) => {
        const ok = await confirm({
            title: 'Desvincular dispositivo',
            message: `El dispositivo "${alias}" perderá acceso a tu cuenta. Esta acción no se puede deshacer.`,
            confirmText: 'Desvincular',
            cancelText: 'Cancelar',
            variant: 'unlink',
        });
        if (!ok) return;
        const { error } = await supabaseCloud
            .from('account_devices')
            .delete()
            .eq('email', adminEmail)
            .eq('device_id', deviceId);
            
        if (error) {
            showToast('Error al desvincular', 'error');
        } else {
            showToast('Dispositivo desvinculado', 'success');
            loadData();
        }
    }

    if (loading) return <div className="p-4 text-center text-[10px] text-indigo-500 font-bold animate-pulse">Cargando estado de la licencia...</div>;
    if (!license) return null;

    const isPermanent = license.license_type === 'permanent';
    let daysDiff = 0;
    if (license.valid_until) {
        daysDiff = Math.ceil((new Date(license.valid_until) - new Date()) / 86400000);
    } else {
        daysDiff = license.days_remaining || 0;
    }
    const daysLeft = daysDiff > 0 ? daysDiff : 0;
    const isExpired = !isPermanent && daysLeft === 0;

    return (
        <div className="space-y-4">
            <div className={`p-4 rounded-xl border ${isExpired ? 'bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:border-rose-900/50' : isPermanent ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-900/50' : 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-900/50'}`}>
                <div className="flex justify-between items-center mb-4">
                    <h4 className="font-bold text-slate-800 dark:text-slate-200">Estado de Licencia</h4>
                    <span className={`px-2 py-0.5 rounded-md text-[10px] uppercase font-black tracking-wider ${isExpired ? 'bg-rose-200 text-rose-800 dark:bg-rose-800/80 dark:text-rose-100' : isPermanent ? 'bg-amber-200 text-amber-800 dark:bg-amber-800/80 dark:text-amber-100' : 'bg-indigo-200 text-indigo-800 dark:bg-indigo-800/80 dark:text-indigo-100'}`}>
                        {isExpired ? 'VENCIDA' : isPermanent ? 'LIFETIME' : 'ACTIVA'}
                    </span>
                </div>
                
                <div className="flex flex-col gap-2">
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Cupo Dispositivos</span>
                        <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                            <span className={devices.length >= license.max_devices ? 'text-rose-500 font-black' : ''}>{devices.length}</span> / {license.max_devices}
                        </span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Tipo de plan</span>
                        <span className="font-bold text-indigo-600 dark:text-indigo-400 capitalize">{license.plan_tier}</span>
                    </div>
                    
                    {!isPermanent && (
                        <>
                            <div className="w-full h-px bg-slate-200/60 dark:bg-slate-700/60 my-1 font-mono"></div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5"><Clock size={14} /> Días restantes</span>
                                <span className={`font-mono font-bold ${daysLeft <= 3 ? 'text-rose-500' : 'text-slate-700 dark:text-slate-300'}`}>{daysLeft}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-slate-500 dark:text-slate-400">Fecha de corte</span>
                                <span className="font-bold text-slate-700 dark:text-slate-300">
                                    {license.valid_until ? new Date(license.valid_until).toLocaleDateString() : 'Desconocida'}
                                </span>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="pt-2 border-t border-indigo-200 dark:border-indigo-900/40">
                <p className="text-[10px] uppercase font-bold text-indigo-700 dark:text-indigo-400 mb-2.5">Equipos Vinculados ({devices.length})</p>
                {devices.length === 0 ? (
                    <div className="text-center text-xs text-slate-500">No hay dispositivos registrados.</div>
                ) : (
                    <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                        {devices.map((d, i) => (
                            <div key={d.device_id} className="flex items-center justify-between p-2.5 bg-white/60 dark:bg-slate-900/60 border border-indigo-100 dark:border-indigo-900/50 rounded-xl shadow-sm">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 flex items-center justify-center bg-indigo-50 dark:bg-indigo-900/30 rounded-lg shrink-0">
                                        <Smartphone size={16} className="text-indigo-500" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate pr-2">
                                            {d.device_alias || `Dispositivo ${i + 1}`}
                                        </p>
                                        <p className="text-[9px] text-slate-500 font-mono mt-0.5" title={d.device_id}>Última vez: {new Date(d.last_seen).toLocaleDateString()}</p>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => handleRemoveDevice(d.device_id, d.device_alias || `Dispositivo ${i + 1}`)}
                                    className="p-2 text-rose-500 dark:text-rose-400 bg-white dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-900/20 border border-rose-100 dark:border-rose-900/50 rounded-lg transition-colors active:scale-95 shadow-sm"
                                    title="Desvincular"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function SettingsTabUsuarios({
    isCloudConfigured, adminEmail,
    requireLogin, setRequireLogin,
    autoLockMinutes, setAutoLockMinutes,
    setAdminCredentials, showToast, triggerHaptic,
}) {
    const [isCloudModalOpen, setIsCloudModalOpen] = useState(false);
    const [lockOnTabChange, setLockOnTabChangeState] = useState(getLockOnTabChange);

    return (
        <div className="relative">
            {SHOW_COMING_SOON && <ComingSoonOverlay />}
            {isCloudConfigured && (
                <SectionCard icon={Users} title="Usuarios y Roles" subtitle="Gestiona quien opera la app" iconColor="text-indigo-500">
                    <UsersManager triggerHaptic={triggerHaptic} />
                </SectionCard>
            )}

            <SectionCard icon={Lock} title="Seguridad Local" subtitle="Protección física del dispositivo" iconColor="text-rose-500">
                <div className="flex items-center justify-between mb-4 border-b border-slate-100 dark:border-slate-800 pb-4">
                    <div>
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Pedir PIN al iniciar</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Si se desactiva, entrará directo como Administrador.</p>
                    </div>
                    <Toggle
                        enabled={requireLogin}
                        color="rose"
                        onChange={() => {
                            const newVal = !requireLogin;
                            if (setRequireLogin) setRequireLogin(newVal);
                            triggerHaptic?.();
                            showToast(newVal ? 'PIN activado para inicio' : 'Acceso directo activado', 'success');
                        }}
                    />
                </div>

                {/* Bloqueo al cambiar de pestaña — por dispositivo, solo visible si PIN está activo */}
                {requireLogin && (
                    <div className="flex items-center justify-between mb-4 border-b border-slate-100 dark:border-slate-800 pb-4">
                        <div>
                            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Bloquear con PIN al cambiar de pestaña</p>
                            <p className="text-[10px] text-slate-400 mt-0.5">Pide el PIN al salir de la app o minimizarla. Solo en este dispositivo.</p>
                        </div>
                        <Toggle
                            enabled={lockOnTabChange}
                            color="rose"
                            onChange={() => {
                                const newVal = !lockOnTabChange;
                                setLockOnTabChange(newVal);
                                setLockOnTabChangeState(newVal);
                                triggerHaptic?.();
                                showToast(newVal ? 'Se pedirá PIN al cambiar de pestaña' : 'Ya no se pedirá PIN al cambiar de pestaña', 'success');
                            }}
                        />
                    </div>
                )}

                {/* Bloqueo por inactividad — solo visible si PIN está activo */}
                {requireLogin && (
                    <AutoLockSelector
                        autoLockMinutes={autoLockMinutes}
                        setAutoLockMinutes={setAutoLockMinutes}
                        triggerHaptic={triggerHaptic}
                    />
                )}
            </SectionCard>
        </div>
    );
}


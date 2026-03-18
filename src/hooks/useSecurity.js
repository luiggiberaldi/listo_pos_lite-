import { useState, useEffect, useCallback } from 'react';
import { storageService } from '../utils/storageService';
import { supabase } from '../core/supabaseClient';

const APP_VERSION = '1.0.0';
const PRODUCT_ID = 'bodega';

const DEMO_DURATION_MS = 168 * 60 * 60 * 1000; // 168 horas (7 días)

// FIX 2: Ofuscación XOR + btoa para tokens en localStorage
// WARNING: This is basic obfuscation to prevent casual tampering by employees.
// It is NOT cryptographically secure from a determined attacker.
const XOR_KEY = 'PDA_SEC_2026';

const encodeToken = (str) => {
    try {
        const xored = str.split('').map((c, i) =>
            String.fromCharCode(
                c.charCodeAt(0) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
            )
        ).join('');
        return btoa(unescape(encodeURIComponent(xored)));
    } catch { return str; }
};

const decodeToken = (encoded) => {
    try {
        const xored = decodeURIComponent(escape(atob(encoded)));
        return xored.split('').map((c, i) =>
            String.fromCharCode(
                c.charCodeAt(0) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
            )
        ).join('');
    } catch { return encoded; }
};



export function useSecurity() {
    const [deviceId, setDeviceId] = useState('');
    const [isPremium, setIsPremium] = useState(false);
    const [loading, setLoading] = useState(true);
    const [isDemo, setIsDemo] = useState(false);
    const [demoExpires, setDemoExpires] = useState(null);
    const [demoExpiredMsg, setDemoExpiredMsg] = useState('');
    const [demoTimeLeft, setDemoTimeLeft] = useState('');
    // FIX 3: demoUsed como estado, leído desde IndexedDB
    const [demoUsed, setDemoUsed] = useState(false);

    // Calcular tiempo restante formateado
    const updateTimeLeft = useCallback((expiresAt) => {
        if (!expiresAt) { setDemoTimeLeft(''); return; }
        const diff = expiresAt - Date.now();
        if (diff <= 0) { setDemoTimeLeft(''); return; }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (days > 0) setDemoTimeLeft(`${days}d ${hours}h`);
        else if (hours > 0) setDemoTimeLeft(`${hours}h ${mins}m`);
        else setDemoTimeLeft(`${mins}m`);
    }, []);

    useEffect(() => {
        // 1. Obtener o Generar Device ID a través de fingerprinting
        const generateFingerprint = async () => {
            const nav = window.navigator;
            const screen = window.screen;

            const components = [
                nav.userAgent,
                nav.language,
                nav.hardwareConcurrency || 1,
                nav.deviceMemory || 1,
                screen.width,
                screen.height,
                screen.colorDepth,
                new Date().getTimezoneOffset()
            ].join('|');

            if (!window.crypto || !window.crypto.subtle) {
                // Fallback (solo en http sin SSL)
                let hash = 0;
                for (let i = 0; i < components.length; i++) {
                    hash = ((hash << 5) - hash) + components.charCodeAt(i);
                    hash |= 0;
                }
                const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
                return `PDA-${hex}`;
            }

            // Mismo hardware = mismo hash SHA-256
            const encoder = new TextEncoder();
            const data = encoder.encode(components);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().substring(0, 8);
            return `PDA-${hex}`;
        };

        const initDeviceId = async () => {
            let storedId = localStorage.getItem('pda_device_id');
            if (!storedId) {
                storedId = await generateFingerprint();
                localStorage.setItem('pda_device_id', storedId);
            }
            setDeviceId(storedId);

            // Auto-registro: registrar dispositivo si no existe (sin importar licencia)
            try {
                if (import.meta.env.VITE_SUPABASE_URL) {
                    const clientName = localStorage.getItem('business_name') || localStorage.getItem('restaurant_name') || '';
                    await supabase.rpc('auto_register_device', { p_device_id: storedId, p_product_id: PRODUCT_ID, p_client_name: clientName });
                }
            } catch (e) { /* silencioso */ }

            checkLicense(storedId);
        };

        initDeviceId();

        // FIX 3: Leer demo flag desde IndexedDB
        storageService.getItem('pda_demo_flag_v1', null).then(r => {
            if (r?.used) setDemoUsed(true);
        });
    }, []);

    // Heartbeat + chequeo de revocación en tiempo real
    useEffect(() => {
        if (!isPremium || !deviceId || !import.meta.env.VITE_SUPABASE_URL) return;

        // Función de chequeo rápido de estado
        const verifyStatus = async () => {
            try {
                const { data: license, error } = await supabase
                    .from('licenses')
                    .select('type, active, expires_at')
                    .eq('device_id', deviceId)
                    .eq('product_id', PRODUCT_ID)
                    .maybeSingle();

                if (license && (license.active === false || license.type === 'revoked') && isPremium) {
                    // Revocado
                    localStorage.removeItem('pda_premium_token');
                    setIsPremium(false);
                    setIsDemo(false);
                    setDemoExpiredMsg("Tu licencia ha sido desactivada. Contacta al administrador.");
                } else if (license && license.active === true) {
                    // Verificar si demo venció por fecha
                    if (license.type === 'demo7' && license.expires_at) {
                        const expiresAt = new Date(license.expires_at).getTime();
                        if (Date.now() >= expiresAt && isPremium) {
                            localStorage.removeItem('pda_premium_token');
                            setIsPremium(false);
                            setIsDemo(false);
                            setDemoExpiredMsg("Tu licencia temporal ha finalizado. Esperamos que hayas disfrutado la experiencia completa.");
                            setLoading(false);
                            return;
                        }
                    }

                    // Si pasó a permanente en backend pero el estado local es demo -> recargar
                    const rawStored = localStorage.getItem('pda_premium_token');
                    let isDemoLocal = false;
                    if (rawStored) {
                        try {
                            isDemoLocal = decodeToken(rawStored).includes('"isDemo":true');
                        } catch (e) {
                            isDemoLocal = rawStored.includes('"isDemo":true');
                        }
                    }

                    const isMismatch = (license.type === 'permanent' && isDemoLocal) ||
                        (license.type === 'demo7' && !isDemoLocal);

                    if (isMismatch) {
                        localStorage.removeItem('pda_premium_token');
                        window.location.reload();
                    } else if (!isPremium) {
                        // Reactivado remotamente -> Recargar para restaurar
                        window.location.reload();
                    }
                }
            } catch (e) { }
        };

        const sendHeartbeat = async () => {
            verifyStatus();
            try {
                const clientName = localStorage.getItem('business_name') || localStorage.getItem('restaurant_name') || '';
                await supabase.rpc('heartbeat_device', { p_device_id: deviceId, p_product_id: PRODUCT_ID, p_client_name: clientName });
            } catch (e) { }
        };

        // 1. Ejecutar heartbeat al montar y cada 4 horas
        sendHeartbeat();
        const heartbeatInterval = setInterval(sendHeartbeat, 4 * 60 * 60 * 1000);

        // 2. Poll de estado cada 1 minuto para revocaciones rapidas
        const statusInterval = setInterval(verifyStatus, 60 * 1000);

        // 3. Revisar apenas el usuario regrese a la app
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') verifyStatus();
        };
        document.addEventListener('visibilitychange', handleVisibility);

        // 4. Supabase Realtime para deteccion instantanea
        let subscription = null;
        try {
            subscription = supabase
                .channel(`licenses_sync_${deviceId}`)
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'licenses',
                    filter: `device_id=eq.${deviceId}`,
                }, () => {
                    verifyStatus();
                })
                .subscribe();
        } catch (e) { }

        return () => {
            clearInterval(heartbeatInterval);
            clearInterval(statusInterval);
            document.removeEventListener('visibilitychange', handleVisibility);
            if (subscription) subscription.unsubscribe();
        };
    }, [isPremium, deviceId]);

    // Countdown timer para demo
    useEffect(() => {
        if (!isDemo || !demoExpires) return;
        updateTimeLeft(demoExpires);
        const interval = setInterval(() => {
            const diff = demoExpires - Date.now();
            if (diff <= 0) {
                // Demo expiró en tiempo real
                clearInterval(interval);
                localStorage.removeItem('pda_premium_token');
                setIsPremium(false);
                setIsDemo(false);
                setDemoTimeLeft('');
                setDemoExpiredMsg("Tu licencia temporal ha finalizado. Esperamos que hayas disfrutado la experiencia completa.");
            } else {
                updateTimeLeft(demoExpires);
            }
        }, 60000); // Cada minuto
        return () => clearInterval(interval);
    }, [isDemo, demoExpires, updateTimeLeft]);

    // FIX 4: Integrity check periódico cada 30 minutos
    useEffect(() => {
        if (!deviceId) return;
        const interval = setInterval(async () => {
            const raw = localStorage.getItem('pda_premium_token');

            // Si localStorage fue borrado, intentar restaurar desde servidor
            if (!raw) {
                try {
                    const { data: remoteLicense } = await supabase
                        .from('licenses')
                        .select('type, active, expires_at')
                        .eq('device_id', deviceId)
                        .eq('product_id', PRODUCT_ID)
                        .maybeSingle();

                    if (remoteLicense?.active === true) {
                        // Restaurar desde servidor
                        window.location.reload();
                        return;
                    }
                } catch { }
                // Si no hay licencia activa en servidor y estaba premium → revocar
                if (isPremium) {
                    setIsPremium(false);
                    setIsDemo(false);
                    window.location.reload();
                }
                return;
            }

            // Verificar integridad del token almacenado
            if (raw) {
                try {
                    const token = decodeToken(raw);
                    const obj = JSON.parse(token);
                    // Si es demo y ya expiró
                    if (obj?.type === 'demo7' && obj?.expires && Date.now() >= obj.expires) {
                        localStorage.removeItem('pda_premium_token');
                        setIsPremium(false);
                        setIsDemo(false);
                        window.location.reload();
                    }
                } catch {
                    // Token corrupto → verificar contra servidor
                    if (isPremium) {
                        localStorage.removeItem('pda_premium_token');
                        setIsPremium(false);
                        setIsDemo(false);
                        window.location.reload();
                    }
                }
            }
        }, 30 * 60 * 1000); // 30 minutos

        return () => clearInterval(interval);
    }, [deviceId, isPremium]);

    const checkLicense = async (currentDeviceId) => {
        // FIX 2: Decodificar token ofuscado
        const rawStored = localStorage.getItem('pda_premium_token');
        const storedToken = rawStored ? decodeToken(rawStored) : null;

        if (!storedToken) {
            // Fallback: verificar si existe licencia activa en Supabase (ej: reactivada remotamente)
            try {
                const { data: remoteLicense, error } = await supabase
                    .from('licenses')
                    .select('type, active, expires_at, code')
                    .eq('device_id', currentDeviceId)
                    .eq('product_id', PRODUCT_ID)
                    .maybeSingle();

                if (remoteLicense && remoteLicense.active === true) {
                    const isTimeLimited = (remoteLicense.type === 'demo7');
                    const expiresAt = remoteLicense.expires_at ? new Date(remoteLicense.expires_at).getTime() : null;

                    if (isTimeLimited && expiresAt) {
                        if (Date.now() < expiresAt) {
                            const token = { deviceId: currentDeviceId, type: 'demo7', expires: expiresAt, isDemo: true };
                            localStorage.setItem('pda_premium_token', encodeToken(JSON.stringify(token)));
                            setIsPremium(true);
                            setIsDemo(true);
                            setDemoExpires(expiresAt);
                        }
                    } else if (remoteLicense.type === 'permanent') {
                        // Permanente — restaurar token con datos del servidor
                        const token = { deviceId: currentDeviceId, type: 'permanent', code: remoteLicense.code };
                        localStorage.setItem('pda_premium_token', encodeToken(JSON.stringify(token)));
                        setIsPremium(true);
                        setIsDemo(false);
                    }
                    setLoading(false);
                    return;
                }
            } catch (e) {
                // Sin red — no se puede restaurar
            }

            setIsPremium(false);
            setLoading(false);
            return;
        }

        let isPremiumConfirmed = false;
        let confirmedDemo = false;
        let confirmedExpires = null;

        try {
            const tokenObj = JSON.parse(storedToken);
            if (tokenObj && tokenObj.deviceId === currentDeviceId) {
                // Token belongs to this device
                const isTimeLimited = tokenObj.type === 'demo7' || tokenObj.isDemo; // retrocompatibilidad
                // Verificar estado remoto antes de confiar en el token local
                let revokedRemotely = false;
                try {
                    const { data: remoteLicense } = await supabase
                        .from('licenses')
                        .select('active, expires_at')
                        .eq('device_id', currentDeviceId)
                        .eq('product_id', PRODUCT_ID)
                        .maybeSingle();

                    if (remoteLicense && remoteLicense.active === false) {
                        revokedRemotely = true;
                    }
                } catch (e) { /* Sin red → confiar en token local */ }

                if (revokedRemotely) {
                    localStorage.removeItem('pda_premium_token');
                    setIsPremium(false);
                    setIsDemo(false);
                    setDemoExpiredMsg("Tu licencia ha sido desactivada por el administrador.");
                    setLoading(false);
                    return;
                }

                if (isTimeLimited) {
                    if (Date.now() < tokenObj.expires) {
                        setIsPremium(true);
                        setIsDemo(true);
                        setDemoExpires(tokenObj.expires);
                        isPremiumConfirmed = true;
                        confirmedDemo = true;
                        confirmedExpires = tokenObj.expires;
                    } else {
                        console.warn("Demo Expirada");
                        localStorage.removeItem('pda_premium_token');
                        setIsPremium(false);
                        setIsDemo(false);
                        setDemoExpiredMsg("Tu licencia temporal ha finalizado. Esperamos que hayas disfrutado la experiencia completa.");
                    }
                } else {
                    // Permanente
                    setIsPremium(true);
                    setIsDemo(false);
                    isPremiumConfirmed = true;
                }
            } else {
                setIsPremium(false);
            }
        } catch (e) {
            // Unparseable token or old string format (Lifetime License legacy)
            setIsPremium(false);
        }

        // FIX 5: Guardar backup en sessionStorage si licencia válida
        if (isPremiumConfirmed) {
            try {
                sessionStorage.setItem(
                    '_pda_s',
                    encodeToken('VALID_SESSION:' + currentDeviceId)
                );
            } catch { }
        }

        // Migración silenciosa: asegurar registro en Supabase via RPC seguro
        if (isPremiumConfirmed) {
            const migrateToSupabase = async () => {
                try {
                    // Registrar dispositivo si no existe (RPC seguro, no INSERT directo)
                    const clientName = localStorage.getItem('business_name') || localStorage.getItem('restaurant_name') || '';
                    await supabase.rpc('auto_register_device', {
                        p_device_id: currentDeviceId,
                        p_product_id: PRODUCT_ID,
                        p_client_name: clientName
                    });
                    // Enviar heartbeat para actualizar last_seen
                    await supabase.rpc('heartbeat_device', {
                        p_device_id: currentDeviceId,
                        p_product_id: PRODUCT_ID,
                        p_client_name: clientName
                    });
                } catch (e) {
                    // Silencioso — nunca afecta la app
                }
            }

            migrateToSupabase()  // llamar sin await para no bloquear
        }

        setLoading(false);
    };

    /**
     * Activa la demo de 7 días sin necesidad de código.
     * Solo puede usarse UNA VEZ por dispositivo.
     */
    const activateDemo = async () => {
        // FIX 3: Verificar demo en IndexedDB (local)
        const demoRecord = await storageService.getItem('pda_demo_flag_v1', null);
        if (demoRecord?.used) {
            return { success: false, status: 'DEMO_USED' };
        }

        const currentDeviceId = deviceId || localStorage.getItem('pda_device_id');

        // Verificar en servidor (por si borraron IndexedDB)
        try {
            const { data: existingDemo } = await supabase
                .from('licenses')
                .select('id, type')
                .eq('device_id', currentDeviceId)
                .eq('product_id', PRODUCT_ID)
                .neq('type', 'registered')
                .maybeSingle();

            if (existingDemo) {
                await storageService.setItem('pda_demo_flag_v1', {
                    used: true,
                    ts: Date.now(),
                    deviceId: currentDeviceId,
                });
                return { success: false, status: 'DEMO_USED' };
            }
        } catch (e) {
            // Sin red → solo validar local
        }

        const expires = Date.now() + DEMO_DURATION_MS;
        const demoToken = {
            deviceId: currentDeviceId,
            type: 'demo7',
            expires: expires,
        };

        // FIX 2: Guardar token ofuscado
        localStorage.setItem('pda_premium_token', encodeToken(JSON.stringify(demoToken)));

        // FIX 3: Guardar flag en IndexedDB
        await storageService.setItem('pda_demo_flag_v1', {
            used: true,
            ts: Date.now(),
            deviceId: currentDeviceId,
        });

        setIsPremium(true);
        setIsDemo(true);
        setDemoExpires(expires);
        setDemoUsed(true);

        // Reportar demo a Supabase via RPC seguro (silencioso)
        try {
            await supabase.rpc('activate_demo_secure', {
                p_device_id: currentDeviceId,
                p_product_id: PRODUCT_ID
            });
        } catch (e) {
            // Nunca bloquear si falla la red
        }

        return { success: true, status: 'DEMO_ACTIVATED' };
    };

    /**
     * Desbloquea con código de activación.
     * Consulta Supabase para determinar si es permanente o temporal (7/30 días).
     */
    const unlockApp = async (inputCode) => {
        try {
            const cleanCode = (inputCode || "").trim();
            // FIX: Validar el código directamente contra la base de datos para ignorar fallos de Edge Functions
            const { data: license, error } = await supabase
                .from('licenses')
                .select('type, active, expires_at, code')
                .eq('device_id', deviceId)
                .eq('product_id', PRODUCT_ID)
                .maybeSingle();

            if (error || !license || license.code !== cleanCode) {
                return { success: false, status: 'INVALID_CODE' };
            }

            const { type, active, expires_at } = license;
            
            if (!active) {
                return { success: false, status: 'LICENSE_REVOKED' };
            }

            const isTimeLimited = (type === 'demo7');
            let expiresAt = expires_at ? new Date(expires_at).getTime() : null;

            if (isTimeLimited) {
                if (!expiresAt) {
                    expiresAt = Date.now() + 168 * 60 * 60 * 1000;
                    try {
                        supabase.from('licenses').update({ expires_at: new Date(expiresAt).toISOString() })
                            .eq('device_id', deviceId).eq('product_id', PRODUCT_ID).then();
                    } catch (e) { }
                }

                const token = { deviceId, code: inputCode, type: 'demo7', expires: expiresAt };
                localStorage.setItem('pda_premium_token', encodeToken(JSON.stringify(token)));
                setIsPremium(true);
                setIsDemo(true);
                setDemoExpires(expiresAt);
                return { success: true, status: 'PREMIUM_ACTIVATED' };
            }

            // Permanente
            const token = { deviceId, code: inputCode, type: 'permanent' };
            localStorage.setItem('pda_premium_token', encodeToken(JSON.stringify(token)));
            setIsPremium(true);
            setIsDemo(false);
            return { success: true, status: 'PREMIUM_ACTIVATED' };
            
        } catch (err) {
            console.error('Error validating license:', err);
            return { success: false, status: 'SERVER_ERROR' };
        }
    };

    const generateCodeForClient = async () => null;

    /**
     * Fuerza un heartbeat manual para sincronizar cambios como el nombre del negocio de inmediato.
     */
    const forceHeartbeat = async () => {
        const clientName = localStorage.getItem('business_name') || localStorage.getItem('restaurant_name') || '';
        try {
            await supabase.rpc('heartbeat_device', {
                p_device_id: deviceId || localStorage.getItem('pda_device_id'),
                p_product_id: PRODUCT_ID,
                p_client_name: clientName
            });
        } catch(e) {
            console.error('Error forcing heartbeat:', e);
        }
    };

    return {
        deviceId,
        isPremium,
        loading,
        unlockApp,
        activateDemo,
        generateCodeForClient,
        isDemo,
        demoExpires,
        demoTimeLeft,
        demoExpiredMsg,
        dismissExpiredMsg: () => setDemoExpiredMsg(''),
        // FIX 3: demoUsed desde estado (IndexedDB)
        demoUsed,
        forceHeartbeat,
    };
}

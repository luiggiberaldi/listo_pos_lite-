import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { logEvent } from '../services/auditService';

export function useAutoLock() {
    const { usuarioActivo, logout, requireLogin } = useAuthStore();
    const adminEmail = useAuthStore(s => s.adminEmail);
    const adminPassword = useAuthStore(s => s.adminPassword);
    const isCloudConfigured = Boolean(adminEmail);
    // El auto-lock solo tiene sentido si hay cuenta cloud Y requireLogin está activo.
    // Sin cloud no hay LockScreen que mostrar → nunca bloquear.
    const isLoginRequired = (requireLogin ?? false) && isCloudConfigured;
    const timeoutRef = useRef(null);

    const performLock = useCallback((reason = 'manual') => {
        if (!isLoginRequired) return; // Sin cloud o sin PIN → nunca bloquear
        if (!usuarioActivo || usuarioActivo.rol !== 'ADMIN') return;
        
        logEvent('AUTH', 'SESION_BLOQUEADA', `Bloqueo de seguridad: ${reason}`, usuarioActivo);
        logout();
    }, [usuarioActivo, logout, isLoginRequired]);

    const resetTimer = useCallback(() => {
        if (!isLoginRequired || !usuarioActivo || usuarioActivo.rol !== 'ADMIN') {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            return;
        }

        // Obtener timeout en minutos desde config, por defecto 3 min
        const minutesStr = localStorage.getItem('admin_auto_lock_minutes') || '3';
        const minutes = parseInt(minutesStr, 10);
        // Minimum timeout 1 minute
        const ms = (isNaN(minutes) || minutes < 1 ? 3 : minutes) * 60 * 1000;

        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
            performLock('inactividad');
        }, ms);
    }, [usuarioActivo, performLock]);

    useEffect(() => {
        // Solo importa si es ADMIN y el login es requerido
        if (!isLoginRequired || !usuarioActivo || usuarioActivo.rol !== 'ADMIN') {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            return;
        }

        const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
        
        // Función debounced para no saturar el event loop en scroll/mouse move
        let tick = false;
        const throttledResetTimer = () => {
            if (!tick) {
                requestAnimationFrame(() => {
                    resetTimer();
                    tick = false;
                });
                tick = true;
            }
        };

        events.forEach(e => window.addEventListener(e, throttledResetTimer, { passive: true }));

        const handleVisibilityChange = () => {
            if (document.hidden) {
                // Suspender sesión automáticamente si minimiza la app (ADMIN only)
                performLock('app_minimizada');
            } else {
                resetTimer();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        resetTimer(); // Iniciar on mount

        return () => {
            events.forEach(e => window.removeEventListener(e, throttledResetTimer));
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [usuarioActivo, resetTimer, performLock]);

    return { manualLock: () => performLock('manual') };
}

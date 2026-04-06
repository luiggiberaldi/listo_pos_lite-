import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logEvent } from '../../services/auditService';

const DEFAULT_USERS = [
    { id: 1, nombre: 'Administrador', rol: 'ADMIN', pin: '123456' },
    { id: 2, nombre: 'Cajero', rol: 'CAJERO', pin: '0000' }
];

export const useAuthStore = create(
    persist(
        (set, get) => ({
            usuarioActivo: (() => {
                try {
                    const saved = localStorage.getItem('abasto-device-session');
                    return saved ? JSON.parse(saved) : null;
                } catch { return null; }
            })(),
            usuarios: DEFAULT_USERS,
            requireLogin: false, // Login opcional, por defecto desactivado
            adminEmail: '',
            adminPassword: '',


            // ACCIONES
            login: async (pinInput, userId) => {
                // Simular un pequeño retardo para feedback visual (UX)
                await new Promise(r => setTimeout(r, 400));
                
                const { usuarios } = get();
                
                let userEncontrado;
                
                if (userId) {
                    userEncontrado = usuarios.find(u => u.id === userId && u.pin === pinInput);
                } else {
                    userEncontrado = usuarios.find(u => u.pin === pinInput);
                }

                if (userEncontrado) {
                    set({ usuarioActivo: userEncontrado });
                    localStorage.setItem('abasto-device-session', JSON.stringify(userEncontrado));
                    logEvent('AUTH', 'LOGIN', `${userEncontrado.nombre} inicio sesion`, userEncontrado);
                    return true;
                }
                
                return false;
            },

            logout: () => {
                const { usuarioActivo } = get();
                if (usuarioActivo) logEvent('AUTH', 'LOGOUT', `${usuarioActivo.nombre} cerro sesion`, usuarioActivo);
                set({ usuarioActivo: null });
                localStorage.removeItem('abasto-device-session');
            },

            cambiarPin: (userId, nuevoPin) => {
                set((state) => ({
                    usuarios: state.usuarios.map(u => 
                        u.id === userId ? { ...u, pin: nuevoPin } : u
                    )
                }));
                
                // Si el usuario que cambió el PIN es el activo, actualizar su sesión local
                const { usuarioActivo } = get();
                if (usuarioActivo && usuarioActivo.id === userId) {
                    const nuevoActivo = { ...usuarioActivo, pin: nuevoPin };
                    set({ usuarioActivo: nuevoActivo });
                    localStorage.setItem('abasto-device-session', JSON.stringify(nuevoActivo));
                }
                const target = get().usuarios.find(u => u.id === userId);
                logEvent('AUTH', 'PIN_CAMBIADO', `PIN cambiado para ${target?.nombre || 'usuario'}`, get().usuarioActivo);
            },

            agregarUsuario: (nombre, rol, pin) => {
                set((state) => {
                    const maxId = state.usuarios.reduce((max, u) => Math.max(max, u.id), 0);
                    return {
                        usuarios: [...state.usuarios, { id: maxId + 1, nombre, rol, pin }]
                    };
                });
                logEvent('USUARIO', 'USUARIO_CREADO', `Usuario "${nombre}" (${rol}) creado`, get().usuarioActivo);
            },

            eliminarUsuario: (userId) => {
                const { usuarios, usuarioActivo } = get();
                // No permitir eliminar al último ADMIN
                const admins = usuarios.filter(u => u.rol === 'ADMIN');
                const target = usuarios.find(u => u.id === userId);
                if (target?.rol === 'ADMIN' && admins.length <= 1) return false;
                // No permitir eliminarse a sí mismo
                if (usuarioActivo?.id === userId) return false;
                
                set({ usuarios: usuarios.filter(u => u.id !== userId) });
                logEvent('USUARIO', 'USUARIO_ELIMINADO', `Usuario "${target.nombre}" (${target.rol}) eliminado`, usuarioActivo);
                return true;
            },

            editarUsuario: (userId, datos) => {
                set((state) => ({
                    usuarios: state.usuarios.map(u => 
                        u.id === userId ? { ...u, ...datos } : u
                    )
                }));
                const { usuarioActivo } = get();
                if (usuarioActivo && usuarioActivo.id === userId) {
                    const nuevoActivo = { ...usuarioActivo, ...datos };
                    set({ usuarioActivo: nuevoActivo });
                    localStorage.setItem('abasto-device-session', JSON.stringify(nuevoActivo));
                }
            },

            setRequireLogin: (val) => {
                set({ requireLogin: val });
                logEvent('CONFIG', 'LOGIN_REQUERIDO_MODIFICADO', `Login requerido establecido a ${val ? 'SI' : 'NO'}`);
            },

            setAdminCredentials: (email, password) => {
                set({ adminEmail: email, adminPassword: password });
                logEvent('CONFIG', 'CREDENCIALES_REMOTAS_ESTABLECIDAS', `Se ha registrado el acceso remoto para la cuenta administradora.`);
            }
        }),
        {
            name: 'abasto-auth-storage', // Nombre para localStorage
            version: 1,
            migrate: (persistedState, fromVersion) => {
                // v0 → v1: admin PIN cambia de 4 a 6 dígitos (1234 → 123456)
                if (fromVersion < 1 && persistedState?.usuarios) {
                    persistedState.usuarios = persistedState.usuarios.map(u =>
                        u.rol === 'ADMIN' && u.pin === '1234'
                            ? { ...u, pin: '123456' }
                            : u
                    );
                }
                return persistedState;
            },
            partialize: (state) => ({
                usuarios: state.usuarios,
                requireLogin: state.requireLogin,
                adminEmail: state.adminEmail,
                adminPassword: state.adminPassword
            }),
            storage: {
                getItem: (name) => {
                    const str = localStorage.getItem(name);
                    if (!str) return null;
                    try { return JSON.parse(str); } catch (e) { return null; }
                },
                setItem: (name, value) => {
                    localStorage.setItem(name, JSON.stringify(value));
                    // Disparar a la nube para P2P (Lazy import para evitar ciclos)
                    import('../useCloudSync').then(({ pushCloudSync }) => {
                        pushCloudSync(name, value);
                    }).catch(err => console.warn('No se pudo inyectar Auth Cloud', err));
                },
                removeItem: (name) => localStorage.removeItem(name)
            }
        }
    )
);

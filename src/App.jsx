import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { Home, ShoppingCart, Store, Users, Download, FlaskConical, Key, Moon, Sun, BarChart3, WifiOff } from 'lucide-react';

import SalesView from './views/SalesView';
import DashboardView from './views/DashboardView';
import { ProductsView } from './views/ProductsView';

// Lazy-loaded views (no se usan al inicio)
const CustomersView = lazy(() => import('./views/CustomersView'));
const ReportsView = lazy(() => import('./views/ReportsView'));
const TesterView = lazy(() => import('./views/TesterView').then(m => ({ default: m.TesterView })));

import { useRates } from './hooks/useRates';
import { useSecurity } from './hooks/useSecurity';
import PremiumGuard from './components/security/PremiumGuard';
import TermsOverlay from './components/TermsOverlay';
import OnboardingOverlay from './components/OnboardingOverlay';
import ErrorBoundary from './components/ErrorBoundary';
import { useOfflineQueue } from './hooks/useOfflineQueue';

export default function App() {
  const [activeTab, setActiveTab] = useState('inicio');
  const [installPrompt, setInstallPrompt] = useState(null);

  // Admin Panel States
  const [adminClicks, setAdminClicks] = useState(0);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showTester, setShowTester] = useState(false);
  const [clientDeviceId, setClientDeviceId] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');

  const { rates, loading, isOffline, updateData } = useRates();
  const { generateCodeForClient, isPremium, isDemo, demoTimeLeft, demoExpiredMsg, dismissExpiredMsg } = useSecurity();
  const { isOnline, cacheRates } = useOfflineQueue();

  // Cache rates whenever they update
  useEffect(() => { if (rates) cacheRates(rates); }, [rates, cacheRates]);

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  };

  // Theme
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved;
      return 'light'; // Forced light mode by default for Bodega
    }
    return 'light';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  // Haptic
  const triggerHaptic = () => {
    if (typeof window !== 'undefined' && window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate(10);
    }
  };

  // Admin Panel Logic (Hidden — 10 clicks on top-left corner)
  const handleLogoClick = () => {
    const now = Date.now();
    if (window.lastClickTime && (now - window.lastClickTime > 1000)) {
      setAdminClicks(1);
    } else {
      setAdminClicks(prev => prev + 1);
    }
    window.lastClickTime = now;

    if (adminClicks + 1 >= 10) {
      setShowAdminPanel(true);
      setAdminClicks(0);
      triggerHaptic();
    }
  };

  const handleGenerateCode = async (e) => {
    e.preventDefault();
    if (!clientDeviceId) return;
    const code = await generateCodeForClient(clientDeviceId);
    setGeneratedCode(code);
  };

  // Keyboard detection
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const baseHeight = useRef(0);

  useEffect(() => {
    if (!window.visualViewport) return;
    if (!baseHeight.current) baseHeight.current = window.visualViewport.height;

    const handleViewport = () => {
      setIsKeyboardOpen(window.visualViewport.height < baseHeight.current - 100);
    };
    const handleFocusBack = () => setTimeout(handleViewport, 300);

    window.visualViewport.addEventListener('resize', handleViewport);
    window.visualViewport.addEventListener('scroll', handleViewport);
    window.addEventListener('focusin', handleFocusBack);
    window.addEventListener('focusout', handleFocusBack);

    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewport);
      window.visualViewport?.removeEventListener('scroll', handleViewport);
      window.removeEventListener('focusin', handleFocusBack);
      window.removeEventListener('focusout', handleFocusBack);
    };
  }, []);

  const TABS = [
    { id: 'inicio', label: 'Inicio', icon: Home },
    { id: 'ventas', label: 'Vender', icon: ShoppingCart },
    { id: 'catalogo', label: 'Inventario', icon: Store },
    { id: 'clientes', label: 'Clientes', icon: Users },
    { id: 'reportes', label: 'Reportes', icon: BarChart3 },
  ];

  return (
    <div className="font-sans antialiased bg-slate-50 dark:bg-black h-[100dvh] flex flex-col overflow-hidden transition-colors duration-300">

      {/* Terms and Conditions Overlay (First Use) */}
      <TermsOverlay />

      {/* Tutorial Onboarding (First Use, after Terms) */}
      <OnboardingOverlay isPremium={isPremium} />

      {/* Offline Banner */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[200] flex justify-center pt-[env(safe-area-inset-top)]">
          <div className="mt-2 px-4 py-2 bg-slate-900/95 backdrop-blur-md rounded-full border border-red-500/30 shadow-xl flex items-center gap-2 animate-in slide-in-from-top-4">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <WifiOff size={14} className="text-red-400" />
            <span className="text-xs font-bold text-white">Sin conexión · Modo offline</span>
          </div>
        </div>
      )}

      {/* Demo Banner (discreto — bottom, above nav) */}
      {isDemo && demoTimeLeft && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-4 fade-in duration-500 pointer-events-none">
          <div className="px-3 py-1.5 bg-slate-900/90 dark:bg-white/10 backdrop-blur-md rounded-full border border-white/10 shadow-xl flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div>
            <p className="text-[10px] font-semibold text-white tracking-wide">
              Licencia: <span className="text-amber-400 font-bold">{demoTimeLeft}</span>
            </p>
          </div>
        </div>
      )}

      {/* Demo Expired Modal */}
      {demoExpiredMsg && (
        <div className="fixed inset-0 z-[9999] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-5 animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-900 rounded-[2rem] p-8 max-w-sm shadow-2xl border border-slate-100 dark:border-slate-800 text-center animate-in zoom-in-95 duration-300">
            <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">⏳</span>
            </div>
            <h2 className="text-xl font-black text-slate-900 dark:text-white mb-2">Prueba finalizada</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5 leading-relaxed">
              {demoExpiredMsg}
            </p>
            <button
              onClick={() => {
                const msg = `Hola! Quiero adquirir la licencia Premium de PreciosAlDía. Acabo de terminar mi prueba gratuita.`;
                window.open(`https://wa.me/584124051793?text=${encodeURIComponent(msg)}`, '_blank');
              }}
              className="w-full py-3 bg-[#10B981] text-white font-bold rounded-xl shadow-lg shadow-emerald-500/20 active:scale-95 transition-transform text-sm mb-2"
            >
              Solicitar Licencia
            </button>
            <button
              onClick={dismissExpiredMsg}
              className="w-full py-2.5 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors"
            >
              Continuar con versión gratuita
            </button>
          </div>
        </div>
      )}

      {/* Golden Tester View Overlay */}
      {showTester && (
        <div className="fixed inset-0 z-[150] bg-slate-50 dark:bg-slate-950">
          <TesterView onBack={() => setShowTester(false)} />
        </div>
      )}

      <main className={`flex-1 min-h-0 w-full max-w-md md:max-w-3xl lg:max-w-7xl mx-auto relative ${activeTab === 'ventas' ? 'pb-0' : isKeyboardOpen ? 'pb-4' : 'pb-24'} flex flex-col ${activeTab === 'ventas' ? 'overflow-hidden' : 'overflow-y-auto'}`}>

        {/* Hidden Admin Trigger Area */}
        <div
          className="absolute top-0 left-0 w-20 h-20 z-50 cursor-pointer opacity-0"
          onClick={handleLogoClick}
          title="Ssshh..."
        ></div>

        {/* Eager views — always mounted, visibility toggled via CSS */}
        <div className={`flex-1 min-h-0 flex flex-col ${activeTab === 'ventas' ? 'animate-view-enter' : 'hidden'}`}>
          <ErrorBoundary>
            <PremiumGuard featureName="Punto de Venta" isShop={true}>
              <SalesView rates={rates} triggerHaptic={triggerHaptic} onNavigate={setActiveTab} />
            </PremiumGuard>
          </ErrorBoundary>
        </div>

        <div className={`flex-1 flex flex-col ${activeTab === 'catalogo' ? 'animate-view-enter' : 'hidden'}`}>
          <ErrorBoundary>
            <ProductsView rates={rates} triggerHaptic={triggerHaptic} />
          </ErrorBoundary>
        </div>

        <div className={`flex-1 flex flex-col ${activeTab === 'inicio' ? 'animate-view-enter' : 'hidden'}`}>
          <ErrorBoundary>
            <DashboardView rates={rates} triggerHaptic={triggerHaptic} onNavigate={setActiveTab} theme={theme} toggleTheme={toggleTheme} />
          </ErrorBoundary>
        </div>

        {/* Lazy views — mount on first access, then stay persistent */}
        <Suspense fallback={<div className="flex-1 p-4 space-y-4"><div className="skeleton h-10 w-40" /><div className="skeleton h-32" /><div className="skeleton h-48" /></div>}>
          {(activeTab === 'clientes' || document.querySelector('[data-view="clientes"]')) && (
            <div data-view="clientes" className={`flex-1 flex flex-col ${activeTab === 'clientes' ? 'animate-view-enter' : 'hidden'}`}>
              <ErrorBoundary>
                <PremiumGuard featureName="Gestión de Clientes">
                  <CustomersView triggerHaptic={triggerHaptic} />
                </PremiumGuard>
              </ErrorBoundary>
            </div>
          )}
          {(activeTab === 'reportes' || document.querySelector('[data-view="reportes"]')) && (
            <div data-view="reportes" className={`flex-1 flex flex-col ${activeTab === 'reportes' ? 'animate-view-enter' : 'hidden'}`}>
              <ErrorBoundary>
                <PremiumGuard featureName="Reportes Históricos">
                  <ReportsView rates={rates} triggerHaptic={triggerHaptic} />
                </PremiumGuard>
              </ErrorBoundary>
            </div>
          )}
        </Suspense>
      </main>

      {/* Bottom Nav — hidden in POS mode for full-screen selling */}
      {!isKeyboardOpen && activeTab !== 'ventas' && (
        <div className="fixed bottom-0 left-0 right-0 px-6 pb-[env(safe-area-inset-bottom)] pt-0 mb-6 max-w-md md:max-w-lg mx-auto z-30 pointer-events-none animate-in slide-in-from-bottom-4 duration-300">
          <div className="bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-xl rounded-3xl p-1.5 flex justify-between items-center shadow-2xl shadow-slate-900/30 border border-white/10 ring-1 ring-black/5 pointer-events-auto">
            {TABS.map(tab => (
              <TabButton
                key={tab.id}
                icon={<tab.icon size={20} strokeWidth={activeTab === tab.id ? 3 : 2} />}
                label={tab.label}
                isActive={activeTab === tab.id}
                onClick={() => { triggerHaptic(); setActiveTab(tab.id); }}
              />
            ))}

            {installPrompt && activeTab === 'inicio' && (
              <button onClick={() => { triggerHaptic(); handleInstall(); }} className="flex-1 flex flex-col items-center justify-center gap-1 py-3 rounded-2xl transition-all duration-300 bg-emerald-500 text-white shadow-md animate-pulse">
                <Download size={20} strokeWidth={3} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Admin Panel Modal */}
      {showAdminPanel && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-sm rounded-2xl p-6 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Key className="text-amber-500" /> Admin Gen
              </h2>
              <button onClick={() => setShowAdminPanel(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleGenerateCode}>
              <label className="block text-xs uppercase text-slate-500 font-bold mb-2">ID del Cliente</label>
              <input
                type="text"
                value={clientDeviceId}
                onChange={e => setClientDeviceId(e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white mb-4 font-mono uppercase"
                placeholder="PDA-XXXX"
              />
              <button className="w-full bg-amber-500 hover:bg-amber-600 text-black font-bold py-3 rounded-lg mb-4">
                Generar Código
              </button>
            </form>

            <button
              onClick={() => { triggerHaptic(); setShowTester(true); setShowAdminPanel(false); }}
              className="w-full bg-indigo-600/20 border border-indigo-500/50 text-indigo-400 font-bold py-2 rounded-lg text-xs uppercase tracking-tighter hover:bg-indigo-600/30 transition-colors"
            >
              🚀 Abrir Tester
            </button>

            {generatedCode && (
              <div className="mt-4 bg-green-900/30 border border-green-500/50 p-4 rounded-lg text-center">
                <p className="text-xs text-green-400 mb-1">Código Generado:</p>
                <p className="text-xl font-mono font-bold text-white tracking-widest selectable select-all">
                  {generatedCode}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

function TabButton({ icon, label, isActive, onClick }) {
  return (
    <button onClick={onClick} className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 rounded-2xl transition-all duration-300 ${isActive ? 'bg-emerald-500 text-white shadow-md' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>
      {icon}
      {isActive && <span className="text-[9px] font-extrabold animate-in zoom-in duration-200">{label}</span>}
    </button>
  );
}
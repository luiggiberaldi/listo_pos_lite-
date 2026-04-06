import React, { useState, useRef, useEffect } from 'react';
import { X, Delete, Loader2 } from 'lucide-react';
import LoginAvatar from './LoginAvatar';

const getPinLength = (rol) => rol === 'ADMIN' ? 6 : 4;

export default function LoginPinModal({ isOpen, onClose, user, onSubmit }) {
  const PIN_LENGTH = getPinLength(user?.rol);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [processing, setProcessing] = useState(false);
  const inputRef = useRef(null);

  // Detectar si es dispositivo táctil (móvil/tablet)
  const isTouchDevice = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  // Focus el input invisible al abrir — solo en PC (no en móvil para no abrir teclado nativo)
  useEffect(() => {
    if (isOpen) {
      setPin('');
      setError(false);
      if (!isTouchDevice()) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  }, [isOpen]);

  // Auto-submit cuando se completan los 4 dígitos
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !processing) {
      handleSubmit();
    }
  }, [pin]);

  const handleSubmit = async () => {
    if (pin.length !== PIN_LENGTH || processing) return;
    setProcessing(true);

    const success = await onSubmit(pin, user?.id);

    if (!success) {
      setError(true);
      setPin('');
      setProcessing(false);
      setTimeout(() => setError(false), 600);
      if (!isTouchDevice()) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
    // Si fue exitoso, el componente padre cierra el modal
  };

  const handlePadPress = (digit) => {
    if (pin.length >= PIN_LENGTH || processing) return;
    setPin(prev => prev + digit);
  };

  const handleDelete = () => {
    if (processing) return;
    setPin(prev => prev.slice(0, -1));
  };

  if (!isOpen || !user) return null;

  const userName = (user.nombre || 'Usuario').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div
        className="relative bg-white rounded-3xl p-8 w-full max-w-sm mx-4 shadow-2xl border border-slate-200 animate-in zoom-in-95 duration-300"
        onClick={e => e.stopPropagation()}
      >
        {/* Cerrar */}
        <button onClick={onClose} className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 transition-colors rounded-full hover:bg-slate-100">
          <X size={20} />
        </button>

        {/* Avatar + Nombre */}
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <LoginAvatar user={user} />
          </div>
          <h2 className="text-xl font-bold text-slate-800">{userName}</h2>
          <p className="text-xs text-slate-500 mt-1">Ingresa tu PIN de {PIN_LENGTH} dígitos</p>
        </div>

        {/* PIN Dots */}
        <div className={`flex justify-center gap-3 mb-8 ${error ? 'animate-shake' : ''}`}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition-all duration-200 ${
                error
                  ? 'bg-red-500 border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'
                  : i < pin.length
                    ? 'bg-sky-500 border-sky-500 shadow-[0_0_10px_rgba(14,165,233,0.4)] scale-110'
                    : 'bg-transparent border-slate-300'
              }`}
            />
          ))}
        </div>

        {/* Input invisible para teclado físico (PC) — en móvil no recibe focus para no abrir teclado nativo */}
        <input
          ref={inputRef}
          type="tel"
          maxLength={PIN_LENGTH}
          value={pin}
          onChange={e => {
            const val = e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
            setPin(val);
          }}
          className="absolute opacity-0 w-0 h-0"
          autoComplete="off"
          inputMode="numeric"
          readOnly={isTouchDevice()}
        />

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3 max-w-[280px] mx-auto">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
            <button
              key={n}
              onClick={() => handlePadPress(String(n))}
              className="h-14 rounded-xl bg-slate-50 text-slate-800 text-xl font-bold hover:bg-slate-100 active:scale-95 active:bg-sky-50 transition-all duration-150 border border-slate-200 shadow-sm"
            >
              {n}
            </button>
          ))}
          {/* Fila inferior */}
          <div /> {/* Espacio vacio */}
          <button
            onClick={() => handlePadPress('0')}
            className="h-14 rounded-xl bg-slate-50 text-slate-800 text-xl font-bold hover:bg-slate-100 active:scale-95 active:bg-sky-50 transition-all duration-150 border border-slate-200 shadow-sm"
          >
            0
          </button>
          <button
            onClick={handleDelete}
            className="h-14 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 active:scale-95 transition-all duration-150 border border-slate-200 shadow-sm"
          >
            <Delete size={22} />
          </button>
        </div>

        {/* Processing */}
        {processing && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm rounded-3xl flex items-center justify-center">
            <Loader2 className="animate-spin text-sky-500" size={32} />
          </div>
        )}
      </div>

      {/* Shake Animation */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-10px); }
          40% { transform: translateX(10px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
        .animate-shake { animation: shake 0.4s ease-in-out; }
      `}</style>
    </div>
  );
}

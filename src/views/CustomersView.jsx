import { useState, useEffect } from 'react';
import { Users, Plus, Search, User, X, Trash2, Pencil, Phone, RefreshCw, Save, ArrowDownRight, ArrowUpRight, Clock, CheckCircle2, CreditCard, ShoppingBag } from 'lucide-react';
import { storageService } from '../utils/storageService';
import { showToast } from '../components/Toast';
import { formatBs, formatUsd } from '../utils/calculatorUtils';
import { procesarImpactoCliente } from '../utils/financialLogic';
import { DEFAULT_PAYMENT_METHODS } from '../config/paymentMethods';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import SwipeableItem from '../components/SwipeableItem';

export default function CustomersView({ triggerHaptic }) {
    const [customers, setCustomers] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterType, setFilterType] = useState('all'); // 'all' | 'deuda' | 'favor'
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);

    // Modal de Abono / Crédito
    const [transactionModal, setTransactionModal] = useState({ isOpen: false, type: null, customer: null }); // type: 'ABONO' | 'CREDITO'
    const [transactionAmount, setTransactionAmount] = useState('');
    const [currencyMode, setCurrencyMode] = useState('BS'); // 'BS' | 'USD'
    const [paymentMethod, setPaymentMethod] = useState('efectivo_bs');
    const [resetBalanceCustomer, setResetBalanceCustomer] = useState(null);
    const [bcvRate, setBcvRate] = useState(0);
    const [expandedHistory, setExpandedHistory] = useState(null);
    const [historyData, setHistoryData] = useState([]);
    const [selectedCustomer, setSelectedCustomer] = useState(null);
    const [editingCustomer, setEditingCustomer] = useState(null);
    const [deleteCustomerTarget, setDeleteCustomerTarget] = useState(null);

    useEffect(() => {
        // Leer tasa BCV del storage para conversión
        storageService.getItem('bcv_rate_v1', 0).then(r => setBcvRate(Number(r) || 0));
    }, []);

    const loadCustomers = async () => {
        const saved = await storageService.getItem('bodega_customers_v1', []);
        setCustomers(saved);
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadCustomers();
    }, []);

    const saveCustomers = async (updatedCustomers) => {
        setCustomers(updatedCustomers);
        await storageService.setItem('bodega_customers_v1', updatedCustomers);
    };

    const filteredCustomers = customers.filter(c => {
        const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) || (c.phone && c.phone.includes(searchTerm));
        if (!matchesSearch) return false;
        if (filterType === 'deuda') return c.deuda > 0.01;
        if (filterType === 'favor') return c.deuda < -0.01;
        return true;
    });

    const toggleHistory = async (customerId) => {
        triggerHaptic && triggerHaptic();
        setExpandedHistory(customerId);
        const allSales = await storageService.getItem('bodega_sales_v1', []);
        const customerSales = allSales
            .filter(s => s.customerId === customerId || s.clienteId === customerId)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 20);
        setHistoryData(customerSales);
    };

    const handleResetBalance = async (customer) => {
        triggerHaptic();
        setResetBalanceCustomer(customer);
    };

    const confirmResetBalance = async () => {
        const customer = resetBalanceCustomer;
        if (!customer) return;

        const updatedCustomer = { ...customer, deuda: 0, favor: 0 };
        const newCustomers = customers.map(c => c.id === customer.id ? updatedCustomer : c);
        await saveCustomers(newCustomers);
        showToast(`Saldo reiniciado a cero para ${customer.name}`, 'success');
        setResetBalanceCustomer(null);
    };

    const handleTransaction = async () => {
        if (!transactionAmount || isNaN(transactionAmount) || parseFloat(transactionAmount) <= 0) return;

        triggerHaptic();

        // El sistema almacena todo en USD. Si el usuario ingresa Bs, lo convertimos a USD.
        const rawAmount = parseFloat(transactionAmount);
        const amountUsd = currencyMode === 'BS' && bcvRate > 0 ? rawAmount / bcvRate : rawAmount;
        const { type, customer } = transactionModal;

        // 1. Aplicar la Lógica Financiera de los Cuadrantes SIEMPRE EN USD
        let transaccionOpts = {};
        if (type === 'ABONO') {
            transaccionOpts = { costoTotal: 0, pagoReal: amountUsd, vueltoParaMonedero: amountUsd };
        } else if (type === 'CREDITO') {
            transaccionOpts = { esCredito: true, deudaGenerada: amountUsd };
        }

        const updatedCustomer = procesarImpactoCliente(customer, transaccionOpts);

        // 2. Guardar el Cliente actualizado
        const newCustomers = customers.map(c => c.id === customer.id ? updatedCustomer : c);
        await saveCustomers(newCustomers);

        // 3. Registrar "COBRO_DEUDA" en Ventas/Caja si es un Abono
        if (type === 'ABONO') {
            const sales = await storageService.getItem('bodega_sales_v1', []);

            // Calculamos Bs y Usd para el registro
            const totalEnBs = currencyMode === 'BS' ? rawAmount : (rawAmount * bcvRate);
            const totalEnUsd = currencyMode === 'USD' ? rawAmount : (bcvRate > 0 ? rawAmount / bcvRate : 0);

            const cobroRecord = {
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                tipo: 'COBRO_DEUDA', // Etiqueta clave Anti-Duplicados
                clienteId: customer.id,
                clienteName: customer.name,
                totalBs: totalEnBs,
                totalUsd: totalEnUsd,
                paymentMethod: paymentMethod,
                items: [{ name: `Abono de deuda: ${customer.name}`, qty: 1, priceUsd: totalEnUsd, costBs: 0 }]
            };
            sales.push(cobroRecord);
            await storageService.setItem('bodega_sales_v1', sales);
        }

        // Cerrar modal
        setTransactionModal({ isOpen: false, type: null, customer: null });
        setTransactionAmount('');
        setCurrencyMode('BS');
        setPaymentMethod('efectivo_bs');
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 p-3 sm:p-6 overflow-y-auto scrollbar-hide">
            {/* Header */}
            <div className="shrink-0 mb-5 flex justify-between items-start">
                <div>
                    <h2 className="text-2xl font-black text-slate-800 dark:text-white tracking-tight flex items-center gap-2">
                        <Users size={26} className="text-blue-500" /> Clientes
                    </h2>
                    <p className="text-sm text-slate-400 font-medium ml-1">
                        Deudas y Saldos a Favor
                    </p>
                </div>
                <button
                    onClick={() => { triggerHaptic(); setIsAddModalOpen(true); }}
                    className="p-3 bg-blue-500 text-white rounded-2xl shadow-sm hover:scale-105 active:scale-95 transition-all flex items-center gap-2"
                >
                    <Plus size={20} className="shrink-0" />
                    <span className="text-sm font-bold hidden sm:inline">Nuevo Cliente</span>
                </button>
            </div>

            {/* Búsqueda y Filtros */}
            <div className="mb-5 shrink-0 flex flex-col gap-3">
                <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                    <input
                        type="text"
                        placeholder="Buscar cliente..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl py-3.5 pl-11 pr-4 text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 shadow-sm"
                    />
                </div>
                {/* Filtros tipo Chips */}
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1">
                    <button 
                        onClick={() => { setFilterType('all'); triggerHaptic && triggerHaptic(); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${filterType === 'all' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'}`}
                    >
                        Todos
                    </button>
                    <button 
                        onClick={() => { setFilterType('deuda'); triggerHaptic && triggerHaptic(); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors flex items-center gap-1.5 ${filterType === 'deuda' ? 'bg-red-500 text-white shadow-sm shadow-red-500/30' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'}`}
                    >
                        <div className={`w-2 h-2 rounded-full ${filterType === 'deuda' ? 'bg-white' : 'bg-red-500'}`}></div>
                        Con Deuda
                    </button>
                    <button 
                        onClick={() => { setFilterType('favor'); triggerHaptic && triggerHaptic(); }}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors flex items-center gap-1.5 ${filterType === 'favor' ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'}`}
                    >
                        <div className={`w-2 h-2 rounded-full ${filterType === 'favor' ? 'bg-white' : 'bg-emerald-500'}`}></div>
                        Saldo a Favor
                    </button>
                </div>
            </div>

            {/* Listado de Clientes */}
            <div className="flex-1 space-y-3 pb-20">
                {customers.length === 0 ? (
                    <EmptyState
                        icon={Users}
                        title="Sin Clientes"
                        description="Registra a tus clientes habituales para llevar un control de sus fiados y saldos a favor."
                        actionLabel="NUEVO CLIENTE"
                        onAction={() => { triggerHaptic && triggerHaptic(); setIsAddModalOpen(true); }}
                    />
                ) : filteredCustomers.length === 0 ? (
                    <EmptyState
                        icon={Search}
                        title="Sin resultados"
                        description={`No encontramos ningún cliente con el término "${searchTerm}".`}
                        secondaryActionLabel="Limpiar Búsqueda"
                        onSecondaryAction={() => { setSearchTerm(''); triggerHaptic && triggerHaptic(); }}
                    />
                ) : (
                    filteredCustomers.map(customer => (
                        <SwipeableItem
                            key={customer.id}
                            onDelete={() => setDeleteCustomerTarget(customer)}
                            triggerHaptic={triggerHaptic}
                        >
                            <CustomerCard
                                customer={customer}
                                bcvRate={bcvRate}
                                onClick={() => {
                                    setSelectedCustomer(customer);
                                    toggleHistory(customer.id);
                                }}
                                onDelete={() => setDeleteCustomerTarget(customer)}
                            />
                        </SwipeableItem>
                    ))
                )}
            </div>

            {/* Modal para Agregar Cliente */}
            {
                isAddModalOpen && (
                    <AddCustomerModal
                        onClose={() => setIsAddModalOpen(false)}
                        onSave={async (newC) => {
                            const updated = [...customers, newC];
                            await saveCustomers(updated);
                            setIsAddModalOpen(false);
                        }}
                    />
                )
            }

            {/* Modal Unificado: Ajustar Cuenta */}
            {
                transactionModal.isOpen && (() => {
                    // Calcular preview del saldo resultante en tiempo real
                    const rawAmt = parseFloat(transactionAmount) || 0;
                    const amtUsd = currencyMode === 'BS' && bcvRate > 0 ? rawAmt / bcvRate : rawAmt;
                    const currentCustomer = transactionModal.customer;

                    let previewCustomer = null;
                    if (rawAmt > 0) {
                        const opts = transactionModal.type === 'ABONO'
                            ? { costoTotal: 0, pagoReal: amtUsd, vueltoParaMonedero: amtUsd }
                            : { esCredito: true, deudaGenerada: amtUsd };
                        previewCustomer = procesarImpactoCliente(currentCustomer, opts);
                    }

                    // Saldo actual legible
                    const saldoActualUsd = (currentCustomer.favor || 0) - (currentCustomer.deuda || 0);
                    const saldoPreviewUsd = previewCustomer ? (previewCustomer.favor || 0) - (previewCustomer.deuda || 0) : saldoActualUsd;

                    const formatSaldo = (val) => {
                        if (val > 0.001) return { text: `+$${formatUsd(val)}`, label: 'a favor', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30' };
                        if (val < -0.001) return { text: `-$${formatUsd(Math.abs(val))}`, label: 'debe', color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/30' };
                        return { text: '$0.00', label: 'al dia', color: 'text-slate-500', bg: 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700' };
                    };

                    const saldoActual = formatSaldo(saldoActualUsd);
                    const saldoPreview = formatSaldo(saldoPreviewUsd);

                    return (
                    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-3xl sm:rounded-3xl shadow-xl overflow-hidden animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200">
                            <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                                <h3 className="text-xl font-black text-slate-800 dark:text-white">Ajustar Cuenta</h3>
                                <button onClick={() => setTransactionModal({ isOpen: false, type: null, customer: null })} className="p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                                    <X size={20} />
                                </button>
                            </div>

                            <div className="p-5 space-y-4">
                                {/* Cliente + Saldo Actual */}
                                <div className="flex items-center justify-between">
                                    <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                                        <strong className="text-slate-900 dark:text-white">{currentCustomer.name}</strong>
                                    </p>
                                    <span className={`text-sm font-black ${saldoActual.color}`}>{saldoActual.text} <span className="text-[10px] font-bold opacity-70">({saldoActual.label})</span></span>
                                </div>

                                {/* Tipo de operacion */}
                                <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                                    <button
                                        type="button"
                                        onClick={() => { setTransactionModal(m => ({ ...m, type: 'CREDITO' })); setTransactionAmount(''); }}
                                        className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${transactionModal.type === 'CREDITO' ? 'bg-white dark:bg-slate-900 shadow-sm text-red-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                                    >
                                        <ArrowDownRight size={16} /> Agregar Deuda
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => { setTransactionModal(m => ({ ...m, type: 'ABONO' })); setTransactionAmount(''); }}
                                        className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${transactionModal.type === 'ABONO' ? 'bg-white dark:bg-slate-900 shadow-sm text-emerald-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                                    >
                                        <ArrowUpRight size={16} /> Recibir Abono
                                    </button>
                                </div>

                                {/* Moneda */}
                                <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                                    <button
                                        type="button"
                                        onClick={() => { setCurrencyMode('BS'); setTransactionAmount(''); }}
                                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${currencyMode === 'BS' ? 'bg-white dark:bg-slate-900 shadow-sm text-blue-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                                    >
                                        Bolivares (Bs)
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => { setCurrencyMode('USD'); setTransactionAmount(''); }}
                                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${currencyMode === 'USD' ? 'bg-white dark:bg-slate-900 shadow-sm text-emerald-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                                    >
                                        Dolares ($)
                                    </button>
                                </div>

                                {/* Input de monto */}
                                <div>
                                    <div className="relative">
                                        <span className={`absolute left-4 top-1/2 -translate-y-1/2 font-black text-lg ${currencyMode === 'BS' ? 'text-blue-500' : 'text-emerald-500'}`}>
                                            {currencyMode === 'BS' ? 'Bs' : '$'}
                                        </span>
                                        <input
                                            type="number"
                                            value={transactionAmount}
                                            onChange={(e) => setTransactionAmount(e.target.value)}
                                            placeholder="0.00"
                                            className={`w-full form-input bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-4 ${currencyMode === 'BS' ? 'pl-12' : 'pl-10'} text-2xl font-black text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500/50 transition-all`}
                                            autoFocus
                                        />
                                    </div>
                                    {/* Conversion info */}
                                    {currencyMode === 'BS' && transactionAmount && bcvRate > 0 && (
                                        <div className="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-lg p-2 mt-3 flex items-center justify-between">
                                            <span className="text-xs font-bold text-slate-500">Equivale a:</span>
                                            <span className="text-sm font-black text-blue-600 dark:text-blue-400">
                                                ${(parseFloat(transactionAmount) / bcvRate).toFixed(2)} USD
                                            </span>
                                        </div>
                                    )}
                                    {currencyMode === 'USD' && transactionAmount && bcvRate > 0 && (
                                        <div className="bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-lg p-2 mt-3 flex items-center justify-between">
                                            <span className="text-xs font-bold text-slate-500">Equivale a:</span>
                                            <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                                                {formatBs(parseFloat(transactionAmount) * bcvRate)} Bs
                                            </span>
                                        </div>
                                    )}
                                    {bcvRate > 0 && (
                                        <p className="text-[10px] font-medium text-slate-400 mt-2 text-center">Tasa BCV: {formatBs(bcvRate)} Bs/$</p>
                                    )}
                                </div>

                                {/* Metodo de pago (solo para abonos) */}
                                {transactionModal.type === 'ABONO' && (
                                    <div>
                                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Metodo de Pago</label>
                                        <select
                                            value={paymentMethod}
                                            onChange={(e) => setPaymentMethod(e.target.value)}
                                            className="w-full form-select bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-blue-500/50 transition-all"
                                        >
                                            {DEFAULT_PAYMENT_METHODS.map(method => (
                                                <option key={method.id} value={method.id}>
                                                    {method.icon} {method.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {/* PREVIEW del saldo resultante */}
                                {rawAmt > 0 && previewCustomer && (
                                    <div className={`border rounded-xl p-3 ${saldoPreview.bg} transition-all`}>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">Cuenta despues de esta operacion</p>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-slate-400 line-through">{saldoActual.text}</span>
                                                <span className="text-slate-300 dark:text-slate-600">→</span>
                                            </div>
                                            <span className={`text-lg font-black ${saldoPreview.color}`}>
                                                {saldoPreview.text}
                                            </span>
                                        </div>
                                        {bcvRate > 0 && (
                                            <p className="text-[10px] font-bold text-slate-400 mt-1 text-right">
                                                {saldoPreviewUsd >= 0 ? '+' : '-'}{formatBs(Math.abs(saldoPreviewUsd) * bcvRate)} Bs
                                            </p>
                                        )}
                                    </div>
                                )}

                            </div>

                            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                                <button
                                    onClick={handleTransaction}
                                    disabled={!transactionAmount || parseFloat(transactionAmount) <= 0}
                                    className={`w-full py-3.5 text-white font-bold rounded-xl active:scale-95 transition-all text-sm flex justify-center items-center gap-2 ${transactionModal.type === 'ABONO'
                                        ? 'bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/50'
                                        : 'bg-red-500 hover:bg-red-600 disabled:bg-red-500/50'
                                        }`}
                                >
                                    <Save size={18} />
                                    {transactionModal.type === 'ABONO'
                                        ? `Abonar ${currencyMode === 'BS' ? 'Bs' : '$'}${transactionAmount || '0.00'}`
                                        : `Cargar Deuda ${currencyMode === 'BS' ? 'Bs' : '$'}${transactionAmount || '0.00'}`
                                    }
                                </button>
                            </div>
                        </div>
                    </div>
                    );
                })()
            }

            {/* Customer Detail Bottom Sheet */}
            <CustomerDetailSheet
                customer={selectedCustomer}
                isOpen={!!selectedCustomer}
                onClose={() => {
                    setSelectedCustomer(null);
                    setExpandedHistory(null);
                    setHistoryData([]);
                }}
                onAjustar={() => {
                    setTransactionModal({ isOpen: true, type: 'ABONO', customer: selectedCustomer });
                    setSelectedCustomer(null);
                }}
                onReset={() => {
                    handleResetBalance(selectedCustomer);
                    setSelectedCustomer(null);
                }}
                onEdit={() => {
                    setEditingCustomer(selectedCustomer);
                    setSelectedCustomer(null);
                }}
                onDelete={() => {
                    setDeleteCustomerTarget(selectedCustomer);
                    setSelectedCustomer(null);
                }}
                bcvRate={bcvRate}
                sales={historyData}
            />

            {/* Modal Confirmación: Reiniciar Saldo */}
            <ConfirmModal
                isOpen={!!resetBalanceCustomer}
                onClose={() => setResetBalanceCustomer(null)}
                onConfirm={confirmResetBalance}
                title="Reiniciar saldo del cliente"
                message={resetBalanceCustomer ? `¿Estás seguro de reiniciar la deuda y saldo a favor a $0.00 para ${resetBalanceCustomer.name}?\n\nEsta acción es permanente y no se puede deshacer.` : ''}
                confirmText="Sí, reiniciar"
                variant="danger"
            />

            {/* Modal Confirmación: Eliminar Cliente */}
            <ConfirmModal
                isOpen={!!deleteCustomerTarget}
                onClose={() => setDeleteCustomerTarget(null)}
                onConfirm={async () => {
                    const updated = customers.filter(c => c.id !== deleteCustomerTarget.id);
                    await saveCustomers(updated);
                    showToast(`Cliente ${deleteCustomerTarget.name} eliminado`, 'success');
                    setDeleteCustomerTarget(null);
                }}
                title="Eliminar cliente"
                message={deleteCustomerTarget ? `¿Eliminar a ${deleteCustomerTarget.name}? Esta acción no se puede deshacer.` : ''}
                confirmText="Sí, eliminar"
                variant="danger"
            />

            {/* Modal Editar Cliente */}
            {editingCustomer && (
                <EditCustomerModal
                    customer={editingCustomer}
                    onClose={() => setEditingCustomer(null)}
                    onSave={async (updated) => {
                        const newCustomers = customers.map(c => c.id === updated.id ? updated : c);
                        await saveCustomers(newCustomers);
                        setEditingCustomer(null);
                        showToast('Cliente actualizado', 'success');
                    }}
                />
            )}
        </div >
    );
}

// ─── Sub-componente: Tarjeta Compacta ───────────────────────
function CustomerCard({ customer, bcvRate, onClick, onDelete }) {
    return (
        <div className="bg-white dark:bg-slate-900 rounded-2xl px-4 py-3 border border-slate-100 dark:border-slate-800 shadow-sm transition-all active:scale-[0.98] flex items-center gap-2 relative">
            <div 
                onClick={onClick}
                className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            >
                <div className="w-11 h-11 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                    <span className="text-lg font-black text-blue-600 dark:text-blue-400">
                        {customer.name.charAt(0).toUpperCase()}
                    </span>
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-slate-800 dark:text-white text-sm truncate">{customer.name}</h3>
                    <div className="flex items-center gap-2 mt-0.5">
                        {customer.documentId && (
                            <p className="text-[10px] font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                                {customer.documentId}
                            </p>
                        )}
                        {customer.phone && (
                            <p className="text-[10px] text-slate-400 flex items-center gap-1">
                                <Phone size={10} /> {customer.phone}
                            </p>
                        )}
                    </div>
                </div>
                <div className="text-right shrink-0">
                    {customer.deuda > 0 ? (
                        <>
                            <p className="text-sm font-black text-red-500 leading-tight">-${formatUsd(customer.deuda)}</p>
                            {bcvRate > 0 && <p className="text-[10px] font-bold text-red-400/70">-{formatBs(customer.deuda * bcvRate)} Bs</p>}
                        </>
                    ) : customer.favor > 0 ? (
                        <>
                            <p className="text-sm font-black text-emerald-500 leading-tight">+${formatUsd(customer.favor)}</p>
                            {bcvRate > 0 && <p className="text-[10px] font-bold text-emerald-400/70">+{formatBs(customer.favor * bcvRate)} Bs</p>}
                        </>
                    ) : (
                        <p className="text-xs font-bold text-slate-400 flex items-center gap-1">
                            <CheckCircle2 size={12} className="text-emerald-400" /> Al día
                        </p>
                    )}
                </div>
            </div>
            {onDelete && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                    }}
                    className="p-2 shrink-0 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors active:scale-95 z-10"
                >
                    <Trash2 size={16} />
                </button>
            )}
        </div>
    );
}

// ─── Sub-componente: Bottom Sheet de Detalle ────────────────
function CustomerDetailSheet({ customer, isOpen, onClose, onAjustar, onReset, onEdit, onDelete, bcvRate, sales }) {
    if (!isOpen || !customer) return null;

    const createdDate = customer.createdAt
        ? new Date(customer.createdAt).toLocaleDateString('es-VE', { month: 'long', year: 'numeric' })
        : null;

    return (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
            <div
                className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white dark:bg-slate-900 rounded-t-3xl max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom duration-300 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Close + Drag Handle */}
                <div className="flex items-center justify-between px-4 pt-3 pb-2">
                    <div className="w-8" />
                    <div className="w-8 h-1 bg-slate-300 dark:bg-slate-700 rounded-full" />
                    <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="px-5 pb-6 space-y-5">
                    {/* Header */}
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                            <span className="text-2xl font-black text-blue-600 dark:text-blue-400">
                                {customer.name.charAt(0).toUpperCase()}
                            </span>
                        </div>
                        <div>
                            <h3 className="text-lg font-black text-slate-800 dark:text-white">{customer.name}</h3>
                            <div className="flex items-center gap-2 mt-0.5">
                                {customer.documentId && (
                                    <p className="text-xs font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                                        {customer.documentId}
                                    </p>
                                )}
                                {customer.phone && (
                                    <p className="text-xs text-slate-400 flex items-center gap-1">
                                        <Phone size={12} /> {customer.phone}
                                    </p>
                                )}
                            </div>
                            {createdDate && (
                                <p className="text-[10px] text-slate-400 mt-1">Cliente desde {createdDate}</p>
                            )}
                        </div>
                    </div>

                    {/* Saldo */}
                    <div className="flex gap-2">
                        {customer.deuda > 0 ? (
                            <div className="flex-1 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl px-3 py-2.5 text-center">
                                <p className="text-[10px] font-bold text-red-400 uppercase">Debe</p>
                                <p className="text-lg font-black text-red-500">-${formatUsd(customer.deuda)}</p>
                                {bcvRate > 0 && <p className="text-[10px] font-bold text-red-400/70">-{formatBs(customer.deuda * bcvRate)} Bs</p>}
                            </div>
                        ) : customer.favor > 0 ? (
                            <div className="flex-1 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 rounded-xl px-3 py-2.5 text-center">
                                <p className="text-[10px] font-bold text-emerald-400 uppercase">A favor</p>
                                <p className="text-lg font-black text-emerald-500">+${formatUsd(customer.favor)}</p>
                                {bcvRate > 0 && <p className="text-[10px] font-bold text-emerald-400/70">+{formatBs(customer.favor * bcvRate)} Bs</p>}
                            </div>
                        ) : (
                            <div className="flex-1 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-center">
                                <p className="text-sm font-black text-slate-400 flex items-center justify-center gap-1">
                                    <CheckCircle2 size={14} className="text-emerald-400" /> Al día
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Acciones */}
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={onAjustar}
                            className="flex flex-col items-center gap-1.5 py-3 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-xl text-xs font-bold hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors active:scale-95 col-span-1"
                        >
                            <CreditCard size={18} />
                            <span>Ajustar Cuenta</span>
                        </button>
                        {(customer.deuda !== 0 || customer.favor !== 0) && (
                            <button
                                onClick={onReset}
                                className="flex flex-col items-center gap-1.5 py-3 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors active:scale-95"
                            >
                                <RefreshCw size={18} />
                                <span>Poner en 0</span>
                            </button>
                        )}
                    </div>

                    {/* Historial */}
                    <div>
                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                            <Clock size={12} /> Historial
                        </h4>
                        {(!sales || sales.length === 0) ? (
                            <p className="text-xs text-slate-400 text-center py-6">Sin registros aún</p>
                        ) : (
                            <div className="space-y-2">
                                {sales.slice(0, 10).map(sale => {
                                    const date = new Date(sale.timestamp);
                                    const dateStr = date.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: '2-digit' });
                                    const timeStr = date.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false });
                                    const isCobro = sale.tipo === 'COBRO_DEUDA';
                                    const isFiada = sale.tipo === 'VENTA_FIADA';
                                    return (
                                        <div key={sale.id} className="flex items-start gap-2.5 py-2 px-2 bg-slate-50 dark:bg-slate-950 rounded-xl">
                                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isCobro ? 'bg-emerald-100 dark:bg-emerald-900/30' : isFiada ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-blue-100 dark:bg-blue-900/30'}`}>
                                                {isCobro ? <ArrowUpRight size={14} className="text-emerald-500" /> : isFiada ? <CreditCard size={14} className="text-amber-500" /> : <ShoppingBag size={14} className="text-blue-500" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between items-start">
                                                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                                                        {isCobro ? 'Abono de deuda' : isFiada ? 'Venta fiada' : 'Venta'}
                                                    </p>
                                                    <span className={`text-xs font-black ${isCobro ? 'text-emerald-500' : isFiada ? 'text-amber-500' : 'text-slate-700 dark:text-white'}`}>
                                                        {isCobro ? '+' : ''}${formatUsd(sale.totalUsd || 0)}
                                                    </span>
                                                </div>
                                                {sale.items && sale.items.length > 0 && (
                                                    <p className="text-[10px] text-slate-400 truncate mt-0.5">
                                                        {sale.items.map(i => i.name).join(', ')}
                                                    </p>
                                                )}
                                                {sale.fiadoUsd > 0 && (
                                                    <p className="text-[10px] text-amber-500 font-bold mt-0.5">Deuda: ${formatUsd(sale.fiadoUsd)}</p>
                                                )}
                                                <p className="text-[9px] text-slate-400 mt-0.5">{dateStr} • {timeStr}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Editar / Eliminar */}
                    <div className="flex gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                        <button
                            onClick={onEdit}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors active:scale-95"
                        >
                            <Pencil size={14} /> Editar
                        </button>
                        <button
                            onClick={onDelete}
                            className="flex items-center justify-center gap-1.5 py-2.5 px-4 bg-red-50 dark:bg-red-900/20 text-red-500 rounded-xl text-xs font-bold hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Sub-componente: Editar Cliente ───────────────────────
function EditCustomerModal({ customer, onClose, onSave }) {
    const [name, setName] = useState(customer.name);
    const [documentId, setDocumentId] = useState(customer.documentId || '');
    const [phone, setPhone] = useState(customer.phone || '');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSave({ ...customer, name: name.trim(), documentId: documentId.trim(), phone: phone.trim() });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-3xl sm:rounded-3xl shadow-xl overflow-hidden animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200">
                <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                    <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                        <Pencil size={20} className="text-blue-500" /> Editar Cliente
                    </h3>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-5 space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Nombre *</label>
                        <input
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full form-input bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/50 transition-all font-medium"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Cédula / RIF (Opcional)</label>
                        <input
                            type="text"
                            value={documentId}
                            onChange={(e) => setDocumentId(e.target.value.toUpperCase())}
                            placeholder="V-12345678"
                            className="w-full form-input bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/50 transition-all font-medium uppercase"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Teléfono</label>
                        <div className="w-full flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus-within:ring-2 focus-within:ring-blue-500/50 transition-all overflow-hidden">
                            <span className="px-3 py-3 text-sm font-black text-blue-500 border-r border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0 select-none">+58</span>
                            <input
                                type="tel"
                                placeholder="0412 1234567"
                                value={phone}
                                onChange={(e) => {
                                    const clean = e.target.value.replace(/^\+?58/, '');
                                    setPhone(clean);
                                }}
                                className="flex-1 bg-transparent px-3 py-3 text-slate-800 dark:text-white outline-none text-sm font-medium placeholder:text-slate-400"
                            />
                        </div>
                        <p className="text-[9px] text-slate-400 mt-1 ml-1">Venezuela · Ej: 0412 1234567</p>
                    </div>
                    <button
                        type="submit"
                        disabled={!name.trim()}
                        className="w-full py-3.5 bg-blue-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold rounded-xl active:scale-95 transition-all mt-4 flex justify-center items-center gap-2"
                    >
                        <Save size={18} /> Guardar Cambios
                    </button>
                </form>
            </div>
        </div>
    );
}

function AddCustomerModal({ onClose, onSave }) {
    const [name, setName] = useState('');
    const [documentId, setDocumentId] = useState('');
    const [phone, setPhone] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!name.trim()) return;

        onSave({
            id: crypto.randomUUID(),
            name: name.trim(),
            documentId: documentId.trim(),
            phone: phone.trim(),
            deuda: 0,
            favor: 0,
            createdAt: new Date().toISOString()
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-t-3xl sm:rounded-3xl shadow-xl overflow-hidden animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200">
                <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                    <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                        <User size={22} className="text-blue-500" /> Nuevo Cliente
                    </h3>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-5 space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Nombre del Cliente *</label>
                        <input
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Ej. María Pérez"
                            className="w-full form-input bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/50 transition-all font-medium"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Cédula / RIF (Opcional)</label>
                        <input
                            type="text"
                            value={documentId}
                            onChange={(e) => setDocumentId(e.target.value.toUpperCase())}
                            placeholder="V-12345678"
                            className="w-full form-input bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/50 transition-all font-medium uppercase"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Teléfono (opcional)</label>
                        <div className="w-full flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus-within:ring-2 focus-within:ring-blue-500/50 transition-all overflow-hidden">
                            <span className="px-3 py-3 text-sm font-black text-blue-500 border-r border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0 select-none">+58</span>
                            <input
                                type="tel"
                                placeholder="0412 1234567"
                                value={phone}
                                onChange={(e) => {
                                    const clean = e.target.value.replace(/^\+?58/, '');
                                    setPhone(clean);
                                }}
                                className="flex-1 bg-transparent px-3 py-3 text-slate-800 dark:text-white outline-none text-sm font-medium placeholder:text-slate-400"
                            />
                        </div>
                        <p className="text-[9px] text-slate-400 mt-1 ml-1">Venezuela · Ej: 0412 1234567</p>
                    </div>

                    <button
                        type="submit"
                        disabled={!name.trim()}
                        className="w-full py-3.5 bg-blue-500 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold rounded-xl active:scale-95 transition-all mt-4 flex justify-center items-center gap-2"
                    >
                        <Save size={18} /> Guardar Cliente
                    </button>
                </form>
            </div>
        </div>
    );
}

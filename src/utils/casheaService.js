import { storageService } from './storageService';

const CASHEA_KEY = 'bodega_cashea_plans_v1';

/** Obtener todos los planes Cashea */
export async function getAllCasheaPlans() {
    return await storageService.getItem(CASHEA_KEY, []);
}

/** Obtener planes Cashea de un cliente */
export async function getCustomerCasheaPlans(customerId) {
    const all = await getAllCasheaPlans();
    return all.filter(p => p.customerId === customerId);
}

/** Crear un nuevo plan Cashea */
export async function createCasheaPlan({ customerId, customerName, totalAmount, downPayment, installmentCount, daysPerInstallment = 14, notes = null }) {
    const remaining = Math.max(0, totalAmount - downPayment);
    const count = Math.max(1, installmentCount);
    const rawCuota = remaining / count;
    const cuotaAmount = Math.round(rawCuota * 100) / 100;

    // Ajustar la última cuota para que el total cuadre exactamente
    const sumCuotas = cuotaAmount * (count - 1);
    const lastCuota = Math.round((remaining - sumCuotas) * 100) / 100;

    const installments = Array.from({ length: count }, (_, i) => {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + daysPerInstallment * (i + 1));
        return {
            number: i + 1,
            amount: i === count - 1 ? lastCuota : cuotaAmount,
            dueDate: dueDate.toISOString(),
            paidAt: null,
            status: 'pending'
        };
    });

    const plan = {
        id: crypto.randomUUID(),
        customerId,
        customerName,
        totalAmount,
        downPayment,
        remainingAmount: remaining,
        installmentCount: count,
        installmentAmount: cuotaAmount,
        daysPerInstallment,
        startDate: new Date().toISOString(),
        installments,
        status: 'active',
        notes,
        createdAt: new Date().toISOString()
    };

    const all = await getAllCasheaPlans();
    await storageService.setItem(CASHEA_KEY, [plan, ...all]);
    return plan;
}

/** Marcar cuota como pagada */
export async function markInstallmentPaid(planId, installmentNumber) {
    const all = await getAllCasheaPlans();
    const updated = all.map(plan => {
        if (plan.id !== planId) return plan;

        const updatedInstallments = plan.installments.map(inst => {
            if (inst.number !== installmentNumber) return inst;
            return { ...inst, status: 'paid', paidAt: new Date().toISOString() };
        });

        const allPaid = updatedInstallments.every(i => i.status === 'paid');
        return { ...plan, installments: updatedInstallments, status: allPaid ? 'completed' : 'active' };
    });

    await storageService.setItem(CASHEA_KEY, updated);
    return updated.find(p => p.id === planId);
}

/** Desmarcar cuota pagada */
export async function markInstallmentUnpaid(planId, installmentNumber) {
    const all = await getAllCasheaPlans();
    const updated = all.map(plan => {
        if (plan.id !== planId) return plan;

        const updatedInstallments = plan.installments.map(inst => {
            if (inst.number !== installmentNumber) return inst;
            return { ...inst, status: 'pending', paidAt: null };
        });

        return { ...plan, installments: updatedInstallments, status: 'active' };
    });

    await storageService.setItem(CASHEA_KEY, updated);
    return updated.find(p => p.id === planId);
}

/** Eliminar un plan */
export async function deleteCasheaPlan(planId) {
    const all = await getAllCasheaPlans();
    await storageService.setItem(CASHEA_KEY, all.filter(p => p.id !== planId));
}

/** Actualizar estados de cuotas según fechas de vencimiento */
export function refreshInstallmentStatuses(plan) {
    const now = new Date();
    return {
        ...plan,
        installments: plan.installments.map(inst => {
            if (inst.status === 'paid') return inst;
            const due = new Date(inst.dueDate);
            return { ...inst, status: due < now ? 'overdue' : 'pending' };
        })
    };
}

/** Obtener resumen Cashea de un cliente */
export function getCasheaSummary(plans) {
    const active = plans.filter(p => p.status === 'active');
    const allPending = active.flatMap(p =>
        p.installments.filter(i => i.status !== 'paid')
    );
    const overdue = allPending.filter(i => new Date(i.dueDate) < new Date());
    const totalPending = allPending.reduce((s, i) => s + i.amount, 0);
    const sorted = [...allPending].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    return {
        activePlanCount: active.length,
        totalPending: Math.round(totalPending * 100) / 100,
        overdueCount: overdue.length,
        nextDue: sorted[0] || null
    };
}

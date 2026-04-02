import { round2, subR } from './dinero';

export function procesarImpactoCliente(clienteInicial, transaccion) {
    // CLONAR PARA INMUTABILIDAD
    let cliente = { ...clienteInicial };

    // INPUTS INTERMEDIOS
    const { usaSaldoFavor = 0, esCredito = false, deudaGenerada = 0, vueltoParaMonedero = 0 } = transaccion;

    // 0. Q0: CONSUMO DE SALDO A FAVOR
    if (usaSaldoFavor > 0) {
        cliente.favor = round2(Math.max(0, subR((cliente.favor || 0), usaSaldoFavor)));
    }

    // 1. Q1: GENERACIÓN DE DEUDA
    if (esCredito) {
        cliente.deuda = round2((cliente.deuda || 0) + deudaGenerada);
    }

    // 2. Q2 & Q3: VUELTO (ABONO A DEUDA O MONEDERO)
    // El "vuelto" digital es lo que sobra que NO se entregó en efectivo.
    if (vueltoParaMonedero > 0) {
        const deudaActual = round2(cliente.deuda || 0);

        if (deudaActual > 0.001) {
            // PRIORITY: DEBT FIRST
            if (deudaActual >= vueltoParaMonedero) {
                // Paga parte de la deuda
                cliente.deuda = subR(deudaActual, vueltoParaMonedero);
                // Nada al favor real, todo se consumió en deuda
            } else {
                // Paga toda la deuda y sobra
                const sobra = subR(vueltoParaMonedero, deudaActual);
                cliente.deuda = 0;
                cliente.favor = round2((cliente.favor || 0) + sobra); // Q3
            }
        } else {
            // No deuda, todo a favor
            cliente.favor = round2((cliente.favor || 0) + vueltoParaMonedero);
        }
    }

    // 3. NORMALIZACIÓN ESTRICTA (The Golden Rule)
    const saldoNeto = subR((cliente.favor || 0), (cliente.deuda || 0));

    if (saldoNeto >= 0) {
        cliente.favor = round2(saldoNeto);
        cliente.deuda = 0;
    } else {
        cliente.favor = 0;
        cliente.deuda = round2(Math.abs(saldoNeto));
    }

    return cliente;
}

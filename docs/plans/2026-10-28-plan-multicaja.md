# Plan Multicaja — Listo POS Lite

**Fecha:** 28-oct-2026 · **Estado:** 📋 Guardado para aplicar más adelante (no iniciado).
**Situación actual:** los clientes usan **una sola caja**. El objetivo es dejar el sistema listo para que un negocio pueda trabajar con 2 o más cajas a la vez sin perder stock, dinero ni claridad en los cierres.

> Este plan **reemplaza la tarea B4** del plan de sincronización (`2026-10-27-plan-correccion-sincronizacion.md`): con una sola caja no hace falta el parche provisional, y la Fase C resuelve el problema de fondo.

---

## 1. Qué ya está listo (no hay que hacerlo)

| Pieza | Dónde | Estado |
|---|---|---|
| Letra por caja (A, B, C…) asignada por el servidor | `account_devices.register_code`, migración `014_register_codes.sql` | ✅ En producción |
| Numeración de ventas por caja (`#A-00001`, `#B-00001`) | `src/utils/saleNumbering.js` | ✅ En producción |
| Lista de equipos, renombrar y expulsar | Configuración → Licencia (`SettingsTabLicencia.jsx`) | ✅ Existe |
| Límite de equipos por licencia | `cloud_licenses.max_devices` (RPC de registro en migración 006) | ✅ Existe |
| Borrados que no reaparecen, merges que no pisan, sin eco | Fase B del plan de sync | ✅ En producción |
| Datos separados por cuenta en el mismo equipo | `src/config/accountLocalSwap.js` (B8) | ✅ En producción |

## 2. Qué falla hoy con 2 cajas (por qué hace falta este plan)

| # | Problema | Causa | Gravedad |
|---|---|---|---|
| 1 | Si dos cajas venden el mismo producto casi a la vez, el stock puede descontar solo una venta. | El inventario viaja como un único documento y "gana el último" (hallazgo H-2). Las ventas sí quedan registradas. | 🔴 Alta |
| 2 | Lo mismo con deudas y abonos de un cliente atendido en dos cajas. | Igual que el anterior: el saldo es un campo, no un libro de movimientos. | 🔴 Alta |
| 3 | **El turno es uno solo para toda la cuenta.** Abrir caja en el equipo A la abre también en B; cerrar en uno cierra para todos; el conteo de efectivo mezcla el dinero de ambas. | `getOpenCashSession()` en `src/utils/closureLogic.js` busca la última `APERTURA_CAJA` de **toda** la cuenta, sin mirar la caja. | 🟠 Media (no pierde datos, pero no se puede cuadrar por cajero) |
| 4 | Los reportes no separan por caja. | Las ventas tienen `registerCode`, pero ningún reporte lo usa. | 🟡 Baja |
| 5 | Un teléfono del dueño que solo mira reportes cuenta como "caja" y gasta una letra y un cupo de licencia. | Todo equipo registrado en `account_devices` recibe letra. | 🟡 Baja |

---

## 3. Partes del plan (en el orden sugerido)

### Parte M1 — Turnos por caja (≈1 semana, riesgo medio)

Cada caja abre, vende y cierra **su propio** turno.

1. **Guardar la caja en la apertura y el cierre.** `APERTURA_CAJA` y cada cierre en `bodega_cierres_v1` llevan `registerCode` (las ventas ya lo llevan).
2. **`getOpenCashSession(allSales, now, registerCode)`**: filtra por la caja de este equipo. Aperturas viejas sin `registerCode` se tratan como "de la caja que la abrió primero" (compatibilidad: con una sola caja todo sigue igual).
3. **`isMovementInCashSession`**: un movimiento pertenece al turno solo si es de la misma caja (los que no tienen `registerCode` se comportan como hoy).
4. **Cierre de caja**: el cuadre de efectivo, el fondo y las diferencias se calculan por caja. El cierre muestra "Caja A — Mostrador".
5. **Cierre del día (consolidado)**: en Reportes, una vista que suma todas las cajas del día y muestra el detalle de cada una. Aviso si alguna caja sigue con el turno abierto.
6. **Anulaciones entre cajas**: anular en la caja B una venta de la caja A devuelve el dinero en el turno de **B** (quien entrega el efectivo), y deja constancia de la caja de origen (`originRegisterCode` ya existe en `voidSaleCore.js`).

**Archivos:** `src/utils/closureLogic.js`, `src/utils/closureService.js`, `src/views/SalesView.jsx`, `src/components/Dashboard/AperturaCajaModal.jsx`, `src/views/DashboardView.jsx`, `src/utils/reportsProcessor.js`, `src/components/Reports/*`.
**Pruebas:** ampliar `tests/closureLogic.test.mjs` con dos cajas: aperturas independientes, cierre de A no cierra B, cuadre separado, turno que cruza medianoche por caja, datos viejos sin `registerCode`.
**Criterio de listo:** con una sola caja no cambia nada visible; con dos navegadores (caja A y B) cada uno abre y cierra solo, y el consolidado del día suma bien.

### Parte M2 — Administración de cajas (≈2–3 días, riesgo bajo)

Sobre lo que ya existe en Configuración → Licencia:

1. Mostrar la **letra** de cada equipo junto a su nombre ("A · Mostrador") y la hora de su última venta.
2. Tipo de equipo: **Caja** (vende, tiene letra y turno) o **Solo consulta** (ve reportes e inventario, no vende, no gasta letra). Columna nueva `account_devices.device_role` (migración aditiva, por defecto `'register'`).
3. Al expulsar un equipo con turno abierto, avisar antes.
4. Decidir con el usuario si "Solo consulta" cuenta o no para `max_devices` (decisión comercial).

**Archivos:** `src/components/Settings/tabs/SettingsTabLicencia.jsx`, `src/services/registerCodeService.js`, migración nueva `0xx_device_role.sql`.

### Parte M3 — Fase C: stock y deudas sin pérdidas (≈3–4 semanas, riesgo alto con interruptor)

Es la **Fase C del plan de sincronización** (`2026-10-27-plan-correccion-sincronizacion.md`, secciones C1–C5). Resumen:

- Cada producto, cliente y venta se sincroniza por separado (tabla `entities`), no como un documento gigante.
- El stock y los saldos los calcula el **servidor** a partir de un libro de movimientos (`inventory_operations`, `customer_ledger`). Dos ventas a la vez = dos movimientos = las dos cuentan.
- Se activa con el interruptor `sync_engine = 'v2'`, primero solo en una cuenta de prueba; durante la transición escribe en los dos modelos para poder volver atrás.

Resuelve los problemas 1 y 2 de la sección 2.

### Parte M4 — Banco de pruebas multicaja (≈2–3 días, junto a M1 y M3)

Es la **Fase D1** del plan de sincronización, enfocada en cajas:

1. Dos navegadores (caja A y B) en la misma cuenta de prueba venden el mismo producto 10 veces cada uno → stock final = inicial − 20.
2. Caja B sin internet vende 5, se reconecta → nada se duplica ni se pierde.
3. Mismo cliente fiado en A y abonado en B a la vez → saldo correcto.
4. A y B abren y cierran turnos por separado → cuadres independientes y consolidado correcto.
5. Reloj de una caja adelantado 10 minutos → el orden y los cierres no se rompen.

---

## 4. Orden y cuándo hacerlo

| Paso | Parte | Cuándo |
|---|---|---|
| 1 | M2 Administración de cajas | Cuando se venda la primera licencia de 2+ cajas, o antes si sobra tiempo. Es corta. |
| 2 | M1 Turnos por caja | Antes de que un cliente use 2 cajas de verdad. |
| 3 | M3 Fase C | Antes de que 2 cajas vendan **los mismos productos** con volumen alto. |
| 4 | M4 Pruebas | Al terminar M1 y otra vez al terminar M3. |

Cada parte sigue el flujo de siempre: rama propia, pruebas en verde, vista previa de Vercel, PR y fusión.

## 5. Fuera de este plan

- **Multicaja por cable de red local sin internet** (`../ideas/2026-10-08-lan-multicaja-sync.md`): solo tendría sentido si un cliente necesita varias cajas **sin internet** y sin sobreventa. Con la Fase C y la cola sin conexión, las cajas siguen vendiendo offline y se ponen al día al volver la conexión. Se deja como idea para más adelante.
- **Licencias por código con varios equipos** (`../ideas/sync_and_licensing.md`): ya está cubierto en su mayoría por `max_devices` y `account_devices`.

## 6. Decisiones pendientes del usuario

1. ¿Los equipos "Solo consulta" cuentan para el límite de la licencia?
2. ¿Una caja puede tener varios cajeros por turno, o un cajero por turno?
3. ¿El cierre del día lo hace cada cajero o lo consolida el administrador?

# LAN Multicaja Synchronization & Failover Implementation Plan

> **Plan de Auditoría e Implementación Futura**  
> **Fecha de creación:** 2026-10-08  
> **Estado:** Documentado / Pendiente de Aprobación para Auditoría y Despliegue  
> **Tipo:** Arquitectura Crítica (Core POS & Network Sync)

---

## 1. Visión General y Objetivos

**Meta:**  
Implementar una sincronización de punto de venta multicaja sobre cable de red local (Ethernet LAN / Switch) entre una **Caja Maestra (Servidor Hub)** y una o más **Cajas Secundarias (Clientes)**, capaz de operar a menos de 1 ms de latencia, prevenir sobreventas de inventario sin depender de internet, y proveer *failover* automático e instantáneo a la cola local (`IndexedDB`) ante cualquier desconexión física.

**Arquitectura:**  
Un micro-servicio local ultra ligero (Node.js / Binario nativo) se ejecuta en la PC principal (Caja Maestra). Las Cajas Secundarias se comunican por WebSockets en la red interna para consultar stock y registrar ventas en caliente. Cuando se restablece la conexión a internet, la Caja Maestra actúa como pasarela única hacia Supabase Cloud utilizando el RPC idempotente existente (`process_checkout`), eliminando carreras y peticiones duplicadas a la nube.

**Stack Tecnológico:**
- **Protocolo LAN:** WebSockets (`ws` o WebSocket nativo) + JSON Schema de eventos.
- **Cliente POS:** React 19, Zustand, `localForage` (IndexedDB), `offlineQueueService`.
- **Servidor Local:** Node.js (HTTP/WS) con persistencia local ligera en disco (SQLite / Append-only Log).
- **Arnés de Pruebas:** Node.js Native Test Runner (`node:test`, `node:assert/strict`).
- **Empaquetado Windows:** Inno Setup / Script de servicio en segundo plano con apertura automática de Firewall.

---

## 2. Matriz de Guardarraíles y Escenarios de Fallo (Failover)

| Escenario de Falla | Comportamiento sin Guardarraíl (Peligro) | Comportamiento con Guardarraíl (Diseño Propuesto) |
| :--- | :--- | :--- |
| **Corte de cable o apagado de Caja Maestra durante venta** | La Caja 2 se congela esperando respuesta HTTP/WS indefinidamente. | **Circuit Breaker con Timeout de 800 ms:** La Caja 2 detecta socket caído, cambia a modo *Fallback Offline*, almacena en su `offlineQueue` local y confirma el ticket al cliente con advertencia visual. |
| **Venta concurrente del último ítem disponible** | Ambas cajas cobran el mismo producto a la vez; inventario resultante negativo. | **Árbitro Central de Reservas:** La Caja Maestra aplica bloqueo atómico de reserva (2 segundos) antes de emitir confirmación de pago por LAN. |
| **Reconexión abrupta de cable** | Ráfaga de ventas acumuladas pisa inventario o duplica transacciones. | **Idempotencia por `queue_id`:** El servidor local descarta duplicados exactamente igual que el RPC de Supabase y consolida deltas de stock. |
| **Regreso intermitente de Internet** | Múltiples cajas saturan Supabase compitiendo por sincronizar. | **Single Cloud Gateway:** Solo la Caja Maestra habla con Supabase Cloud. Las secundarias solo hablan con la Maestra en la LAN. |

---

## 3. Checklist de Auditoría Previa a la Implementación

Antes de iniciar la codificación activa de esta funcionalidad, el equipo o auditor debe verificar:

- [ ] **Auditoría de Red:** Verificar si la instalación del cliente usa Router/Switch con DHCP o si requiere direccionamiento estático (cable directo PC a PC).
- [ ] **Auditoría de Reglas de Firewall:** Confirmar permisos de administrador en Windows para la regla `netsh advfirewall` en el instalador.
- [ ] **Auditoría de Esquema de Datos:** Verificar compatibilidad de `queue_id` local con el formato UUID v4 de Supabase para evitar discrepancias de tipos.
- [ ] **Auditoría de Licencias:** Confirmar que `cloud_licenses.max_devices` soporte el número de cajas autorizadas para la cuenta.
- [ ] **Auditoría de Almacenamiento:** Validar que el log local de la Caja Maestra cuente con rotación automática (máximo 30 días o 100,000 ventas en disco local).

---

## 4. Tareas de Implementación Desglosadas (TDD & Guardarraíles)

### Tarea 1: Protocolo de Mensajería LAN y Validación de Tipos
**Archivos:**
- Crear: `src/services/lan/lanProtocol.js`
- Test: `tests/lanProtocol.test.mjs`

**Paso 1: Escribir el test que falla**
Crear pruebas unitarias que verifiquen:
- Formato estricto de paquetes: `PING`, `PONG`, `RESERVE_STOCK`, `CONFIRM_SALE`, `STOCK_DELTA`, `SYNC_STATE`.
- Rechazo de paquetes malformados sin `queue_id` o con timestamp inválido.

**Paso 2: Implementar módulo de serialización y validación**
Funciones puras sin dependencias externas: `encodeLanMessage`, `decodeLanMessage`, `validateLanPayload`.

**Paso 3: Validar con `npm test`**
Asegurar que todas las aserciones pasen.

---

### Tarea 2: Árbitro de Inventario y Servidor Hub Local (Caja Maestra)
**Archivos:**
- Crear: `src/services/lan/lanMasterServer.js`
- Test: `tests/lanMasterArbiter.test.mjs`

**Paso 1: Escribir el test que falla**
Simular dos clientes concurrentes compitiendo por un producto con `stock: 1`:
- Cliente A solicita reserva de 1 unidad. -> Exitoso.
- Cliente B solicita reserva de 1 unidad mientras la de A sigue activa. -> Rechazado (`OUT_OF_STOCK`).
- Expiración de reserva tras timeout de 5 segundos si no se confirma el pago.

**Paso 2: Implementar el árbitro en memoria con persistencia en log**
Lógica de reservas temporales (`reservationsMap`), confirmación definitiva de venta y deducción de stock.

**Paso 3: Validar idempotencia**
Verificar que reenviar la misma venta con idéntico `queue_id` devuelve confirmación sin descontar dos veces.

---

### Tarea 3: Adaptador Cliente en Caja Secundaria y Failover Instantáneo
**Archivos:**
- Crear: `src/services/lan/lanClientAdapter.js`
- Modificar: `src/services/offlineQueueService.js`
- Test: `tests/lanClientFailover.test.mjs`

**Paso 1: Escribir el test de failover**
Simular:
- Cliente conectado a Maestra envía venta -> Procesa por LAN.
- Se corta la conexión (mock de socket cerrado) -> Cliente conmuta a cola local `IndexedDB` en < 50 ms sin lanzar error en la interfaz.
- Al restaurar la conexión, el cliente vacía los registros pendientes hacia la Maestra en lote ordenado.

**Paso 2: Implementar reconexión exponencial y Circuit Breaker**
Mecanismo de latido (*heartbeat*) cada 3 segundos: si falla 2 veces consecutivas, el cliente se declara en estado `LAN_DISCONNECTED` y redirige el flujo de cobro al almacenamiento local.

---

### Tarea 4: Interfaz de Usuario y Detección de Red en Ajustes
**Archivos:**
- Crear: `src/components/Settings/tabs/SettingsTabRedLocal.jsx`
- Modificar: `src/views/SettingsView.jsx`
- Crear: `src/hooks/useLanSync.js`

**Componentes y funcionalidades UI:**
- **Selector de Rol:**
  - `🟢 Modo Estándar (Solo Nube)`
  - `👑 Esta PC es la Caja Maestra` (Muestra IP local detectada y puerto, ej. `192.168.1.50:8787`).
  - `💻 Esta PC es Caja Secundaria` (Campo para introducir IP de la Maestra + botón "Probar Conexión").
- **Indicador de Estado en la Barra Superior:**
  - Icono de red con badge:
    - 🟢 *LAN Maestra Conectada (<1ms)*
    - 🟡 *LAN Reconectando...*
    - ⚪ *Modo Local Autónomo (Sin conexión)*

---

### Tarea 5: Empaquetado Automático para Windows (Instalador Zero-Config)
**Archivos:**
- Crear: `scripts/package-lan-server.mjs`
- Crear: `windows/installer.iss` (Inno Setup Script)
- Crear: `windows/start-lan-service.vbs` (Lanzador silencioso en segundo plano)

**Acciones automatizadas por el instalador:**
1. Crear carpeta `C:\Program Files\Listo POS\bin`.
2. Registrar entrada en el Registro de Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` para inicio automático.
3. Ejecutar regla de Firewall:
   ```cmd
   netsh advfirewall firewall add rule name="Listo POS LAN Service" dir=in action=allow protocol=TCP localport=8787
   ```
4. Crear accesos directos en Escritorio y Menú Inicio.

---

## 5. Criterios de Aceptación para la Auditoría Final (Sign-off)

| ID | Criterio de Aceptación | Método de Validación |
| :--- | :--- | :--- |
| **AC-1** | La Caja 2 cobra un producto y el stock se descuenta en la Caja 1 en menos de 100 ms sin internet. | Prueba con cable desconectado de internet. |
| **AC-2** | Se apaga la PC de la Caja 1 de golpe; la Caja 2 permite continuar cobrando sin mostrar pantallas de error. | Prueba de desconexión física de cable. |
| **AC-3** | Se reconecta el cable; las ventas hechas por la Caja 2 se transmiten a la Caja 1 sin duplicados ni pérdidas. | Validación de inventario consolidado. |
| **AC-4** | Regresa internet; la Caja 1 sube todo el consolidado a Supabase Cloud con `queue_id` idempotentes. | Verificación en tabla `sales` de Supabase. |
| **AC-5** | Todos los tests de la suite (`npm test`) pasan al 100% (incluyendo suites previas y nuevas suites LAN). | Ejecución del runner de pruebas. |
| **AC-6** | El instalador `.exe` corre en una PC limpia con Windows 10/11 sin requerir instalación previa de Node.js ni Git. | Prueba en máquina virtual / equipo limpio. |

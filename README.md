# Listo POS Lite

**Listo POS Lite** es un Sistema Integral de Punto de Venta (POS) y Gestión Administrativa diseñado para operar de manera fluida y multiplataforma. Construido con una arquitectura "Offline-First", garantiza la continuidad del negocio sin importar la conectividad, con sincronización en la nube bidireccional cuando la conexión está disponible.

Este módulo forma parte de la suite corporativa integrada y está preparado para funcionar como una **Progressive Web App (PWA)** y como una aplicación nativa para **Android** a través de Capacitor.

## 🚀 Características Principales

- **📦 Gestión de Punto de Venta (POS)**: Interfaz rápida y responsiva para procesar transacciones de clientes eficientemente, compatible con métodos de pago customizados e importes personalizados.
- **☁️ Sincronización en la Nube y Offline-First**: Utiliza `localforage` para almacenamiento local robusto, permitiendo operar sin internet, y sincroniza automáticamente con **Supabase** al recuperar conectividad.
- **🔐 Autenticación y Seguridad en la Nube**: Integración nativa con Supabase Auth. Datos completamente encriptados y segmentados por rol (Administrador, Empleado).
- **🖨️ Impresión de Tickets Térmicos**: Generación y exportación de recibos térmicos diseñados con soporte para hardware POS físico y exportación a PDF vía `html2canvas` y `jsPDF`.
- **📱 PWA & Android App**: Preparado para escritorio, navegador, e instalable localmente con iconos adaptativos. Empaquetado nativo usando `@capacitor/android`.
- **🤖 Integración de Inteligencia Artificial**: Incluye capacidades inteligentes (con `groq-sdk`) integradas directamente en el flujo de trabajo para automatización y reportes.
- **⚙️ Respaldos Integrales y Configuración**: Permite realizar backups de todo el estado de la aplicación, configuraciones y reportes históricos.

---

## 🛠️ Stack Tecnológico

El proyecto está construido sobre las tecnologías más modernas y estables para maximizar rendimiento y mantenibilidad:

- **Core Frontend**: React 19 + Vite
- **Estilos**: Tailwind CSS + PostCSS + Autoprefixer
- **Manejo de Estado**: Zustand
- **Backend as a Service (BaaS)**: Supabase (Auth & Realtime Database)
- **Persistencia de Datos Local**: LocalForage
- **Plataforma Nativa PWA/Móvil**: Vite PWA Plugin + Capacitor 8
- **Íconos y UI**: Lucide React
- **Exportación de Documentos**: jsPDF + html2canvas
- **Inteligencia Artificial**: Groq SDK

---

## 📂 Estructura del Proyecto

```text
listo_pos_lite-/
├── android/             # Archivos nativos de la aplicación Android de Capacitor
├── api/                 # Funciones serverless de Vercel (checkout, kardex, tasas…)
├── docs/                # Planes, ideas y respaldos (ver docs/README.md)
├── migrations/          # Migraciones SQL de Supabase, numeradas (000, 001, …)
├── public/              # Archivos estáticos e iconos PWA
├── scripts/             # Scripts de desarrollo y datos (dev, respaldo, no-destrucción)
│   └── legacy/          # Scripts viejos, solo de referencia
├── src/
│   ├── assets/          # Imágenes, gráficos y fuentes
│   ├── components/      # Componentes reutilizables de React (Sales, Customers, etc.)
│   ├── config/          # Configuraciones globales (ej. supabaseCloud.js)
│   ├── context/         # Contextos de React
│   ├── core/            # Funciones esenciales y lógica de negocio principal
│   ├── data/            # Almacenamiento de datos locales y mocks temporales
│   ├── hooks/           # Custom React Hooks
│   ├── services/        # Integración con APIs externas, Supabase, Groq
│   ├── sync/            # Motor de sincronización (merge, cursor, lápidas, hash)
│   ├── testing/         # Auditor financiero interno (suites deterministas)
│   ├── utils/           # Utilidades (ej. ticketGenerator, cierres, numeración)
│   ├── views/           # Páginas o vistas principales de la aplicación (Views)
│   ├── worker.js        # API para desarrollo local con Wrangler
│   ├── App.jsx          # Componente principal / Root Router
│   └── main.jsx         # Punto de entrada de React
├── tests/               # Pruebas automáticas (`npm test`)
├── package.json         # Dependencias y scripts
├── tailwind.config.js   # Configuración de los temas visuales
└── vite.config.js       # Configuración del bundler y plugins
```

---

## 💻 Desarrollo e Instalación

### Requisitos Previos
- [Node.js](https://nodejs.org/) (versión 20+ recomendada)
- Un proyecto en [Supabase](https://supabase.com/) (para el entorno en la nube)
- [Android Studio](https://developer.android.com/studio) (si se planea compilar para Android nativo)

### Instrucciones

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Iniciar servidor de desarrollo (con Hot Module Replacement):**
   ```bash
   npm run dev
   ```

3. **Construir para Producción:**
   ```bash
   npm run build
   ```

4. **Sincronización PWA y Android (Capacitor):**
   - Una vez realizado el `build`, para sincronizar con Android Studio:
     ```bash
     npx cap sync android
     npx cap open android
     ```

### Scripts Disponibles

- `npm run dev`: Inicia la app (Vite) y la API local (Wrangler) a la vez.
- `npm test`: Corre las pruebas automáticas de `tests/`.
- `npm run build`: Compila y empaqueta la aplicación de forma optimizada para producción.
- `npm run preview`: Sirve los archivos de producción de manera local para pruebas.
- `npm run lint`: Ejecuta ESLint en todo el proyecto asegurando el estándar de código.
- `npm run prettier`: Ejecuta auto-formateo en la base de código.
- `npm run data:snapshot`: Captura conteos y muestras de ventas/productos ANTES de una migración o despliegue (gate de no-destrucción).
- `npm run data:verify`: Compara el estado actual contra el snapshot y falla si detecta destrucción de datos.

### Comprobación de no-destrucción (gate de despliegue)

Antes de aplicar migraciones SQL o desplegar cambios que toquen datos:

1. `npm run data:snapshot` — guarda conteos y muestras de ventas/productos del proyecto destino.
2. Aplicar la migración / desplegar el código.
3. `npm run data:verify` — reconsulta el proyecto y compara: termina con error si una venta muestreada desapareció o fue alterada, si los conteos bajaron, o si se comparan proyectos distintos. El tráfico en vivo solo agrega filas, así que cualquier baja es sospechosa.

Opciones útiles: `--env-file` (credenciales), `--expect-host` (evita apuntar al proyecto equivocado) y `--product-tolerance`. La clave de servicio nunca se imprime ni se guarda en el snapshot.

---

## 🤝 Buenas Prácticas y Metodología (`.agent/skills/`)
Este proyecto implementa protocolos estables que garantizan alta disponibilidad, interfaz profesional y código limpio:
- **Clean Architecture** y principios **SOLID**.
- Validaciones estandarizadas estilo Producción.
- Optimización de Rendimiento Frontend (Performance UX).

El proyecto fue desarrollado y estructurado siguiendo principios avanzados de optimización y responsividad UI/UX con enfoque corporativo.

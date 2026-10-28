# Plan de arreglos de responsividad — Listo POS Lite

**Fecha:** 28-oct-2026 · **Revisado en:** vista previa de `main` (Fase B), cuenta real, rol Administrador.
**Tamaños probados:** celular pequeño 320×640, celular 375×812, tablet 768×1024, escritorio 1366×768.
**Pantallas:** Inicio, Vender (con cesta y cobro), Inventario, Contactos, Reportes y Configuración.

## Resumen

No hay ninguna pantalla que se salga de lado: ninguna produce scroll horizontal. Los problemas son de tres tipos:

1. **Elementos que se montan o se tapan.** El logo de Inicio pisa los botones en celulares chicos. La barra de navegación flotante tapa contenido.
2. **Celular apretado.** Las fichas del encabezado de Inventario se deforman y los botones de las tarjetas son demasiado pequeños para el dedo.
3. **Escritorio y tablet desaprovechados.** Casi todo es una sola columna estirada a lo ancho, y Configuración usa una columna angosta distinta al resto.

## Hallazgos y arreglos (por prioridad)

### P1 — Se ve roto o tapa cosas

| # | Pantalla | Problema | Dónde | Arreglo propuesto |
|---|---|---|---|---|
| 1 | Inicio (≤375 px) | El logo centrado (`absolute left-1/2`) se monta sobre la píldora de estado y la del usuario. A 320 px tapa la "L" de LISTO; a 375 px queda pegado al botón del candado. | `src/views/DashboardView.jsx:600-627` | En celular: logo más chico (≈40 px de alto) y sin `absolute`; usar una cuadrícula de 3 columnas (`grid-cols-[1fr_auto_1fr]`) para que los laterales nunca se crucen con el logo. A ≤360 px, la píldora "Online" muestra solo el ícono (ya lo hace) y la del usuario solo el candado. |
| 2 | Todas (sobre todo Vender en tablet/escritorio) | La barra de navegación flotante (`fixed bottom-0`) tapa la última fila de productos en Vender y el final de las listas. | `src/App.jsx:569-585`, `src/views/SalesView.jsx` (rejilla de productos) | Reservar el alto real de la barra con una variable CSS (`--bottom-nav-h`) y aplicar `padding-bottom: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom))` al contenedor que hace scroll en cada vista (en Vender, a la rejilla y a la cesta). |
| 3 | Inicio | Doble espacio vacío al final: `pb-20` del contenedor + `mb-20` de "Últimas ventas" (≈160 px en blanco). | `src/views/DashboardView.jsx:694`, `src/components/Dashboard/SalesHistory.jsx:42,53` | Quitar `mb-20` de SalesHistory y dejar un solo relleno inferior (el del arreglo #2). |

### P2 — Incómodo en celular

| # | Pantalla | Problema | Dónde | Arreglo propuesto |
|---|---|---|---|---|
| 4 | Inventario | La fila de fichas (productos / Todos / bajo stock / duplicados / vista) no cabe. "1794 bajo stock" se parte en 3 líneas y forma una ficha alta y deforme. El botón de vista queda pegado al borde. | `src/views/ProductsView.jsx:651-692` | Usar `flex-wrap` con `whitespace-nowrap` en cada ficha. En celular: textos cortos ("⚠️ 1794", "3 dupl."), ocultar los separadores `w-px` y sacar el botón de vista a la fila de categorías o al encabezado. |
| 5 | Inventario | Los botones Imprimir / Editar / Borrar de cada tarjeta tienen íconos de 12 px y unos 24 px de alto: es difícil acertar con el dedo y es fácil borrar por error. | `src/components/Products/ProductCard.jsx:180-182` | Íconos de 16 px y botones de al menos 40 px de alto en celular (`py-2.5 sm:py-1.5`); en Borrar, margen extra o confirmación (ya existe). |
| 6 | Inventario | Las tarjetas son muy altas en celular por el recuadro de imagen vacío (≈95 px): solo caben unos 3 productos por pantalla. | `src/components/Products/ProductCard.jsx` (bloque de imagen) | Si el producto no tiene foto: recuadro más bajo (≈48 px) o un ícono pequeño junto al nombre. Así entran el doble de productos. |
| 7 | Inicio | En la tarjeta de Deudas, "1185 clientes" y el monto de Cashea quedan amontonados en 375 px. | `src/views/DashboardView.jsx:885-905` | Pasar el conteo de clientes debajo del total en celular (`flex-col sm:flex-row`). |
| 8 | Inicio | En "Bajo stock", las fichas cortan el nombre ("TRIPA 110/90-16 N…") pese a que sobra ancho. | `src/views/DashboardView.jsx` (sección Bajo stock) | Fichas a ancho completo (`w-full`) con el nombre truncado solo si de verdad no cabe. |
| 9 | Configuración | En celular, las pestañas (Negocio, Ventas, Usuarios, Licencia, Sistema) son solo íconos: no se sabe qué es cada una. | `src/views/SettingsView.jsx` (barra de pestañas) | Mostrar el texto también en celular, con scroll horizontal si no cabe; o mostrar el nombre de la pestaña activa al lado. |
| 10 | Historial de ventas | La línea "#0005833 · 28-oct. · 12:19 a. m. · Efectivo" se parte en lugares raros. | `src/components/Dashboard/SalesHistory.jsx` | Dos líneas fijas: número + fecha/hora arriba y método de pago abajo, con `whitespace-nowrap` en cada parte. |

### P3 — Aprovechar tablet y escritorio

| # | Pantalla | Problema | Dónde | Arreglo propuesto |
|---|---|---|---|---|
| 11 | Inicio (≥1024 px) | Una sola columna estirada a 1366 px: tarjetas enormes y mucho espacio vacío. | `src/App.jsx:499` (`lg:max-w-none`), `src/views/DashboardView.jsx:694` | Limitar el ancho (`lg:max-w-6xl mx-auto`) y usar una rejilla de 2 columnas en `lg`: resumen del turno y acciones a la izquierda; deudas, medios de pago y últimas ventas a la derecha. |
| 12 | General (≥1024 px) | La barra de navegación inferior flotante parece de celular en escritorio y tapa contenido. | `src/App.jsx:569-585` | En `lg`: barra lateral fija a la izquierda (íconos + texto) y quitar la barra inferior. Es el cambio más grande; se puede dejar para el final. |
| 13 | Configuración (≥1024 px) | El contenido va en una columna angosta (`max-w-lg`) mientras las demás pantallas usan todo el ancho. | `src/views/SettingsView.jsx:319` | `lg:max-w-4xl` con las tarjetas en 2 columnas (`lg:grid lg:grid-cols-2`). |
| 14 | Barra de navegación | Durante el cambio de pestaña se ven dos pestañas marcadas a la vez (la anterior con subrayado). | `src/App.jsx:649` (`TabButton`) | Revisar la transición del estado activo para que solo una pestaña quede marcada. |

## Orden de trabajo sugerido

1. **Rama `fix/responsive-p1`:** arreglos 1, 2 y 3. Son pocos archivos y quitan lo que se ve roto.
2. **Rama `fix/responsive-p2`:** arreglos 4 al 10. Es donde más se nota en el celular del cajero.
3. **Rama `feat/responsive-desktop`:** arreglos 11 al 14. Es un rediseño del escritorio, conviene verlo con capturas antes de fusionar.

Cada rama sigue el mismo flujo: vista previa, revisar en 320 / 375 / 768 / 1366 px, PR y fusión.

## Cómo verificar cada arreglo

- Revisar en esos 4 tamaños con el modo dispositivo del navegador. En la vista previa se puede usar el panel del navegador.
- Comprobar que no haya scroll horizontal (`document.documentElement.scrollWidth === innerWidth`).
- Comprobar que ningún botón táctil mida menos de 40×40 px en celular.
- Comprobar que la última fila de cada lista se pueda ver completa por encima de la barra de navegación.

## No revisado en esta pasada

- Ventanas emergentes de formularios: crear/editar producto, cierre de caja, clientes, abonos.
- Pantalla de Movimientos (Kardex).
- Modo oscuro.
- Celular en horizontal.
- Rol Cajero, que oculta algunos botones.
- Teclado abierto en celular, que esconde la barra de navegación.

Conviene revisarlos al trabajar la rama P2.

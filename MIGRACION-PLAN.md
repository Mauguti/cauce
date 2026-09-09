# Plan de migración visual — Digsol Factory → consola

Adoptar la identidad visual de Digsol Factory (paquete en `design-export/`)
en la consola. **Regla dura:** backend, orquestador, rutas de API, lógica
de sesiones e integraciones NO se tocan. Solo capa visual y copy.

## 0. Los dos conflictos que hay que resolver ANTES de codear

### A. Sistema de estilo (el grande)

| | Factory (origen) | Consola (destino) |
|---|---|---|
| Framework CSS | **Tailwind** (config inline en `index.html`, vía CDN) | **CSS plano con tokens** (`packages/ui/tokens.css` + `app.css`) |
| Color | Paleta a color: azul/púrpura/naranja/verde + zonas "terminal" oscuras | **Monocromático** (escala de grises estricta) |
| Tipografía | Inter + JetBrains Mono | system-ui |
| Íconos | `lucide-react` | ninguno (glifos/formas CSS) |
| Animación | `framer-motion`, `recharts` | ninguna |

**No es cosmético.** Hay dos caminos y cambian todo el trabajo:

- **Camino 1 — Tailwind en la consola.** Meter Tailwind + preset de
  Factory + fuentes + lucide, y reescribir cada componente con clases
  Factory. Fiel al 100%, pero toca *todos* los componentes y es un
  rediseño con riesgo de regresión en pantallas que ya funcionan en
  producción con clientes reales.
- **Camino 2 — re-skin por tokens (recomendado para la consola).** Sin
  Tailwind: adoptar el *lenguaje visual* de Factory (paleta, Inter/mono,
  radios, sombras, estilo de tarjeta, acentos) reemplazando los tokens del
  `packages/ui/tokens.css` y afinando `app.css`. Mantiene la estructura de
  componentes que ya opera en prod, bajo riesgo, incremental. La landing
  (Parte C) sí se hace fresca en Tailwind usando los componentes exportados
  tal cual.

Recomendación: **Camino 2 para la consola, Tailwind solo para la landing.**
Es una decisión del negocio (fidelidad total vs. riesgo/tiempo) → ver
abajo.

### B. Estados de sesión en escala de grises (accesibilidad, no decoración)

Hoy la consola distingue estados por **forma** (punto sólido = conectada,
aro punteado = QR, aro vacío = desconectada) + color tenue. Factory los
distingue **solo por color** (verde=online, naranja=standby). Adoptar el
esquema de Factory tal cual **rompería** la lectura en gris.

**Regla para toda la migración:** se pueden adoptar los acentos de color de
Factory para el punto, **pero se conserva la diferencia de forma** (sólido
/ punteado / hueco / cruz) para que el estado siga entendiéndose sin color.
Esto aplica a estados de sesión (Sesiones) y a estados de mensaje
(enviado/sin confirmar/fallido en la bitácora).

## 1. Mapeo de pantallas

| Consola actual | Equivalente en Factory | Qué se hace |
|---|---|---|
| Login | Login (acoplado a su Firebase) | Re-skin visual; auth intacta |
| Inicio (dashboard: Primeros pasos + contadores + bitácora) | DashboardHome + ActivationStepper | Re-skin. Contadores = datos reales; el stepper conserva los 3 pasos de la consola (número→CRM→acción), **sin** paso "Pago" |
| Sesiones | (no hay equivalente directo) | Re-skin; conserva estados por forma |
| Conexiones (monday, Bitrix) | IntegrationsGrid | Re-skin de tarjetas; lógica intacta |
| Acciones (Salientes/Entrantes) | (no hay equivalente) | Re-skin |
| Cuenta (badge de plan) | BillingModule | Re-skin; **sin** Stripe (fuera de alcance); se mantiene el contacto-para-contratar |
| — | AgentShowroom / AgentCV / HiringModal / KnowledgeCenter / TraceabilityLogs (con costo) / Telegram / Google | **No se portan**: son conceptos de Factory (agentes, energía, costo, otros canales) que la consola no tiene. No se inventan. |

## 2. Datos que la UI de Factory espera vs. lo que hay hoy

| Dato que espera Factory | ¿Existe en la consola? | Acción |
|---|---|---|
| Contadores enviados/recibidos/fallidos | Sí (reales) | Usar los reales |
| KPIs con gráficas de series (recharts) | No hay series temporales | **PENDIENTE** → estado vacío "Sin datos aún", nunca demo |
| Costo por mensaje / barras de "energía" | No existe | No se porta (no inventar costo) |
| Perfiles de agentes / CV / showroom | No existe (no hay "agentes") | No se porta |
| Logs con nivel + costo | Hay bitácora real sin costo | Mapear a la bitácora; sin columna de costo |
| Planes/tiers de precio, Stripe | No (fuera de alcance) | Mantener badge de plan + contacto |
| Estado de integración Telegram/Google/Gemini | No existe | No se porta |

Regla: donde Factory pinte un número que la consola no tiene → **estado
vacío honesto**, jamás un dato demo (en prod hay conversaciones reales al
lado).

## 3. Conflictos de dependencias

- **Tailwind vs CSS plano** (ver §0.A) — el conflicto central.
- **lucide-react**: Factory lo usa; la consola no tiene íconos. Camino 2:
  opcional, se puede añadir solo lucide (ligero) sin Tailwind.
- **framer-motion / recharts**: solo los usan pantallas de Factory que no
  se portan; **no** se agregan a la consola.
- **react-router-dom**: Factory lo usa; la consola navega por estado
  (`seccion`). No se introduce router.
- Fuentes Inter + JetBrains Mono: por `@fontsource` o Google Fonts.

## 4. Orden de ejecución (pasos chicos, app compilando entre cada uno)

*(Asumiendo Camino 2 para la consola; si el negocio elige Camino 1, el
plan se reescribe por componente.)*

1. **Tokens + fuentes.** Reemplazar la paleta monocromática de
   `packages/ui/tokens.css` por la de Factory (manteniendo nombres de
   token para no tocar los componentes), agregar Inter/mono. Verificar que
   la consola sigue compilando y se ve con la nueva paleta.
2. **Marca / nav / login.** Logo "Digsol/Factory", header, tipografía.
3. **Tarjetas y botones.** Estilo de tarjeta, radios, sombras, acentos de
   Factory en botones/chips.
4. **Estados (sesión + mensaje).** Adoptar acentos de color CONSERVANDO la
   forma (§0.B). Verificar en gris.
5. **Dashboard (Inicio).** Contadores y bitácora con el nuevo estilo;
   PENDIENTE = vacío honesto donde no haya dato.
6. **Conexiones / Acciones / Cuenta.** Re-skin final.

Cada paso: un commit, app compilando, verificación en navegador.

## 5. Riesgos

- Regresión visual en pantallas que ya usan clientes reales (mitiga:
  Camino 2, pasos chicos, verificación por paso).
- Romper la accesibilidad en gris de los estados (mitiga: §0.B, regla
  dura).
- Introducir Tailwind (Camino 1) puede chocar con el CSS global existente
  y alargar mucho el bloque.
- Assets: Factory no trae logos locales (todo remoto/CDN); falta el SVG del
  logo Digsol Factory como asset local.

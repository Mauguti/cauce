# Screens — Digsol Factory

---

## 1. Landing Page (`/`)

### Structure
```
Navbar (fixed top, blurred bg)
  Logo (Command icon + "Digsol/Factory") | Nav links (Agentes, Metricas, Precios) | CTA "Iniciar Sistema"

Hero section (pt-32 pb-20)
  Left column: Badge "SISTEMA OPERATIVO v2.0" | H1 "Tu Fabrica de Empleados Digitales" | Body copy | 2 CTAs | Trust badges "Sin IMSS" "24/7/365"
  Right column (lg only): "Panel de Control" card mockup with 3 agent toggle rows + "100% OPERATIVO" badge

AgentShowroom section (#agents, bg-sys-surface)
  Header: "El Dream Team" | "Ver Todos" button
  3-column grid of agent cards:
    Each card: Avatar (grayscale->color on hover) + Name + Status dot + Role + Description (3-line clamp)
    Skills list with checkboxes | 2 buttons: "Ver CV" + "Contratar"

DashboardPreview section (#dashboard, bg-white)
  Center heading: "Transformamos el caos administrativo en claridad operativa"
  2-column layout:
    Left (2/3): Area chart (Recharts) comparing "Nomina Tradicional vs Digsol"
    Right (1/3): 3 KPI cards stacked (Horas Ahorradas 160h+, Consumo Energia, Estado de Fabrica)

Pricing section (#billing, bg-sys-surface)
  Center heading: "Pricing Console"
  2-column grid:
    Left: Membresia Base card ($1,200/mes MXN) with feature list + CTA
    Right: Consumo de Energia card with pricing table (servicio $0, utilidad ~$0.15, marketing ~$0.08) + optimization note

Footer
  Logo | Copyright | Links (Terminos, Privacidad, Estado del Servicio)
```

### Visual Hierarchy
- Dot-pattern background on hero
- Cards with `shadow-clean` -> `shadow-card` on hover
- Grayscale agent avatars that colorize on hover
- Blinking cursor `_` on primary CTAs
- Accent color gradient blobs behind hero card

---

## 2. Agent CV (`/cv-agente/:id`)

### Structure
```
Navbar
Back button "Volver a la Fabrica"
CV Document (white card, min-h 800px):
  Left sidebar (1/3, bg-sys-surface):
    Avatar (grayscale, round) | Name | Role | "DISPONIBLE" badge
    Skills list (checkboxes) | Certifications list (BadgeCheck icons)
  Right content (2/3):
    Header: "CURRICULUM VITAE" | Agent ID
    Perfil Operativo: description paragraph
    Experiencia & Casos de Uso: cards with CheckSquare icons
    CTA: "INICIAR CONTRATACION" full-width
Footer
```

---

## 3. Login (`/login`)

### Structure
```
Dot-pattern background
Centered card (max-w-md, white):
  Command icon + "Digsol Factory" + "Sistema Operativo de Agentes Cognitivos"
  Tab bar: "Iniciar Sesion" (only one tab)
  Error banner (conditionally)
  Google button (with inline SVG "G" icon)
  Divider "O ingresa con Email"
  Email input (font-mono placeholder)
  Password input (show/hide toggle)
  Submit "INGRESAR A CONSOLA" button
  Footer: Lock icon + "Conexion Segura -- Firebase Auth (TLS 1.3)"
Build version footer
```

---

## 4. Setup Password (`/setup-password`)

### Structure
```
Dot-pattern background + gradient blobs
Centered card (max-w-md):
  Command icon + "Bienvenido a Digsol Factory"
  Gradient top bar (blue -> purple -> green)
  "CONFIGURACION DE ACCESO" shield badge
  Password input + strength indicator (4-segment bar)
  Confirm password input + match indicator
  Submit "ACTIVAR MI CONSOLA" button
  Security footer
```

---

## 5. Dashboard Layout (`/dashboard/*`)

### Structure
```
Full-height flex layout:
  Sidebar (w-64, fixed):
    Brand header (Command + "Digsol/Factory")
    Navigation links:
      - Dashboard (LayoutDashboard)
      - ADN / Conocimiento (Dna)
      - Agentes Activos (Bot)
      - Integraciones (Plug)
      - Billing & Energia (CreditCard)
      - Trazabilidad (TerminalSquare)
    User profile footer (avatar/initials + name + email + Settings gear)

  Main content:
    Top bar: "STATUS: CONNECTED / Production Environment" | "API GATEWAY: ONLINE"
    Scrollable content (bg #FAFAFA):
      ActivationStepper banner (conditionally)
      <Outlet /> (child route content)

  PanicButton (floating bottom-right)
```

---

## 6. Dashboard Home (`/dashboard` index)

### Structure
```
Header: "Panel de Control" + "LIVE METRICS" badge
4-column KPI grid: ROI +312% | Leads 1,240 | Flujo $84.5k | Latencia 1.2s
"Unidades Operativas" section:
  3-column grid:
    Santiago card: Avatar+status | 2x2 metric grid (Conversion, Citas, Pipeline) | Mini bar chart (Recharts) | Pausar/Ajustar buttons
    Elena card: Avatar+STANDBY status | 3 stat rows (Morosidad, Cobrado, Facturas) | Progress bar (85%) | Reanudar/Ajustar buttons
    Mateo card: Avatar+status | 2x2 metrics (T.Respuesta 12s, Leads, Sentimiento 98%) | Dark "TRAFICO EN VIVO" indicator | Pausar/Ajustar buttons
```

---

## 7. Activation Stepper (banner in dashboard)

### Structure
```
Gradient top bar (blue -> purple -> green)
Header: Zap icon + "Progreso de Activacion" + "Paso X de 3" + minimize X
Animated progress bar
3-step horizontal layout:
  Step 1: Conexion WhatsApp (MessageSquare icon)
  Step 2: Integraciones (Plug icon)
  Step 3: Pago y Activacion (CreditCard icon)
Each step: done (green bg) | active (blue bg, ring) | locked (gray bg, Lock icon)
Minimized view: single-line bar with 3 dot segments
```

---

## 8. Agents Module (`/dashboard/agents`)

### Structure
```
Header: "Gestion de Agentes"
3-column grid:
  Each agent card:
    Header: Avatar + Name + Role | Toggle switch (active/inactive)
    3 sliders: Formalidad, Empatia, Proactividad (range 0-100)
    Footer: "VER PERFIL DE PUESTO" button
AgentDetailsSidebar (slide-in from right):
  Header: Avatar + name + role + ONLINE/OFFLINE badge
  Calibracion Actual: 3 progress bars (read-only)
  Live Terminal Logs: Dark bg terminal with expandable log entries
```

---

## 9. Knowledge Center (`/dashboard/knowledge`)

### Structure (5 tabs)
```
Header: "ADN de Negocio"
Tab bar: General | Productos | Restricciones | Voz | Marca
  General: Company name, industry, description textareas
  Products: Product list + add/edit modal (name, description, price, image URL)
  Constraints: Never-say phrases, mandatory rules, hours
  Voice: Tone sliders (formality, empathy, verbosity), sample phrases
  Brand: Brand color picker (preset palette + custom hex), logo URL, tagline
Each tab has a "Guardar Cambios" button
```

---

## 10. Integrations Grid (`/dashboard/integrations`)

### Structure
```
Header: "Integraciones" + active/pending count badges
4 category sections:
  Canales de Comunicacion: WhatsApp, Telegram, Instagram, Messenger
  Gestion de Informacion: Sheets, Notion, Odoo, Salesforce, Bitrix24, Monday, ClickUp, HubSpot, Pipedrive, Zoho
  Agendas y Citas: Google Calendar, Apple Calendar, Outlook, Cron
  Procesadores de Pago: Stripe, Mercado Pago, Clip, PayPal
Each category: Icon + label + description + search bar + card grid
Each card: Logo + name + status badge + action button (Seleccionar/Conectar/Configurar)
Security footer: OAuth 2.0 notice
Modals: WhatsAppQRConnect, TelegramConnectModal, ApiKeyModal
```

---

## 11. Billing Module (`/dashboard/billing`)

### Structure
```
Header: "Billing & Energia" + "Historial" button
3-column layout:
  Left column:
    Dark membership card (#0F172A): $1,200 MXN/mes, renewal date, saved card display, status badge
    Stripe card form (conditionally): CardElement with dark theme
    Energy wallet card: $250 USD balance, progress bar, "Recargar Saldo"
  Right columns (2/3):
    Consumption chart (Recharts horizontal bar): per-agent token usage
    Summary table: Agent | Tokens | Cost
    Security footer: "STRIPE . PCI DSS . AES-256"
```

---

## 12. Traceability Logs (`/dashboard/logs`)

### Structure
```
Full-height dark terminal (#0F172A):
  Toolbar (#1E293B): "LIVE_TERMINAL_V2" | Filter pills (All/Santiago/Elena/Mateo) | Search "Grep logs..." | Download
  Log rows: [timestamp] AGENT LEVEL message $cost
  Blinking cursor "_"
  Footer: "Status: LISTENING" | event count
```

---

## 13. HiringModal (overlay)

### Structure
```
Backdrop (blur)
Modal card:
  Step 1 "selection": "Contratar a {name}" | 2 options:
    - "Hablar ahora (Fast Track)" -> WhatsApp link
    - "Agendar Levantamiento" -> Step 2
  Step 2 "form": Back button | "Agendar Sesion"
    Phone input, date input, time input | "CONFIRMAR AGENDA" button
  Footer: Transaction ID
```

---

## 14. Onboarding Modal (overlay)

### Structure
```
Backdrop (blur)
Modal card:
  Top accent bar (solid sys-text)
  Header: "Configuremos tu Factory" | "ADN._init" badge
  Step dots (2 steps)
  Step 0 "Negocio": Company name, sector chips, agent selection
  Step 1 "Marca": 3 tone sliders, ideal phrases textarea
  Success screen: Check icon + "Factory Configurada!" + "Ir a Conectar mis Herramientas"
```

---

## 15. Account Settings (overlay)

### Structure
```
Backdrop (blur)
Modal card (max-w-2xl):
  Gradient top bar
  3-tab layout: Usuarios | Seguridad | Sesion
  Usuarios: Invite form (name + email) + authorized users list
  Seguridad: Current account info + password reset button
  Sesion: Active session info + logout button
```

# Design Export — Digsol Factory

Portable design, identity, and content package extracted from the Digsol Factory project.
Use this to bootstrap a new React + Vite + Tailwind project with the same visual system.

---

## Prerequisites

| Dependency              | Version     | Purpose                        |
|-------------------------|-------------|--------------------------------|
| `react`                 | `^19.2.4`   | Core framework                 |
| `react-dom`             | `^19.2.4`   | DOM renderer                   |
| `react-router-dom`      | `6.22.3`    | Routing (only if using Navbar) |
| `lucide-react`          | `^0.563.0`  | Icon library                   |
| `framer-motion`         | `^12.34.2`  | Animations (DashboardTour)     |
| `recharts`              | `^3.7.0`    | Charts (DashboardPreview only) |
| `tailwindcss`           | `^4.x`      | Styling                        |
| `@tailwindcss/vite`     | `^4.x`      | Vite plugin for Tailwind       |

---

## Installation Steps

### 1. Create a new project

```bash
npm create vite@latest my-project -- --template react-ts
cd my-project
```

### 2. Install dependencies

```bash
npm install react-router-dom@6.22.3 lucide-react@^0.563.0 framer-motion@^12.34.2 recharts@^3.7.0
npm install -D tailwindcss @tailwindcss/vite
```

### 3. Configure Tailwind

Copy `tailwind.preset.js` to your project root.

In your `tailwind.config.ts`:

```ts
import factoryPreset from './tailwind.preset.js';

export default {
  presets: [factoryPreset],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
};
```

### 4. Add CSS tokens

Copy `tokens.css` into your `src/` directory and import it in your `main.tsx`:

```ts
import './tokens.css';
```

### 5. Load fonts

Add to your `index.html` `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

### 6. Copy components

Copy the `components/` directory into your `src/components/design-system/` or wherever
your UI components live.

### 7. Load content

Import `content/copy.json` wherever you need text:

```ts
import copy from './content/copy.json';
// usage: copy.hero.headline, copy.pricing.membership.price, etc.
```

---

## What's Inside

| File/Directory          | Description                                           |
|-------------------------|-------------------------------------------------------|
| `DESIGN-SYSTEM.md`     | Complete token reference (colors, typography, etc.)   |
| `COMPONENT-MAP.md`     | Every component with source, deps, coupling status    |
| `SCREENS.md`           | Screen-by-screen structure and layout descriptions    |
| `tokens.css`           | CSS custom properties ready to paste                  |
| `tailwind.preset.js`   | Tailwind preset with theme extensions                 |
| `content/copy.json`    | All UI text with semantic keys                        |
| `components/`          | Desacoplado visual components (props-driven)          |
| `assets/ASSETS.md`     | Asset inventory (all remote, no local files)          |

---

## Exported Components

These components are decoupled from Firebase and business logic. All data comes via props.

| Component          | Original File           | Notes                                |
|--------------------|-------------------------|--------------------------------------|
| `Hero.tsx`         | `components/Hero.tsx`   | Fully props-driven                   |
| `Footer.tsx`       | `components/Footer.tsx` | Fully props-driven                   |
| `Pricing.tsx`      | `components/Pricing.tsx`| Fully props-driven                   |
| `HiringModal.tsx`  | `components/HiringModal.tsx` | Callbacks replace WhatsApp links |
| `TraceabilityLogs.tsx` | `dashboard/TraceabilityLogs.tsx` | Logs passed as props      |
| `DashboardTour.tsx`| `dashboard/DashboardTour.tsx` | Fully props-driven             |
| `PanicButton.tsx`  | `components/PanicButton.tsx`  | Callback replaces WA link      |

---

## Not Exported (and why)

| Component             | Reason                                                    |
|-----------------------|-----------------------------------------------------------|
| `Login.tsx`           | Tightly coupled to Firebase Auth (signInWithPopup, etc.)  |
| `SetupPassword.tsx`   | Firebase Auth (createUserWithEmailAndPassword)            |
| `DashboardLayout.tsx` | Firebase Auth + Firestore + routing + 5 child components  |
| `DashboardHome.tsx`   | Could be exported but has hardcoded mock data and Recharts; partial coupling |
| `ActivationStepper.tsx`| Firebase Firestore reads/writes for step state           |
| `AgentsModule.tsx`    | Close to exportable but references `constants.ts` types   |
| `AgentDetailsSidebar.tsx` | Mostly visual but has embedded mock data             |
| `KnowledgeCenter.tsx` | Firebase + Gemini AI API (process.env.API_KEY)            |
| `IntegrationsGrid.tsx`| Firebase + n8n webhooks + 2 modal sub-components          |
| `BillingModule.tsx`   | Stripe Elements + Firebase                                |
| `AccountSettings.tsx` | Firebase Auth + Firestore for user management             |
| `OnboardingModal.tsx` | Firebase Firestore for persistence                        |
| `WhatsAppQRConnect.tsx`| n8n webhooks + Firebase                                  |
| `TelegramConnectModal.tsx`| n8n webhooks + Firebase + custom hook                |
| `AgentShowroom.tsx`   | Partially exportable but coupled to react-router + HiringModal |
| `AgentCV.tsx`         | react-router params + HiringModal                         |
| `Navbar.tsx`          | react-router Links (could be replaced with `<a>` easily) |
| `DashboardPreview.tsx`| Could be exported but Recharts chart is tightly integrated|

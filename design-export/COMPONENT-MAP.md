# Component Map — Digsol Factory

## Legend

- **Desacoplado:** Can be reused in another project with minimal changes (props-driven)
- **Acoplado:** Depends on Firebase, react-router, or business logic that must be replaced

---

## Landing Page Components

| Component          | File                              | Screen(s)           | Dependencies                          | Desacoplado |
|--------------------|-----------------------------------|----------------------|---------------------------------------|-------------|
| Navbar             | `components/Navbar.tsx`           | Landing, CV          | `react-router-dom`, `lucide-react`    | Partial     |
| Hero               | `components/Hero.tsx`             | Landing `/`          | `lucide-react`                        | YES         |
| AgentShowroom      | `components/AgentShowroom.tsx`    | Landing `/`          | `constants.ts`, `types.ts`, HiringModal, `react-router-dom` | Partial |
| DashboardPreview   | `components/DashboardPreview.tsx` | Landing `/`          | `recharts`, `lucide-react`            | YES         |
| Pricing            | `components/Pricing.tsx`          | Landing `/`          | `constants.ts`, `lucide-react`        | YES         |
| Footer             | `components/Footer.tsx`           | Landing, CV          | None                                  | YES         |
| AgentCV            | `components/AgentCV.tsx`          | `/cv-agente/:id`     | `constants.ts`, HiringModal, `react-router-dom` | Partial |
| HiringModal        | `components/HiringModal.tsx`      | Landing, CV          | `types.ts` (AgentProfile)             | YES         |

## Auth Components

| Component          | File                              | Screen(s)            | Dependencies                          | Desacoplado |
|--------------------|-----------------------------------|----------------------|---------------------------------------|-------------|
| Login              | `components/Login.tsx`            | `/login`             | Firebase Auth, Firestore, `react-router-dom` | NO    |
| SetupPassword      | `components/SetupPassword.tsx`    | `/setup-password`    | Firebase Auth, Firestore, `react-router-dom` | NO    |

## Dashboard Components

| Component          | File                                          | Screen(s)                  | Dependencies                                    | Desacoplado |
|--------------------|-----------------------------------------------|----------------------------|--------------------------------------------------|-------------|
| DashboardLayout    | `components/dashboard/DashboardLayout.tsx`    | `/dashboard/*` (wrapper)   | Firebase Auth+Firestore, react-router, DashboardTour, AccountSettings, ActivationStepper | NO |
| DashboardHome      | `components/dashboard/DashboardHome.tsx`      | `/dashboard`               | `recharts`, `lucide-react`, `react-router-dom`   | Partial     |
| ActivationStepper  | `components/dashboard/ActivationStepper.tsx`  | `/dashboard` (banner)      | Firebase Firestore, `framer-motion`, `react-router-dom` | NO    |
| AgentsModule       | `components/dashboard/AgentsModule.tsx`       | `/dashboard/agents`        | `constants.ts`, AgentDetailsSidebar              | Partial     |
| AgentDetailsSidebar| `components/dashboard/AgentDetailsSidebar.tsx`| `/dashboard/agents` (sidebar)| `types.ts` (mock data inside)                  | YES         |
| KnowledgeCenter    | `components/dashboard/KnowledgeCenter.tsx`    | `/dashboard/knowledge`     | Firebase Auth+Firestore, Gemini API (`process.env.API_KEY`) | NO |
| IntegrationsGrid   | `components/dashboard/IntegrationsGrid.tsx`   | `/dashboard/integrations`  | Firebase Firestore, WhatsAppQRConnect, TelegramConnectModal, useGoogleIntegration | NO |
| BillingModule      | `components/dashboard/BillingModule.tsx`      | `/dashboard/billing`       | Stripe (`@stripe/react-stripe-js`), Firebase Auth+Firestore | NO |
| TraceabilityLogs   | `components/dashboard/TraceabilityLogs.tsx`   | `/dashboard/logs`          | `lucide-react` (mock data)                       | YES         |
| DashboardTour      | `components/dashboard/DashboardTour.tsx`      | `/dashboard` (overlay)     | `framer-motion`                                  | YES         |
| OnboardingModal    | `components/dashboard/OnboardingModal.tsx`    | `/dashboard` (modal)       | Firebase Firestore, `framer-motion`, `react-router-dom` | NO    |
| AccountSettings    | `components/dashboard/AccountSettings.tsx`    | `/dashboard` (modal)       | Firebase Auth+Firestore, `framer-motion`, `react-router-dom` | NO |
| WhatsAppQRConnect  | `components/dashboard/WhatsAppQRConnect.tsx`  | `/dashboard/integrations`  | Firebase Firestore, n8n webhook, `framer-motion` | NO          |
| TelegramConnectModal| `components/dashboard/TelegramConnectModal.tsx`| `/dashboard/integrations` | Firebase Firestore, n8n webhook, useTelegramStatus | NO       |
| PanicButton        | `components/PanicButton.tsx`                  | `/dashboard/*` (floating)  | `lucide-react` (hardcoded WhatsApp link)         | YES         |

## Hooks

| Hook                  | File                              | Dependencies        | Desacoplado |
|-----------------------|-----------------------------------|---------------------|-------------|
| useGoogleIntegration  | `hooks/useGoogleIntegration.ts`   | Firebase Firestore  | NO          |
| useTelegramStatus     | `hooks/useTelegramStatus.ts`      | Firebase Firestore  | NO          |

## Data / Config

| File              | Purpose                                   | Desacoplado |
|-------------------|-------------------------------------------|-------------|
| `constants.ts`    | Agent profiles array, pricing features    | YES         |
| `types.ts`        | TypeScript interfaces (AgentProfile, Metric) | YES      |
| `metadata.json`   | Project name & description                | YES         |
| `config/googleOAuth.ts` | Google OAuth client config           | NO (env vars) |

## Pages

| File                    | Route             | Purpose                    |
|-------------------------|-------------------|----------------------------|
| `pages/OAuthCallback.tsx` | `/oauth/callback` | Google OAuth return handler |

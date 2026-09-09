# Design System — Digsol Factory

> Extracted from the live project. All values are from `index.html` inline Tailwind config
> and hardcoded class usage across components.

---

## 1. Color Tokens

### System Colors (semantic)

| Token           | Value     | Usage                                                |
|-----------------|-----------|------------------------------------------------------|
| `sys-bg`        | `#FFFFFF` | Page background, main content area                   |
| `sys-surface`   | `#F9FAFB` | Card backgrounds, sidebar bg, input backgrounds      |
| `sys-border`    | `#E5E7EB` | All borders, dividers, card outlines                  |
| `sys-text`      | `#111827` | Primary text, headings, dark buttons                  |
| `sys-muted`     | `#6B7280` | Secondary text, labels, descriptions                  |

### Accent Colors

| Token            | Value     | Usage                                                |
|------------------|-----------|------------------------------------------------------|
| `accent-blue`    | `#007ACC` | Primary CTA hover, active nav, links, VS Code blue   |
| `accent-purple`  | `#7D4698` | Mateo's agent color, decorative blobs                 |
| `accent-orange`  | `#E37933` | Elena's agent color, standby status, energy bars      |
| `accent-green`   | `#4EC9B0` | Online status, success, WhatsApp accents              |

### Hardcoded Colors (not in theme config)

| Value       | Where used                                                  |
|-------------|-------------------------------------------------------------|
| `#0F172A`   | Dark terminal backgrounds (TraceabilityLogs, AgentSidebar)  |
| `#1E293B`   | Terminal toolbar bg                                         |
| `#F8F9FA`   | Sidebar background (DashboardLayout)                        |
| `#FAFAFA`   | Dashboard scrollable content bg                             |
| `#25D366`   | WhatsApp brand green (buttons, icons)                       |
| `#128C7E`   | WhatsApp hover green                                        |
| `#26A5E4`   | Telegram brand blue                                         |
| `#1C88C0`   | Telegram hover blue                                         |
| `#9CA3AF`   | Chart grid/axis text (gray-400)                             |
| `#F3F4F6`   | Chart grid stroke (gray-100)                                |

### State Color Rules

| State    | Dot color       | Text color      | Badge bg        |
|----------|-----------------|-----------------|-----------------|
| ONLINE   | `accent-green`  | `accent-green`  | `green-50`      |
| STANDBY  | `accent-orange` | `accent-orange` | (no badge)      |
| ERROR    | `red-500`       | `red-500`       | `red-50`        |
| SUCCESS  | `green-400`     | `green-400`     | `green-50`      |
| WARN     | `yellow-400`    | `yellow-400`    | (inline)        |
| INFO     | `blue-400`      | `blue-400`      | (inline)        |

---

## 2. Typography

### Font Families

| Token       | Family                          | Source                           |
|-------------|----------------------------------|----------------------------------|
| `font-sans` | `Inter`, sans-serif              | Google Fonts CDN                 |
| `font-mono` | `JetBrains Mono`, monospace      | Google Fonts CDN                 |

### Font Weights Loaded

- Inter: 300 (light), 400 (normal), 500 (medium), 600 (semibold), 700 (bold)
- JetBrains Mono: 400, 500, 600

### Typography Scale (from Tailwind defaults)

| Class           | Size   | Where used                     |
|-----------------|--------|--------------------------------|
| `text-6xl`      | 3.75rem| Hero h1 (md+)                  |
| `text-5xl`      | 3rem   | Hero h1 (base)                 |
| `text-4xl`      | 2.25rem| Dashboard preview h2 (md+)     |
| `text-3xl`      | 1.875rem| Section headings, KPI values  |
| `text-2xl`      | 1.5rem | Page titles, dashboard home h1 |
| `text-xl`       | 1.25rem| Modal headings                 |
| `text-lg`       | 1.125rem| Card titles, body text        |
| `text-base`     | 1rem   | General body                   |
| `text-sm`       | 0.875rem| Labels, descriptions          |
| `text-xs`       | 0.75rem| Badges, meta text, mono labels |
| `text-[10px]`   | 10px   | Status badges, chart labels    |
| `text-[10px]` + `font-mono` | | UPPERCASE tracking-wider pattern for system labels |

### Typography Patterns

- **Section headers:** `text-3xl font-bold text-sys-text`
- **Page titles (dashboard):** `text-2xl font-bold text-sys-text`
- **Card titles:** `font-bold text-sys-text text-lg`
- **Mono system labels:** `text-xs font-mono font-bold text-sys-muted uppercase tracking-wider`
- **Status badges:** `text-[10px] font-mono font-bold tracking-wider`
- **Body copy:** `text-sm text-sys-muted leading-relaxed` or `text-lg text-sys-muted`

---

## 3. Spacing Scale

Standard Tailwind spacing (4px base). Most frequently used:

| Token | Value | Common usage                    |
|-------|-------|---------------------------------|
| `p-4` | 16px  | Card padding, nav items         |
| `p-6` | 24px  | Section padding, card bodies    |
| `p-8` | 32px  | Modal padding, page content     |
| `gap-2`| 8px  | Between small elements          |
| `gap-3`| 12px | Between medium elements         |
| `gap-4`| 16px | Between cards (grid), sections  |
| `gap-6`| 24px | Dashboard grid gaps             |
| `gap-8`| 32px | Landing section gaps            |
| `mb-6`| 24px  | Section bottom margin           |
| `py-20`| 80px | Landing section vertical padding|

**Max widths:**
- `max-w-7xl` (80rem): Landing page content
- `max-w-6xl` (72rem): Dashboard content
- `max-w-4xl` (56rem): Pricing grid
- `max-w-md` (28rem): Login card, modals
- `max-w-xl` (36rem): Onboarding modal
- `max-w-2xl` (42rem): Account settings modal

---

## 4. Border Radius

| Class         | Value  | Where used                    |
|---------------|--------|-------------------------------|
| `rounded`     | 4px    | Buttons, inputs               |
| `rounded-md`  | 6px    | Nav items                     |
| `rounded-lg`  | 8px    | Cards, modals, inputs         |
| `rounded-xl`  | 12px   | Section cards, main containers|
| `rounded-full`| 9999px | Avatars, status dots, pills   |
| `rounded-sm`  | 2px    | CV document container         |
| `rounded-2xl` | 16px   | QR code container             |
| `rounded-[2px]`| 2px   | Skill checkboxes              |

---

## 5. Shadows

### Defined in Theme

| Token         | Value                                                               | Usage              |
|---------------|---------------------------------------------------------------------|--------------------|
| `shadow-clean`| `0 1px 2px 0 rgba(0,0,0,0.05)`                                     | Subtle card shadow |
| `shadow-card` | `0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -1px rgba(0,0,0,0.02)`| Card hover shadow  |

### Tailwind Built-in (also used)

| Class        | Usage                              |
|--------------|------------------------------------|
| `shadow-sm`  | Active nav items, subtle elevation |
| `shadow-lg`  | CTA buttons, hero badge            |
| `shadow-xl`  | Hero card, login card              |
| `shadow-2xl` | Sidebar overlay, modals            |

---

## 6. Animations & Transitions

### Custom Keyframes

```css
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.animate-blink { animation: blink 1s step-end infinite; }
```

### Tailwind Utilities Used

| Class              | Effect                              |
|--------------------|-------------------------------------|
| `animate-spin`     | Loading spinners                    |
| `animate-pulse`    | Status dots (online/connected)      |
| `animate-ping`     | Beacon effect (live status)         |
| `animate-blink`    | Cursor blink in CTAs (custom)       |
| `transition-colors`| Almost all interactive elements     |
| `transition-all`   | Cards, buttons with transform       |
| `duration-300`     | Standard transition speed           |

### Framer Motion Patterns

- **Modals:** `scale: 0.95 -> 1`, `opacity: 0 -> 1`, spring stiffness 350-400
- **Slides:** `x: 40 -> 0` for tab transitions
- **Progress bars:** animated `width` percentage
- **Overlays:** `opacity: 0 -> 1`

---

## 7. Background Patterns

| Pattern                                                     | Where             |
|-------------------------------------------------------------|-------------------|
| `bg-[radial-gradient(#E5E7EB_1px,transparent_1px)]` 20x20px| Hero, Login bg    |
| `bg-[radial-gradient(#334155_1px,transparent_1px)]` 10x10px | Live traffic card (dark)|
| Gradient blobs: `bg-accent-blue/5 blur-3xl`                 | Hero right, login |
| `bg-gradient-to-r from-accent-blue via-accent-purple to-accent-green` | Stepper top bar |
| `bg-gradient-to-r from-blue-600 to-cyan-500`                | Stripe button     |

---

## 8. Selection Style

```css
::selection {
  background: #007ACC;
  color: white;
}
```

---

## 9. Dark Mode

**Not implemented.** The project is light-mode only. Some components (TraceabilityLogs,
AgentDetailsSidebar feed, BillingModule membership card, live traffic indicator) use
dark backgrounds (`#0F172A`, `#1E293B`) as isolated "terminal" UI zones, not as a
system-wide dark mode.

---

## 10. CSS Methodology

- **No CSS files exist.** All styling is done via Tailwind CSS loaded from CDN
  (`cdn.tailwindcss.com`) with an inline `tailwind.config` in `index.html`.
- No PostCSS, no `@apply`, no CSS modules.
- The only `<style>` block contains `body` defaults, `::selection`, and the
  `@keyframes blink` animation.

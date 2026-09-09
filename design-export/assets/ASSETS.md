# Assets — Digsol Factory

## Local Assets

**None.** The project has zero local image files, SVGs, fonts, or icons on disk.

---

## Remote Assets

### Agent Avatars (Firebase Storage)

All three agent avatars are hosted on Firebase Storage under the
`digsol-fabrica-de-empleados` bucket. They are AI-generated portrait images (PNG).

| Agent    | URL |
|----------|-----|
| Santiago | `https://firebasestorage.googleapis.com/v0/b/digsol-fabrica-de-empleados.firebasestorage.app/o/Gemini_Generated_Image_795tu8795tu8795t%20(1).png?alt=media&token=7066292f-4767-4aa2-bccb-0f0fdb9ab0bf` |
| Elena    | `https://firebasestorage.googleapis.com/v0/b/digsol-fabrica-de-empleados.firebasestorage.app/o/Gemini_Generated_Image_ysrclqysrclqysrc%20(1).png?alt=media&token=cc6f4686-8c6f-4ac6-b6ed-8e221a47ae83` |
| Mateo    | `https://firebasestorage.googleapis.com/v0/b/digsol-fabrica-de-empleados.firebasestorage.app/o/Gemini_Generated_Image_la3ckola3ckola3c%20(1).png?alt=media&token=075b0e00-50ec-4637-95c9-1b609841372d` |

**To reuse:** Download these and place them in your project's `public/avatars/` directory,
then update the `avatar` URLs in your constants/copy.

### Integration Logos (CDN)

Used in IntegrationsGrid for service logos:

| Service  | Source |
|----------|--------|
| Telegram | `https://cdn.simpleicons.org/telegram/ffffff` (white icon on colored bg) |

All other integration logos are referenced as `simpleicons.org` SVGs loaded at runtime.

### Fonts (Google Fonts CDN)

| Font | Weights | URL |
|------|---------|-----|
| Inter | 300, 400, 500, 600, 700 | `https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap` |
| JetBrains Mono | 400, 500, 600 | `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap` |

No local font files (woff/woff2/ttf/otf) exist in the project.

---

## Icon Library

| Library      | Package        | Version    |
|--------------|----------------|------------|
| Lucide React | `lucide-react` | `^0.563.0` |

All icons are imported individually from `lucide-react`. No other icon library is used.

### Most-used icons across the project

`X`, `Check`, `ChevronRight`, `Loader2`, `AlertTriangle`, `MessageSquare`,
`Zap`, `ArrowLeft`, `ArrowRight`, `Search`, `Download`, `Terminal`,
`Shield`, `Command`, `LayoutDashboard`, `Bot`, `Plug`, `CreditCard`,
`TerminalSquare`, `Dna`, `Settings`, `ToggleRight`, `Sliders`,
`CheckCircle2`, `TrendingUp`, `Clock`, `Activity`, `Info`,
`Users`, `UserPlus`, `Mail`, `KeyRound`, `Crown`, `LogOut`, `Trash2`,
`Lock`, `Eye`, `EyeOff`, `Building2`, `Palette`, `RefreshCw`,
`Smartphone`, `Wifi`, `Calendar`, `ClipboardList`, `FileText`,
`BadgeCheck`, `CheckSquare`, `Save`, `Edit2`, `Plus`, `HelpCircle`,
`Image`, `DollarSign`, `UploadCloud`, `Mic2`, `ShoppingBag`,
`ShieldAlert`, `AlertCircle`, `Filter`, `MessageCircleQuestion`,
`Key`, `Bot` (duplicated).

---

## Logo

There is **no logo file**. The brand mark is rendered as text:

```
<Command size={20} /> Digsol<span>/Factory</span>
```

The `Command` icon from `lucide-react` serves as the logomark.
To create a standalone logo, export the `Command` icon as SVG and pair it
with "Digsol/Factory" in Inter Bold + Inter Normal.

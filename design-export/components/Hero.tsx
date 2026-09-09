import React from 'react';
import { ToggleRight, CheckCircle2, Sliders } from 'lucide-react';

interface HeroPanelItem {
  area: string;
  agent: string;
  initial: string;
  color: string;
}

interface HeroProps {
  badge?: string;
  headline?: string;
  body?: string;
  ctaPrimary?: string;
  ctaSecondary?: string;
  trustBadges?: string[];
  panelTitle?: string;
  panelItems?: HeroPanelItem[];
  roiBadgeLabel?: string;
  roiBadgeValue?: string;
  onCtaPrimary?: () => void;
  onCtaSecondary?: () => void;
}

const Hero: React.FC<HeroProps> = ({
  badge = 'SISTEMA OPERATIVO v2.0',
  headline = 'Tu Fábrica de\nEmpleados Digitales',
  body = 'No vendemos software, vendemos capacidad operativa. Contrata una fuerza de trabajo cognitiva que no duerme, no paga IMSS y escala con tu negocio.',
  ctaPrimary = '>_ CONFIGURAR MI EQUIPO',
  ctaSecondary = 'Ver Demo',
  trustBadges = ['Sin IMSS', '24/7/365'],
  panelTitle = 'Panel de Control',
  panelItems = [
    { area: 'Ventas & Prospección', agent: 'Santiago', initial: 'S', color: 'text-accent-blue' },
    { area: 'Administración', agent: 'Elena', initial: 'E', color: 'text-accent-orange' },
    { area: 'Estrategia Digital', agent: 'Mateo', initial: 'M', color: 'text-accent-purple' },
  ],
  roiBadgeLabel = 'CAPACIDAD ACTUAL',
  roiBadgeValue = '100% OPERATIVO',
  onCtaPrimary,
  onCtaSecondary,
}) => {
  return (
    <section className="pt-32 pb-20 bg-sys-bg relative overflow-hidden">
      {/* Background Dots */}
      <div className="absolute inset-0 bg-[radial-gradient(#E5E7EB_1px,transparent_1px)] [background-size:20px_20px] opacity-50 pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">

          {/* Left: Copy */}
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sys-surface border border-sys-border mb-6">
              <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
              <span className="text-xs font-mono font-medium text-sys-muted">{badge}</span>
            </div>

            <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-sys-text mb-6 leading-tight whitespace-pre-line">
              {headline}
            </h1>

            <p className="text-lg text-sys-muted mb-8 leading-relaxed max-w-lg">{body}</p>

            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <button
                onClick={onCtaPrimary}
                className="flex items-center justify-center bg-sys-text text-white px-8 py-4 rounded font-mono text-sm font-bold shadow-card hover:shadow-lg hover:-translate-y-0.5 transition-all group"
              >
                {ctaPrimary}
                <span className="ml-1 animate-blink text-accent-green">_</span>
              </button>

              <button
                onClick={onCtaSecondary}
                className="flex items-center justify-center gap-2 bg-white border border-sys-border text-sys-text px-8 py-4 rounded font-medium hover:bg-sys-surface transition-colors"
              >
                {ctaSecondary}
              </button>
            </div>

            <div className="mt-10 flex items-center gap-6 text-sm text-sys-muted font-mono">
              {trustBadges.map((badge, i) => (
                <span key={i} className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-accent-green" /> {badge}
                </span>
              ))}
            </div>
          </div>

          {/* Right: Visual Concept */}
          <div className="relative hidden lg:block">
            <div className="absolute top-10 right-10 w-64 h-64 bg-accent-blue/5 rounded-full blur-3xl" />
            <div className="absolute bottom-10 left-10 w-64 h-64 bg-accent-purple/5 rounded-full blur-3xl" />

            <div className="bg-white border border-sys-border rounded-xl shadow-xl p-6 relative">
              <div className="flex justify-between items-center border-b border-sys-border pb-4 mb-4">
                <h3 className="font-bold text-sys-text flex items-center gap-2">
                  <Sliders size={18} /> {panelTitle}
                </h3>
                <div className="flex gap-1">
                  <div className="w-3 h-3 rounded-full bg-sys-border" />
                  <div className="w-3 h-3 rounded-full bg-sys-border" />
                </div>
              </div>

              <div className="space-y-4">
                {panelItems.map((item, i) => (
                  <div key={i} className="flex items-center justify-between p-4 bg-sys-surface rounded-lg border border-sys-border">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded bg-white border border-sys-border flex items-center justify-center font-bold ${item.color}`}>
                        {item.initial}
                      </div>
                      <div>
                        <h4 className="font-bold text-sm">{item.area}</h4>
                        <p className="text-xs text-sys-muted font-mono">Agente: {item.agent}</p>
                      </div>
                    </div>
                    <ToggleRight size={32} className="text-accent-green cursor-pointer" />
                  </div>
                ))}
              </div>

              <div className="absolute -bottom-6 -right-6 bg-sys-text text-white px-4 py-3 rounded-lg shadow-lg">
                <p className="text-xs text-gray-400 font-mono mb-1">{roiBadgeLabel}</p>
                <p className="text-xl font-bold flex items-center gap-2">
                  100% <span className="text-accent-green text-sm font-normal">{roiBadgeValue.replace('100% ', '')}</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;

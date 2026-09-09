import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Check } from 'lucide-react';

interface TourStep {
  targetId: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'right' | 'left';
}

interface DashboardTourProps {
  steps: TourStep[];
  currentStep: number;
  onNext: () => void;
  onSkip: () => void;
}

const DashboardTour: React.FC<DashboardTourProps> = ({ steps, currentStep, onNext, onSkip }) => {
  const step = steps[currentStep];
  const isLast = currentStep === steps.length - 1;

  const [rect, setRect] = React.useState<DOMRect | null>(null);

  React.useLayoutEffect(() => {
    let el: HTMLElement | null = null;
    let frame: number;

    const updatePosition = () => {
      el = document.getElementById(step.targetId);
      if (el) {
        setRect(el.getBoundingClientRect());
        el.style.outline = '2px solid #1a1a2e';
        el.style.outlineOffset = '4px';
        el.style.borderRadius = '8px';
        el.style.transition = 'outline 0.3s';
      } else {
        frame = requestAnimationFrame(updatePosition);
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      if (el) {
        el.style.outline = '';
        el.style.outlineOffset = '';
      }
    };
  }, [step.targetId]);

  const getBubbleStyle = (): React.CSSProperties => {
    if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const pos = step.position ?? 'bottom';
    const margin = 16;
    switch (pos) {
      case 'bottom': return { position: 'fixed', top: rect.bottom + margin, left: Math.max(12, rect.left), zIndex: 10000, maxWidth: 320 };
      case 'top':    return { position: 'fixed', bottom: window.innerHeight - rect.top + margin, left: Math.max(12, rect.left), zIndex: 10000, maxWidth: 320 };
      case 'right':  return { position: 'fixed', top: rect.top, left: rect.right + margin, zIndex: 10000, maxWidth: 320 };
      case 'left':   return { position: 'fixed', top: rect.top, right: window.innerWidth - rect.left + margin, zIndex: 10000, maxWidth: 320 };
      default:       return { position: 'fixed', top: rect.bottom + margin, left: Math.max(12, rect.left), zIndex: 10000, maxWidth: 320 };
    }
  };

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="overlay"
        className="fixed inset-0 z-[9999] pointer-events-none"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.div
        key={`bubble-${currentStep}`}
        style={getBubbleStyle() as any}
        initial={{ opacity: 0, y: -8, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 280, damping: 22 }}
        className="pointer-events-auto"
      >
        <div className="rounded-xl p-5 bg-white border border-sys-border shadow-xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-sys-text" />

          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-mono text-sys-muted uppercase tracking-wider">
              Paso {currentStep + 1} / {steps.length}
            </span>
            <button onClick={onSkip} className="text-sys-muted/40 hover:text-sys-text transition-colors">
              <X size={14} />
            </button>
          </div>

          <div className="flex items-center gap-1.5 mb-4">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i === currentStep ? 'w-6 bg-sys-text' : i < currentStep ? 'w-2 bg-sys-text/40' : 'w-2 bg-sys-border'
                }`}
              />
            ))}
          </div>

          <h4 className="text-sys-text font-bold text-base mb-1">{step.title}</h4>
          <p className="text-sys-muted text-sm leading-relaxed mb-4">{step.description}</p>

          <button
            onClick={onNext}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-bold text-sm transition-all bg-sys-text text-white hover:bg-accent-blue shadow-card hover:shadow-lg"
          >
            {isLast ? <><Check size={14} /> Entendido, listo!</> : <>Siguiente <ChevronRight size={14} /></>}
          </button>

          {!isLast && (
            <button onClick={onSkip} className="w-full text-center text-xs text-sys-muted/40 hover:text-sys-muted mt-2 transition-colors font-medium">
              Saltar tour
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export default DashboardTour;
export type { TourStep };

import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface PanicButtonProps {
  title?: string;
  body?: string;
  ctaLabel?: string;
  onCtaClick?: () => void;
  hoverLabel?: string;
}

const PanicButton: React.FC<PanicButtonProps> = ({
  title = 'SOS: Soporte Humano',
  body = 'Soy Valeria, Directora de Operaciones. Si tienes dudas técnicas, puedo ayudarte ahora.',
  ctaLabel = 'Hablar con Valeria',
  onCtaClick,
  hoverLabel = 'Soporte Humano',
}) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
      {isOpen && (
        <div className="mb-4 bg-white border border-sys-border shadow-card p-4 rounded-lg max-w-xs">
          <div className="flex justify-between items-start mb-2">
            <h4 className="font-bold text-sm text-sys-text">{title}</h4>
            <button onClick={() => setIsOpen(false)} className="text-sys-muted hover:text-sys-text">
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-sys-muted mb-3">{body}</p>
          <button
            onClick={onCtaClick}
            className="flex justify-center w-full bg-sys-surface hover:bg-gray-100 text-sys-text border border-sys-border text-xs font-medium py-2 rounded transition-colors"
          >
            {ctaLabel}
          </button>
        </div>
      )}

      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`group flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-300 relative
          ${isOpen
            ? 'bg-red-600 text-white scale-105'
            : 'bg-white text-red-600 border-2 border-red-50 hover:bg-red-600 hover:text-white hover:border-red-600 hover:scale-105'
          }`}
      >
        <AlertTriangle size={24} />
        <span className={`absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 -z-10
          ${isOpen ? 'animate-ping' : 'hidden group-hover:animate-ping group-hover:inline-flex'}`}
        />
        <span className="absolute right-full mr-3 bg-sys-text text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {hoverLabel}
        </span>
      </button>
    </div>
  );
};

export default PanicButton;

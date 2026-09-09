import React, { useState, useEffect } from 'react';
import { X, MessageSquare, ClipboardList, ArrowLeft, Calendar, Clock, Smartphone, ChevronRight } from 'lucide-react';

interface HiringModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentName: string;
  agentRole: string;
  agentId: string;
  onFastTrack?: (agentName: string, agentRole: string) => void;
  onSchedule?: (data: { phone: string; date: string; time: string; agentId: string }) => void;
}

const HiringModal: React.FC<HiringModalProps> = ({
  isOpen,
  onClose,
  agentName,
  agentRole,
  agentId,
  onFastTrack,
  onSchedule,
}) => {
  const [step, setStep] = useState<'selection' | 'form'>('selection');
  const [formData, setFormData] = useState({ phone: '', date: '', time: '' });

  useEffect(() => {
    if (isOpen) {
      setStep('selection');
      setFormData({ phone: '', date: '', time: '' });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSchedule?.({ ...formData, agentId });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-sys-text/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-sys-border overflow-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-sys-muted hover:text-sys-text transition-colors z-10">
          <X size={20} />
        </button>

        {step === 'selection' ? (
          <div>
            <div className="mb-6">
              <h3 className="text-xl font-bold text-sys-text mb-1">Contratar a {agentName}</h3>
              <p className="text-sm text-sys-muted">Selecciona el método de onboarding preferido.</p>
            </div>

            <div className="space-y-4">
              <button
                onClick={() => onFastTrack?.(agentName, agentRole)}
                className="flex items-start p-4 border border-sys-border rounded-lg hover:border-accent-green hover:bg-green-50/30 transition-all group w-full text-left"
              >
                <div className="bg-green-100 p-2 rounded-full text-accent-green mr-4 group-hover:bg-accent-green group-hover:text-white transition-colors">
                  <MessageSquare size={20} />
                </div>
                <div>
                  <h4 className="font-bold text-sys-text text-sm">Hablar ahora (Fast Track)</h4>
                  <p className="text-xs text-sys-muted mt-1">Inicia la configuración inmediata vía WhatsApp con un ingeniero de soluciones.</p>
                </div>
              </button>

              <button
                onClick={() => setStep('form')}
                className="flex items-start p-4 border border-sys-border rounded-lg hover:border-accent-blue hover:bg-blue-50/30 transition-all group w-full text-left"
              >
                <div className="bg-blue-100 p-2 rounded-full text-accent-blue mr-4 group-hover:bg-accent-blue group-hover:text-white transition-colors">
                  <ClipboardList size={20} />
                </div>
                <div>
                  <h4 className="font-bold text-sys-text text-sm">Agendar Levantamiento</h4>
                  <p className="text-xs text-sys-muted mt-1">Programar una sesión técnica para definir requerimientos y accesos.</p>
                </div>
                <ChevronRight size={16} className="ml-auto mt-2 text-sys-muted group-hover:text-accent-blue" />
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button onClick={() => setStep('selection')} className="flex items-center text-xs text-sys-muted hover:text-sys-text mb-4 transition-colors font-medium">
              <ArrowLeft size={14} className="mr-1" /> Regresar
            </button>

            <div className="mb-6">
              <h3 className="text-xl font-bold text-sys-text mb-1">Agendar Sesión</h3>
              <p className="text-sm text-sys-muted">Un ingeniero configurará a {agentName} contigo.</p>
            </div>

            <form onSubmit={handleFormSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-sys-text mb-2 font-mono uppercase flex items-center gap-2">
                  <Smartphone size={14} /> WhatsApp de Contacto
                </label>
                <input
                  required
                  type="tel"
                  className="w-full bg-sys-surface border border-sys-border rounded p-3 text-sm text-sys-text focus:outline-none focus:border-accent-blue transition-colors"
                  placeholder="+52 11 2233 4455"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-sys-text mb-2 font-mono uppercase flex items-center gap-2">
                    <Calendar size={14} /> Día
                  </label>
                  <input
                    required
                    type="date"
                    className="w-full bg-sys-surface border border-sys-border rounded p-3 text-sm text-sys-text focus:outline-none focus:border-accent-blue transition-colors"
                    value={formData.date}
                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-sys-text mb-2 font-mono uppercase flex items-center gap-2">
                    <Clock size={14} /> Hora
                  </label>
                  <input
                    required
                    type="time"
                    className="w-full bg-sys-surface border border-sys-border rounded p-3 text-sm text-sys-text focus:outline-none focus:border-accent-blue transition-colors"
                    value={formData.time}
                    onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full bg-sys-text text-white py-3 rounded font-bold font-mono text-sm hover:bg-accent-blue transition-colors flex items-center justify-center gap-2 mt-6"
              >
                CONFIRMAR AGENDA
              </button>
            </form>
          </div>
        )}

        <div className="mt-6 pt-6 border-t border-sys-border text-center">
          <p className="text-xs text-sys-muted font-mono">ID de transacción: {agentId.toUpperCase()}_REQ</p>
        </div>
      </div>
    </div>
  );
};

export default HiringModal;

import React from 'react';
import { Check, Info, Zap } from 'lucide-react';

interface EnergyRow {
  type: string;
  detail: string;
  price: string;
  highlight?: boolean;
}

interface PricingProps {
  sectionTitle?: string;
  sectionBody?: string;
  membershipTitle?: string;
  membershipDescription?: string;
  price?: string;
  period?: string;
  currency?: string;
  features?: string[];
  ctaLabel?: string;
  ctaFooter?: string;
  energyTitle?: string;
  energyDescription?: string;
  energyTable?: EnergyRow[];
  optimizationNote?: string;
  onCtaClick?: () => void;
}

const Pricing: React.FC<PricingProps> = ({
  sectionTitle = 'Pricing Console',
  sectionBody = 'Modelo industrial simple: Membresía por infraestructura + Energía bajo demanda.',
  membershipTitle = 'Membresía Base',
  membershipDescription = 'Acceso a la infraestructura de Digsol.',
  price = '$1,200',
  period = '/mes',
  currency = 'MXN',
  features = [
    'Infraestructura Operativa',
    'Mantenimiento de Agente',
    'Dashboard de Control',
    'Soporte Prioritario',
    'Integración WhatsApp',
    'Actualizaciones Semanales',
  ],
  ctaLabel = '>_ INICIAR CONTRATACIÓN',
  ctaFooter = 'Procesado vía Stripe',
  energyTitle = 'Consumo de Energía',
  energyDescription = 'Consumo bajo demanda (WhatsApp API). Optimizamos el flujo para maximizar las conversaciones gratuitas.',
  energyTable = [
    { type: 'Servicio (Iniciada por usuario)', detail: 'Ventana de 24h', price: '$0.00 MXN', highlight: true },
    { type: 'Utilidad', detail: 'Notificaciones de pedido/cita', price: '~$0.15 MXN' },
    { type: 'Marketing', detail: 'Difusión y reactivación', price: '~$0.08 MXN' },
  ],
  optimizationNote = 'Digsol Optimization: Nuestros agentes están programados para mantener la mayoría de las interacciones dentro de la ventana gratuita de servicio.',
  onCtaClick,
}) => {
  return (
    <section className="py-20 bg-sys-surface border-t border-sys-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-sys-text mb-4">{sectionTitle}</h2>
          <p className="text-sys-muted max-w-xl mx-auto">{sectionBody}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Membership Card */}
          <div className="bg-white border border-sys-border rounded-xl p-8 shadow-card relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-sys-text" />
            <h3 className="text-lg font-bold text-sys-text mb-2">{membershipTitle}</h3>
            <p className="text-sys-muted text-sm mb-6">{membershipDescription}</p>

            <div className="flex items-baseline mb-8">
              <span className="text-4xl font-bold text-sys-text tracking-tight">{price}</span>
              <span className="text-lg text-sys-muted ml-2 font-medium">{period}</span>
              <span className="ml-2 text-xs font-bold bg-sys-surface text-sys-text border border-sys-border px-2 py-1 rounded">{currency}</span>
            </div>

            <ul className="space-y-4 mb-8">
              {features.map((feature, idx) => (
                <li key={idx} className="flex items-start text-sm text-sys-text">
                  <Check size={18} className="text-accent-blue mr-3 shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>

            <button
              onClick={onCtaClick}
              className="w-full bg-sys-text text-white py-4 rounded font-bold font-mono hover:bg-accent-blue transition-colors"
            >
              {ctaLabel}
            </button>
            <p className="text-center text-xs text-sys-muted mt-4">{ctaFooter}</p>
          </div>

          {/* Energy Card */}
          <div className="bg-sys-surface border border-sys-border rounded-xl p-8 flex flex-col">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-bold text-sys-text">{energyTitle}</h3>
              <Info size={20} className="text-sys-muted" />
            </div>
            <p className="text-sys-muted text-sm mb-8">{energyDescription}</p>

            <div className="bg-white border border-sys-border rounded-lg p-4 mb-6">
              <table className="w-full text-sm">
                <tbody>
                  {energyTable.map((row, idx) => (
                    <tr key={idx} className={idx < energyTable.length - 1 ? 'border-b border-sys-surface' : ''}>
                      <td className="py-3 text-sys-muted">
                        <span className="block font-medium text-sys-text">{row.type}</span>
                        <span className="text-[10px]">{row.detail}</span>
                      </td>
                      <td className={`py-3 text-right font-mono text-sys-text font-bold ${row.highlight ? 'text-accent-green' : ''}`}>
                        {row.price}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-auto bg-blue-50 border border-blue-100 p-4 rounded-lg flex items-start gap-3">
              <Zap size={16} className="text-accent-blue mt-0.5 shrink-0" />
              <p className="text-xs text-blue-900 leading-relaxed">
                <strong>{optimizationNote.split(':')[0]}:</strong>{optimizationNote.split(':').slice(1).join(':')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Pricing;

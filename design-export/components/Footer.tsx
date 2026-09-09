import React from 'react';

interface FooterProps {
  brand?: string;
  brandSuffix?: string;
  copyright?: string;
  links?: { label: string; href: string }[];
}

const Footer: React.FC<FooterProps> = ({
  brand = 'Digsol',
  brandSuffix = '/Factory',
  copyright = '© 2024 Digital Solutions Inc. Todos los derechos reservados.',
  links = [
    { label: 'Términos', href: '#' },
    { label: 'Privacidad', href: '#' },
    { label: 'Estado del Servicio', href: '#' },
  ],
}) => {
  return (
    <footer className="bg-white border-t border-sys-border py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center">
        <div className="mb-4 md:mb-0">
          <span className="font-bold text-lg tracking-tight text-sys-text">
            {brand}<span className="text-sys-muted font-normal">{brandSuffix}</span>
          </span>
          <p className="text-xs text-sys-muted mt-2">{copyright}</p>
        </div>
        <div className="flex space-x-8 text-sm text-sys-muted">
          {links.map((link, i) => (
            <a key={i} href={link.href} className="hover:text-sys-text transition-colors">
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
};

export default Footer;

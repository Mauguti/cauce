/**
 * Tailwind CSS Preset — Digsol Factory
 *
 * Usage in tailwind.config.js:
 *
 *   import factoryPreset from './design-export/tailwind.preset.js';
 *
 *   export default {
 *     presets: [factoryPreset],
 *     content: ['./src/**\/*.{js,ts,jsx,tsx}'],
 *   };
 */

/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Cascadia Code', 'Fira Code', 'monospace'],
      },
      colors: {
        sys: {
          bg:      '#FFFFFF',
          surface: '#F9FAFB',
          border:  '#E5E7EB',
          text:    '#111827',
          muted:   '#6B7280',
        },
        accent: {
          blue:   '#007ACC',
          purple: '#7D4698',
          orange: '#E37933',
          green:  '#4EC9B0',
        },
      },
      boxShadow: {
        clean: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        card:  '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)',
      },
      animation: {
        blink: 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
};

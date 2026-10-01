/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pitch at night: near-black turf, floodlit line markings, and one
        // electric accent that only ever means "money" or "go".
        pitch: {
          900: '#05070a',
          800: '#0a0e14',
          700: '#111721',
          600: '#1a2230',
          500: '#26303f',
        },
        volt: {
          DEFAULT: '#3dff9a',
          dim: '#1fbf70',
          glow: 'rgba(61, 255, 154, 0.16)',
        },
        cyanline: '#22d3ee',
        danger: '#ff5c6c',
        warn: '#ffb340',
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        volt: '0 0 0 1px rgba(61,255,154,0.35), 0 8px 30px -12px rgba(61,255,154,0.5)',
        // A surface that catches light on its top edge and sits on the page
        // rather than being pasted onto it.
        lift: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 18px 40px -24px rgba(0,0,0,0.9)',
        'volt-glow': '0 0 24px -6px rgba(61,255,154,0.45), 0 1px 0 0 rgba(255,255,255,0.25) inset',
        'inset-field': '0 1px 2px 0 rgba(0,0,0,0.5) inset',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(61,255,154,0.45)' },
          '70%': { boxShadow: '0 0 0 12px rgba(61,255,154,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(61,255,154,0)' },
        },
        'rise': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'none' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        'pulse-ring': 'pulse-ring 2s ease-out infinite',
        rise: 'rise .35s ease-out both',
      },
    },
  },
  plugins: [],
};

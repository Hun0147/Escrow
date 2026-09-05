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
      },
      boxShadow: {
        volt: '0 0 0 1px rgba(61,255,154,0.35), 0 8px 30px -12px rgba(61,255,154,0.5)',
      },
    },
  },
  plugins: [],
};

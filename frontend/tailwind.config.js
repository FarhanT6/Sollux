/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gold: {
          50:  '#FEF9EC',
          100: '#FEF3D0',
          200: '#FDE89C',
          300: '#FCD95D',
          400: '#FBCA2C',
          500: '#F5A623',
          600: '#D4840F',
          700: '#A8630B',
          800: '#7D4B10',
          900: '#633806',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

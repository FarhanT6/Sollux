/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // md: the desktop layout. A wide screen, or a computer (mouse or
      // trackpad) window at least 600px wide; must stay the opposite of
      // PHONE_QUERY in src/ios/usePhone.ts.
      screens: { md: { raw: '(min-width: 768px), (min-width: 600px) and (pointer: fine)' } },
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
      // Apple's own typeface where there is one (Mac, iPhone), Inter elsewhere.
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', 'Inter', 'system-ui', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      // A calmer scale: the small text most of the app is set in reads at 13px
      // with room between lines; headings step up gently, never shout.
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.25rem' }],
        sm: ['0.875rem', { lineHeight: '1.375rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.5rem', letterSpacing: '-0.01em' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.015em' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em' }],
        '3xl': ['1.75rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
        '4xl': ['2.125rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em' }],
      },
      // One heading weight: "bold" sits at semibold, like Apple's.
      fontWeight: { bold: '600', extrabold: '650' },
      // Letter-spaced capitals, quieter.
      letterSpacing: { wide: '0.01em', wider: '0.02em', widest: '0.04em' },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
    },
  },
  plugins: [],
};

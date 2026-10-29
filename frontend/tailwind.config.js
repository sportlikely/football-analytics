/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Unbounded', 'Manrope', '"Noto Sans Devanagari"', 'system-ui', 'sans-serif'],
        sans: ['Manrope', '"Noto Sans Devanagari"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // semantic tokens — values live in index.css (:root / .dark)
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        surface2: 'rgb(var(--surface-2) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        home: 'rgb(var(--home) / <alpha-value>)',
        draw: 'rgb(var(--draw) / <alpha-value>)',
        away: 'rgb(var(--away) / <alpha-value>)',
        live: 'rgb(var(--live) / <alpha-value>)',
        win: 'rgb(var(--win) / <alpha-value>)',
        loss: 'rgb(var(--loss) / <alpha-value>)',
        likely: 'rgb(var(--likely) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 1px 0 rgb(var(--line) / 0.6), 0 8px 24px -12px rgb(0 0 0 / 0.35)',
        lift: '0 1px 0 rgb(var(--line) / 0.8), 0 16px 40px -16px rgb(0 0 0 / 0.5)',
        glow: '0 0 0 1px rgb(var(--live) / 0.5), 0 0 24px -4px rgb(var(--live) / 0.6)',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.8)' },
        },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scan: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(400%)' },
        },
        pop: {
          '0%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(var(--accent) / 0)' },
          '40%': { transform: 'scale(1.045)', boxShadow: '0 0 0 6px rgb(var(--accent) / 0.25)' },
          '100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(var(--accent) / 0)' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.4s ease-in-out infinite',
        rise: 'rise 0.35s ease-out both',
        pop: 'pop 0.6s ease-out 1.45s both',
      },
    },
  },
  plugins: [],
}

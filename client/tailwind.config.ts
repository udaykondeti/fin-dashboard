import type { Config } from 'tailwindcss';

// Theme variables mirror public/index.html coffee-shop palette so the v2 app
// looks identical to v1 during the migration.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        espresso: '#2C1A0E',
        caramel:  '#C68642',
        cream:    '#FDF6EC',
        latte:    '#E8D5B7',
        mocha:    '#6B3F1F',
        steam:    '#EFE3D2',
        foam:     '#FBF4E7',
        ink:      '#1A0F08',
        rust:     '#A0522D',
        leaf:     '#5C7F4E'
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
} satisfies Config;

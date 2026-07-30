/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'aegis-navy': '#0D1B3E',
        'aegis-blue': '#1A56B0',
      }
    }
  },
  plugins: [],
};

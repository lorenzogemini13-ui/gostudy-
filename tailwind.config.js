/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./pages/**/*.html",
    "./assets/js/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        primary: "#007AFF", // Original primary
        "primary-pro": "#0071e3", // Pro page primary
        "primary-hover": "#0062cc",
        dark: "#1d1d1f",
        subtle: "#86868b",
        bg: "#F5F5F7",
        surface: "#FFFFFF",
        text: "#1D1D1F",
        "text-secondary": "#86868B",
      },
      fontFamily: { 
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"] 
      },
      boxShadow: {
        soft: "0 4px 20px rgba(0, 0, 0, 0.03)",
        card: "0 2px 8px rgba(0, 0, 0, 0.04)",
        'apple': '0 4px 24px rgba(0,0,0,0.06)',
        'apple-hover': '0 8px 32px rgba(0,0,0,0.12)',
        'glow': '0 0 40px rgba(0, 113, 227, 0.4)',
      },
      letterSpacing: {
        tighter: '-0.04em',
        tight: '-0.025em',
      }
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        space: {
          DEFAULT: "#0A0E17",
          800: "#0D1120",
          700: "#141926",
        },
        steel: {
          DEFAULT: "#1A1F2E",
          600: "#222839",
          500: "#2A3040",
        },
        accent: {
          red: "#FF3D00",
          blue: "#00E5FF",
          gold: "#FFD600",
        },
        text: {
          primary: "#E8ECF4",
          secondary: "#7A849B",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "monospace"],
        sans: ["IBM Plex Sans", "sans-serif"],
      },
      animation: {
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 5px rgba(0,229,255,0.3)" },
          "50%": { boxShadow: "0 0 20px rgba(0,229,255,0.6)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(1.3)" },
        },
      },
    },
  },
  plugins: [],
};

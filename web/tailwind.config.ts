import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Core system colors
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        border: "var(--table-row-border-color)",
        
        // UI element colors
        purple: {
          800: "#6b46c1", // Deep purple for selected navigation items
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace", 
          "SFMono-Regular", 
          "Menlo", 
          "Monaco", 
          "Consolas", 
          "Liberation Mono", 
          "Courier New", 
          "monospace"
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;

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
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			border: 'var(--table-row-border-color)',
  			purple: {
  				'800': '#6b46c1'
  			}
  		},
  		fontFamily: {
  			mono: [
  				'ui-monospace',
  				'SFMono-Regular',
  				'Menlo',
  				'Monaco',
  				'Consolas',
  				'Liberation Mono',
  				'Courier New',
  				'monospace'
  			]
  		},
  		keyframes: {
  			'block-pulse': {
  				'0%, 100%': {
  					opacity: '1'
  				},
  				'50%': {
  					opacity: '.5'
  				}
  			}
  		},
  		animation: {
  			'block-pulse': 'block-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
  		}
  	}
  },
  plugins: [],
} satisfies Config;

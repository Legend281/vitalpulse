/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    "./*.html",
    "./src/**/*.{html,js,ts,jsx,tsx}",
    "./pages/**/*.{html,js}",
  ],
  theme: {
    extend: {
      "colors": {
        "surface-container-highest": "#e2e2e2",
        "tertiary-container": "#00799c",
        "on-surface": "#1a1c1c",
        "on-primary-fixed-variant": "#930010",
        "surface-container-lowest": "#ffffff",
        "primary-container": "#d32f2f",
        "on-secondary": "#ffffff",
        "on-primary-fixed": "#410003",
        "surface-dim": "#dadada",
        "on-surface-variant": "#5b403d",
        "surface-container": "#eeeeee",
        "on-error-container": "#93000a",
        "secondary": "#9f3f39",
        "secondary-fixed": "#ffdad6",
        "error-container": "#ffdad6",
        "tertiary": "#005f7b",
        "on-secondary-fixed": "#410003",
        "secondary-fixed-dim": "#ffb3ac",
        "on-tertiary-container": "#e9f7ff",
        "surface-container-low": "#f3f3f3",
        "primary-fixed-dim": "#ffb3ac",
        "error": "#ba1a1a",
        "outline": "#8f6f6c",
        "primary": "#af101a",
        "on-primary": "#ffffff",
        "surface-container-high": "#e8e8e8",
        "primary-fixed": "#ffdad6",
        "surface": "#f9f9f9",
        "on-secondary-container": "#741e1c",
        "outline-variant": "#e4beba",
        "inverse-surface": "#2f3131",
        "on-background": "#1a1c1c",
        "on-tertiary-fixed-variant": "#004d65",
        "surface-tint": "#ba1a20",
        "inverse-on-surface": "#f1f1f1",
        "on-error": "#ffffff",
        "on-tertiary-fixed": "#001f2a",
        "background": "#f9f9f9",
        "on-secondary-fixed-variant": "#802824",
        "on-tertiary": "#ffffff",
        "surface-variant": "#e2e2e2",
        "inverse-primary": "#ffb3ac",
        "tertiary-fixed-dim": "#7bd1f8",
        "secondary-container": "#fd867d",
        "on-primary-container": "#fff2f0",
        "tertiary-fixed": "#bee9ff",
        "surface-bright": "#f9f9f9"
      },
      "borderRadius": {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
      "fontFamily": {
        "headline": ["Manrope"],
        "body": ["Inter"],
        "label": ["Inter"]
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ],
}

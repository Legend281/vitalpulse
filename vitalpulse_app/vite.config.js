import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './', // Support subdirectory deployment
  server: {
    host: true, // Listen on all local IPs to allow testing from other devices
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        login: resolve(import.meta.dirname, 'login.html'),
        signup: resolve(import.meta.dirname, 'signup.html'),
        'forgot-password': resolve(import.meta.dirname, 'forgot-password.html'),
        'reset-password': resolve(import.meta.dirname, 'reset-password.html'),
        donor: resolve(import.meta.dirname, 'donor.html'),
        hospital: resolve(import.meta.dirname, 'hospital.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        about: resolve(import.meta.dirname, 'about.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
        terms: resolve(import.meta.dirname, 'terms.html'),
        'public-request': resolve(import.meta.dirname, 'public-request.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }
            if (id.includes('chart.js')) {
              return 'vendor-charts';
            }
            if (id.includes('leaflet')) {
              return 'vendor-maps';
            }
            return 'vendor-core';
          }
        },
      },
    },
  },
  test: {
    pool: 'threads',
  },
});

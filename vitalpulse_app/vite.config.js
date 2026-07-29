import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './', // Support subdirectory deployment
  server: {
    host: true, // Listen on all local IPs to allow testing from other devices
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        signup: resolve(__dirname, 'signup.html'),
        donor: resolve(__dirname, 'donor.html'),
        hospital: resolve(__dirname, 'hospital.html'),
        admin: resolve(__dirname, 'admin.html'),
        about: resolve(__dirname, 'about.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        terms: resolve(__dirname, 'terms.html'),
        'public-request': resolve(__dirname, 'public-request.html'),
      },
    },
  },
});

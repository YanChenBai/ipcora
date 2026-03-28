import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'es',
        },
      },
    },
    resolve: {
      conditions: ['dev'],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'es',
        },
      },
    },
    resolve: {
      conditions: ['dev'],
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
      conditions: ['dev'],
    },
    plugins: [vue()],
  },
});

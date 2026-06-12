import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: [
    {
      entry: {
        index: './src/index.ts',
        main: './src/main.ts',
        preload: './src/preload.ts',
        renderer: './src/renderer.ts',
      },
      platform: 'node',
      format: 'esm',
      dts: true,
      deps: {
        neverBundle: ['electron', 'ipcora'],
      },
    },
  ],
  resolve: {
    alias: {
      ipcora: fileURLToPath(new URL('../ipcora/src', import.meta.url)),
    },
  },
  test: {
    typecheck: {
      enabled: true,
    },
    include: ['./tests/**/*.test.ts'],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});

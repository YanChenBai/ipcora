import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: [
    {
      entry: {
        index: './src/index.ts',
      },
      platform: 'node',
      format: 'esm',
      dts: true,
      deps: {
        neverBundle: ['electron', '@ipcora/core'],
      },
      exports: {
        devExports: 'dev',
      },
    },
  ],
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

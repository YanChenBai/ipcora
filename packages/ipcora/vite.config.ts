import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: [
    {
      entry: {
        index: './src/index.ts',
        client: './src/client.ts',
        event: './src/event.ts',
      },
      platform: 'node',
      format: 'esm',
      dts: true,
    },
  ],
  test: {
    typecheck: {
      enabled: true,
    },
    include: ['./tests/**/*.test.ts', './tests/**/*.test-d.ts'],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});

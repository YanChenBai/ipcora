import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        renderer: "./src/renderer.ts",
        preload: "./src/preload.ts",
        index: "./src/index.ts",
      },
      platform: "browser",
      format: "esm",
      dts: true,
      deps: {
        neverBundle: ["electron"],
      },
      exports: {
        devExports: "dev",
      },
    },
    {
      entry: {
        main: "./src/main/index.ts",
        typebox: "./src/typebox.ts",
      },
      platform: "node",
      format: "esm",
      dts: true,
      deps: {
        neverBundle: ["electron"],
      },
      exports: {},
    },
  ],
  test: {
    environment: "jsdom",
    ui: true,
    typecheck: {
      enabled: true,
    },
    include: ["./tests/**/*.test.ts"],
  },
  fmt: {
    ignorePatterns: [],
    singleQuote: true,
    experimentalSortImports: {},
  },
  lint: {
    plugins: [],
    categories: {},
    rules: {},
    settings: {
      "jsx-a11y": {
        polymorphicPropName: "as",
        components: {},
        attributes: {},
      },
      next: {
        rootDir: [],
      },
      jsdoc: {
        ignorePrivate: false,
        ignoreInternal: false,
        ignoreReplacesDocs: true,
        overrideReplacesDocs: true,
        augmentsExtendsReplacesDocs: false,
        implementsReplacesDocs: false,
        exemptDestructuredRootsFromChecks: false,
        tagNamePreference: {},
      },
      vitest: {
        typecheck: true,
      },
    },
    env: {
      builtin: true,
    },
    globals: {},
    ignorePatterns: [],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});

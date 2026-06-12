import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: "vp run -r build",
      test: "vp test --typecheck",
      typecheck: "vp check --no-fmt --no-lint",
    },
  },
  pack: [
    {
      entry: {
        index: "./src/index.ts",
      },
      platform: "node",
      format: "esm",
      dts: true,
      exports: {
        devExports: "dev",
      },
    },
  ],
  test: {
    typecheck: {
      enabled: true,
    },
    projects: ["./packages/ipcora/vite.config.ts", "./packages/electron/vite.config.ts"],
  },
  fmt: {
    singleQuote: true,
    sortImports: true,
    sortTailwindcss: true,
    sortPackageJson: true,
    arrowParens: "avoid",
    embeddedLanguageFormatting: "auto",
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
  staged: {
    "*": "vp check --fix",
  },
});

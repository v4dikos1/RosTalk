import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// Generated bindings are not ours to lint: protobuf files come from
// `make gen`, the Tauri IPC bindings from `rostalk --export-bindings`.
const generated = [
  "src/proto/**",
  "src/core/tauri/bindings.ts",
  "src/server-setup/bindings.ts",
];

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dist-server-setup",
      "coverage",
      "playwright-report",
      "test-results",
      // Mutation testing sandbox and HTML/JSON reports (docs/TEST-QUALITY.md).
      // A crashed Stryker run leaves a sandbox with a second tsconfig behind;
      // it must not break `make check`.
      ".stryker-tmp",
      "reports",
      ...generated,
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // The UI must stay portable: the only Tauri-aware module is the adapter.
    // A second adapter (browser) will be added after the MVP (design 5.1).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/core/tauri/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*", "@tauri-apps/**"],
              message:
                "Import Tauri only in src/core/tauri/. The rest of the UI talks to CoreApi (ui/src/core/api.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["vite.config.ts", "playwright.config.ts", "stryker.config.mjs", "e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-imports": "off",
    },
  },
);

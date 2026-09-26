import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // NestJS injects constructor parameters by their runtime class, so those imports must stay value imports.
  {
    files: ["apps/api/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-imports": "off" },
  },
  // Layer boundaries (docs/DEVELOPMENT_PHASES.md §1)
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@platform/db", "@platform/db/*", "@platform/crypto", "@prisma/*"],
              message: "The web app talks to the API only; it must never import server-side packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/**/*.ts", "packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@platform/db", "@platform/ai", "@platform/telephony", "@platform/tools", "@prisma/*"],
              message: "core/shared are pure: no I/O packages.",
            },
          ],
        },
      ],
    },
  },
);

import js from "@eslint/js";
import globals from "globals";
import prettierConfig from "eslint-config-prettier";

export default [
  { ignores: ["node_modules/**", "coverage/**"] },

  js.configs.recommended,

  // app.js + các module trong src/: chạy trong trình duyệt (browser globals),
  // là ES module (import/export).
  {
    files: ["app.js", "src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // Service worker: globals riêng (self, caches, clients...), không phải module.
  {
    files: ["sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.serviceworker },
    },
  },

  // File cấu hình + test + script build (scripts/): chạy bằng Node, không
  // phải trong trình duyệt.
  {
    files: ["*.config.js", "**/*.test.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // Tắt các rule ESLint có thể xung đột với format của Prettier — luôn để
  // cuối cùng để override đúng thứ tự.
  prettierConfig,
];

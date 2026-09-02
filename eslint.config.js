// Flat ESLint config for the whole monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.claude/` holds per-machine tool output, not project source: hook
  // settings, worktrees, and skill packs a member installs themselves
  // (uipro writes ~140 lint errors of generated JS into skills/).
  // Linting it gates our CI on another tool's codegen.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.db", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" }
      ]
    }
  }
);

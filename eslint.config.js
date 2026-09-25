import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "dist/",
            "node_modules/",
            "cache/",
            "playwright-report/",
            "test-results/",
            "tests/fixtures/",
            ".atl/",
            ".codegraph/",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "no-undef": "off",
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
    {
        files: ["src/server/**/*.ts", "src/shared/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
        languageOptions: { globals: globals.node },
    },
    {
        files: ["src/client/**/*.ts"],
        languageOptions: { globals: globals.browser },
    },
);

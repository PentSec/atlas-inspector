import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "tests/unit/**/*.test.ts",
            "tests/integration/**/*.test.ts",
            "src/client/**/*.test.ts",
        ],
        environment: "node",
        testTimeout: 15000,
    },
});

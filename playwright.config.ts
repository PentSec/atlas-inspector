import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/e2e",
    testMatch: "**/*.spec.ts",
    timeout: 30_000,
    retries: 2,
    use: {
        baseURL: "http://127.0.0.1:8000",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "PORT=8000 node start.mjs",
        url: "http://127.0.0.1:8000/api/v1/health",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

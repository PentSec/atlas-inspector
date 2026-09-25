import { defineConfig } from "vite";

export default defineConfig({
    root: "src/client",
    server: {
        port: 5173,
        proxy: {
            "/api": "http://127.0.0.1:8000",
        },
    },
    build: {
        outDir: "../../dist/client",
        emptyOutDir: true,
        sourcemap: true,
    },
});

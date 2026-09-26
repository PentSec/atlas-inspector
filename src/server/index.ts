/**
 * Server entry point — wires config + app, owns the process lifecycle.
 */
import {
    buildApp,
    ensureCacheLayout,
    reportListfileState,
    startListfileReleaseCheck,
} from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { ReleaseCheckHandle } from "./services/releaseCheck.js";

const config = loadConfig();
const logger = createLogger(config.log.level, config.log.pretty);

await ensureCacheLayout(config, logger);

const app = await buildApp(config, logger);

// Held so shutdown can cancel the timer instead of relying on process.exit()
// to reap it. Declared here because the signal handlers close over it.
let releaseCheck: ReleaseCheckHandle | undefined;

async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    releaseCheck?.stop();
    try {
        await app.close();
    } catch (err) {
        logger.error({ err }, "error during shutdown");
    }
    process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
process.on("unhandledRejection", (err) => {
    logger.error({ err }, "unhandled rejection");
});

try {
    await app.listen({ host: config.server.host, port: config.server.port });
    // After listen, never before: the index is ~146 MB and must not delay the
    // port coming up. And it is never downloaded here — this only reads what is
    // already on disk and starts the ~14 KB/7h freshness check.
    releaseCheck = startListfileReleaseCheck(app, config, logger);
    void reportListfileState(app, logger);
} catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
}

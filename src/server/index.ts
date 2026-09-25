/**
 * Server entry point — wires config + app, owns the process lifecycle.
 */
import { buildApp, ensureCacheLayout } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.log.level, config.log.pretty);

await ensureCacheLayout(config, logger);

const app = await buildApp(config, logger);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
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
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
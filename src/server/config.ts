/**
 * Environment configuration, validated once at startup with zod.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z
    .enum(["0", "1", "true", "false"])
    .default("1")
    .transform((v) => v === "1" || v === "true"),

  WAGO_BASE_URL: z.string().url().default("https://wago.tools"),
  WAGO_USER_AGENT: z.string().min(1).default("atlas-inspector/0.2.0 (https://github.com/)"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  UPSTREAM_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(150),

  DB_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(86_400_000),
  RENDER_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(604_800_000),
  DISK_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(604_800_000),

  BLP_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),

  LISTFILE_PATH: z.string().default(""),
});

export type Config = {
  server: { host: string; port: number };
  log: { level: LogLevel; pretty: boolean };
  upstream: {
    baseUrl: string;
    userAgent: string;
    timeoutMs: number;
    maxRetries: number;
    minIntervalMs: number;
  };
  cache: {
    dbTtlMs: number;
    renderTtlMs: number;
    diskTtlMs: number;
  };
  decode: { maxBytes: number };
  dirs: {
    root: string;
    cache: string;
    render: string;
    decode: string;
    db: string;
    dist: string;
  };
  listfilePath: string;
};

import type { LogLevel } from "./logger.js";

function fromEnv(env: NodeJS.ProcessEnv): z.infer<typeof EnvSchema> {
  const clean: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) clean[k] = v;
  }
  return EnvSchema.parse(clean);
}

/**
 * Locate the project root from the module's own directory, walking up until a
 * package.json is found. Works identically from src/ (dev) and dist/server
 * (build) because both live inside the repo — only the depth differs.
 */
function findRoot(start: string): string {
  let cur = start;
  for (;;) {
    if (existsSync(path.join(cur, "package.json"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) throw new Error("could not locate project root");
    cur = parent;
  }
}

/** Resolve absolute paths anchored at the project root (repo layout parity). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envCfg = fromEnv(env);
  const root = env.ATLAS_ROOT ?? findRoot(import.meta.dirname);
  const cacheDir = path.join(root, "cache");

  return {
    server: { host: envCfg.HOST, port: envCfg.PORT },
    log: { level: envCfg.LOG_LEVEL, pretty: envCfg.LOG_PRETTY },
    upstream: {
      baseUrl: envCfg.WAGO_BASE_URL.replace(/\/+$/, ""),
      userAgent: envCfg.WAGO_USER_AGENT,
      timeoutMs: envCfg.UPSTREAM_TIMEOUT_MS,
      maxRetries: envCfg.UPSTREAM_MAX_RETRIES,
      minIntervalMs: envCfg.UPSTREAM_MIN_INTERVAL_MS,
    },
    cache: {
      dbTtlMs: envCfg.DB_CACHE_TTL_MS,
      renderTtlMs: envCfg.RENDER_CACHE_TTL_MS,
      diskTtlMs: envCfg.DISK_CACHE_TTL_MS,
    },
    decode: { maxBytes: envCfg.BLP_MAX_BYTES },
    dirs: {
      root,
      cache: cacheDir,
      render: path.join(cacheDir, "render"),
      decode: path.join(cacheDir, "decode"),
      db: path.join(cacheDir, "db"),
      dist: path.join(root, "dist", "client"),
    },
    listfilePath: envCfg.LISTFILE_PATH || path.join(cacheDir, "listfile.csv"),
  };
}
import { readFileSync } from "node:fs";

/** One API owner: requests bearing `token` act as `owner`. */
export interface OwnerToken {
  owner: string;
  token: string;
}

export interface ServerConfig {
  /** Application database (product projections). */
  databaseUrl: string;
  /** DBOS system database. May share a server with `databaseUrl`; DBOS keeps its own schema. */
  systemDatabaseUrl: string;
  port: number;
  host: string;
  /** Owner bearer tokens. Never committed; see tokenFile / env below. */
  tokens: OwnerToken[];
  /** Milliseconds between runner polls inside a workflow. */
  pollIntervalMs: number;
  /** Per-script deadline handed to the runner. */
  scriptDeadlineSeconds: number;
}

/**
 * Token material lives outside source control: either a file of
 * `owner:token` lines (POWERHOUSE_TOKENS_FILE) or the same format inline in
 * POWERHOUSE_API_TOKENS. Tokens must be at least 16 characters.
 */
function parseTokens(raw: string): OwnerToken[] {
  const tokens: OwnerToken[] = [];
  for (const line of raw.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) throw new Error("token entries must be owner:token");
    const owner = trimmed.slice(0, sep).trim();
    const token = trimmed.slice(sep + 1).trim();
    if (!owner || token.length < 16) {
      throw new Error(`token for owner ${owner || "?"} must be at least 16 characters`);
    }
    tokens.push({ owner, token });
  }
  return tokens;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const systemDatabaseUrl = env.DBOS_SYSTEM_DATABASE_URL ?? databaseUrl;

  let rawTokens = env.POWERHOUSE_API_TOKENS ?? "";
  if (env.POWERHOUSE_TOKENS_FILE) {
    rawTokens = readFileSync(env.POWERHOUSE_TOKENS_FILE, "utf8");
  }
  const tokens = parseTokens(rawTokens);
  if (tokens.length === 0) {
    throw new Error("no API tokens configured (POWERHOUSE_API_TOKENS or POWERHOUSE_TOKENS_FILE)");
  }

  return {
    databaseUrl,
    systemDatabaseUrl,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    tokens,
    pollIntervalMs: Number(env.POWERHOUSE_POLL_INTERVAL_MS ?? 3000),
    scriptDeadlineSeconds: Number(env.POWERHOUSE_SCRIPT_DEADLINE_SECONDS ?? 1800),
  };
}

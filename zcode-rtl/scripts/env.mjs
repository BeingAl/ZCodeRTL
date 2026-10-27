/*
 * Shared configuration loader for the zcode-rtl scripts.
 *
 * These scripts run detached (hooks, restart copies) where the user's
 * shell environment is not inherited, so user-settable values live in
 * a .env file at the plugin root, next to this scripts/ folder. Real
 * environment variables always win over the file, and anything unset
 * falls back to the built-in defaults below.
 *
 * Format: one KEY=VALUE per line; '#' starts a comment; values may be
 * quoted with single or double quotes. Unknown keys are ignored.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = join(HERE, "..", ".env");

// Built-in fallbacks, used when neither the environment nor .env sets
// a value.
export const DEFAULT_PORT = 9222;

let loaded = false;

function applyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q)) {
    value = value.slice(1, -1);
  }
  if (key && !(key in process.env)) process.env[key] = value;
}

// Merge .env into process.env once per process. Existing environment
// variables are never overwritten.
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    readFileSync(ENV_PATH, "utf8").split(/\r?\n/).forEach(applyLine);
  } catch {
    /* no .env file: the built-in defaults apply */
  }
}

// The CDP port: ZCODE_RTL_PORT from the environment or .env, else the
// built-in default. Invalid values fall back too.
export function getPort() {
  loadEnv();
  const n = Number(process.env.ZCODE_RTL_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535
    ? String(n)
    : String(DEFAULT_PORT);
}

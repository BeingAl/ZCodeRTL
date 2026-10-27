#!/usr/bin/env node
/*
 * SessionStart hook entry: reads the hook payload (cwd = the active
 * workspace, which is where the Plugin Management toggle writes) and spawns
 * the RTL heartbeat daemon detached. The heartbeat then reconciles the app
 * state on its own.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const payload = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve(null);
  const timer = setTimeout(() => resolve(null), 1500);
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    clearTimeout(timer);
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve(null);
    }
  });
  process.stdin.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
});

const ws = payload?.cwd || payload?.workspace || "";
const args = [join(HERE, "heartbeat.mjs"), "--daemon"];
if (ws) args.push("--workspace", ws);

const child = spawn(process.execPath, args, {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.on("error", () => {
  /* never crash the hook */
});
child.unref();
process.exit(0);

#!/usr/bin/env node
/*
 * ZCode RTL injector: pushes assets/zcode-rtl.js into the ZCode Desktop
 * renderer through the Chrome DevTools Protocol (CDP).
 *
 * The ZCode plugin system cannot restyle the host app UI, so this rides the
 * local Chromium debugging port instead. No app file is ever modified, which
 * is why the layer survives ZCode updates.
 *
 * Modes:
 *   (no args)  one-shot: inject into every page target, then exit
 *   --set on   enable the RTL layer live (no app restart)
 *   --set off  disable the RTL layer live and stop the heartbeat daemon
 *   --quiet    suppress output when the debug port is closed (hook use)
 *
 * Both --set modes also record the intent in ~/.zcode/rtl-switch, which the
 * heartbeat daemon reads while the debug port is closed.
 *
 * Requires the app to run with --remote-debugging-port=<port>. Electron
 * reads that flag only at process start, so opening or closing the port
 * costs one app restart (scripts/restart-zcode.mjs handles it). The port
 * binds to 127.0.0.1 only, so nothing outside this machine can connect.
 *
 * Port: ZCODE_RTL_PORT from the environment or the plugin's .env file,
 * default 9222 (scripts/env.mjs). Node >= 22 (global WebSocket and
 * fetch).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getPort } from "./env.mjs";

const PORT = getPort();
const IS_WIN = process.platform === "win32";
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = join(HERE, "..", "assets", "zcode-rtl.js");
// Persistent on/off intent, kept OUTSIDE the renderer on purpose: while the
// debug port is closed nothing can read the in-page localStorage switch, so
// the heartbeat daemon reads this file instead to tell a manual "off" apart
// from an app that restarted without the port.
const SWITCH_PATH = join(homedir(), ".zcode", "rtl-switch");

function setSwitch(v) {
  try {
    mkdirSync(dirname(SWITCH_PATH), { recursive: true });
    writeFileSync(SWITCH_PATH, v, "utf8");
  } catch {
    /* best effort */
  }
}

// A full off leaves nothing running: stop this plugin's heartbeat
// daemons too. Chrome or Chromium are never touched on purpose: the
// plugin never launches a browser, and killing browser processes by
// name could hit the user's own.
function killDaemons() {
  const marker = join(HERE, "heartbeat.mjs");
  try {
    if (IS_WIN) {
      const ps =
        "Get-CimInstance Win32_Process | Where-Object { " +
        "$_.CommandLine -like '*heartbeat.mjs*' -and " +
        "$_.CommandLine -like '*--daemon*' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      spawnSync("powershell", ["-NoProfile", "-Command", ps], {
        windowsHide: true,
        timeout: 10000,
      });
      return;
    }
    const out = spawnSync("pgrep", ["-f", marker], {
      windowsHide: true,
      timeout: 5000,
    });
    for (const pid of (out.stdout || "")
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (Number(pid) !== process.pid) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* pgrep missing or nothing to kill */
  }
}

const args = process.argv.slice(2);
const QUIET = args.includes("--quiet");
const setIdx = args.indexOf("--set");
const SET = setIdx >= 0 ? args[setIdx + 1] : null; // 'on' | 'off'

const err = (...a) => {
  if (!QUIET) process.stderr.write(a.join(" ") + "\n");
};
const isPortError = (e) =>
  /fetch failed|ECONNREFUSED|WS |timeout/i.test(String(e.message || e));

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from /json/list`);
  const list = await res.json();
  // Only real renderer pages; skip devtools frontends and workers.
  return list.filter(
    (t) => t.type === "page" && !/^devtools:\/\//i.test(t.url || ""),
  );
}

let nextId = 1;
function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const timer = setTimeout(() => {
      reject(new Error("WS connect timeout"));
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }, 3000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res2, rej2) => {
            const id = nextId++;
            pending.set(id, { res2, rej2 });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.rej2(new Error(msg.error.message || "CDP error"));
        else p.res2(msg.result);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WS error"));
    });
  });
}

function shortExc(r) {
  const d = r && r.exceptionDetails;
  if (!d) return null;
  return String(
    (d.exception && d.exception.description) || d.text || "unknown",
  ).slice(0, 400);
}

// One-shot: evaluate now, then disconnect. The in-page MutationObserver keeps
// the layer alive on streaming DOM changes.
async function injectOnce(t, payload) {
  const { ws, send } = await attach(t.webSocketDebuggerUrl);
  try {
    const r = await send("Runtime.evaluate", {
      expression: payload,
      returnByValue: true,
    });
    const exc = shortExc(r);
    if (exc) throw new Error(`payload threw: ${exc}`);
    return true;
  } finally {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
}

async function evalIn(t, expr) {
  const { ws, send } = await attach(t.webSocketDebuggerUrl);
  try {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    const exc = shortExc(r);
    if (exc) return `EXCEPTION: ${exc}`;
    const v = r && r.result && r.result.value;
    return typeof v === "string" ? v : JSON.stringify(v);
  } finally {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
}

async function setLayer(what) {
  // Record the intent first, so it survives even when the port is closed
  // and the injection itself cannot run yet. An off also stops the
  // heartbeat daemon, so nothing of this plugin keeps running.
  setSwitch(what === "off" ? "0" : "1");
  if (what === "off") killDaemons();
  let targets;
  try {
    targets = await listTargets();
    // The browser endpoint opens before the first page target is listed, so
    // wait for the renderer instead of silently doing nothing.
    for (let i = 0; i < 10 && targets.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      targets = await listTargets();
    }
  } catch (e) {
    if (what === "off") {
      console.log(
        "RTL already fully off: the debug port is closed, " +
          "so nothing is injected anywhere.",
      );
    } else {
      console.log(
        `PORT_CLOSED: to enable RTL, run: ` +
          `node "<plugin>/scripts/restart-zcode.mjs" --with-port ` +
          `(restarts ZCode once with --remote-debugging-port=${PORT}, ` +
          `then enables RTL automatically)`,
      );
    }
    return;
  }
  const payload = readFileSync(PAYLOAD_PATH, "utf8");
  for (const t of targets) {
    // The payload strips its own styles live when disabled; older payloads
    // fall back to the reload path. (Both expressions are JavaScript
    // source, so string concatenation must keep every token intact.)
    const offExpr =
      "(window.__zcodeRtlSetEnabled ? " +
      "(window.__zcodeRtlSetEnabled(false), 'RTL_OFF_LIVE') : " +
      "(function(){try{localStorage.setItem('zcodeRtl:enabled','0')}" +
      "catch(e){}; location.reload(); " +
      "return 'RTL_OFF_RELOADING';})())";
    const onExpr =
      "try{localStorage.setItem('zcodeRtl:enabled','1')}catch(e){};" +
      " 'RTL_ON'" +
      ";" +
      payload +
      '; window.__zcodeRtlProcess ? "RTL_ENABLED" : "RTL_FAILED"';
    const expr = what === "off" ? offExpr : onExpr;
    const out = await evalIn(t, expr);
    const state = what === "off" ? "RTL off" : "RTL on";
    console.log(`${state}: ${t.title || t.url} -> ${out}`);
  }
}

async function main() {
  if (SET) {
    if (SET !== "on" && SET !== "off") {
      console.log("usage: --set on|off");
      process.exitCode = 1;
      return;
    }
    await setLayer(SET);
    return;
  }

  // Default: one-shot injection. When the user has turned the layer off,
  // the payload exits without touching anything (it reads the same
  // localStorage switch), so re-injecting at session start is harmless.
  const payload = readFileSync(PAYLOAD_PATH, "utf8");
  const targets = await listTargets();
  if (!targets.length) {
    err(`[zcode-rtl] port ${PORT} open but no page targets`);
    process.exitCode = 1;
    return;
  }
  let ok = 0;
  for (const t of targets) {
    try {
      await injectOnce(t, payload);
      ok++;
      console.log(`RTL injected: ${t.title || t.url}`);
    } catch (e) {
      err(`[zcode-rtl] failed (${t.title || t.url}): ${e.message}`);
    }
  }
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  if (isPortError(e)) {
    // Expected state when the app runs without the debug flag. With --quiet
    // (hook use) say nothing.
    if (!QUIET) console.log("PORT_CLOSED");
    process.exit(0);
  }
  err(`[zcode-rtl] ${e.stack || e.message || e}`);
  process.exit(1);
});

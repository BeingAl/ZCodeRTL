#!/usr/bin/env node
/*
 * ZCode RTL heartbeat: makes the Plugin Management toggle a live master
 * switch for the RTL layer.
 *
 * Toggling a plugin in ZCode only rewrites plugins.enabledPlugins in
 * ~/.zcode/cli/config.json. No process restarts and no renderer reload
 * happens, so this daemon watches that file and reconciles the running app:
 *
 *   toggle OFF (edge) -> strip the RTL layer live, then close the debug
 *                        port (one app restart, back to the default state)
 *   toggle ON  (edge) -> open the debug port if needed (one app restart)
 *                        and enable the RTL layer
 *   between edges     -> respect the manual switch written by /rtl:
 *                        a manual pause keeps the layer and the debug
 *                        port off
 *
 * Spawned detached by the SessionStart hook. Singleton via a loopback mutex
 * port. Talks only to 127.0.0.1 (CDP) and reads only local config files.
 * All page work is delegated to inject-rtl.mjs, restarts to
 * restart-zcode.mjs.
 *
 * Port: ZCODE_RTL_PORT from the environment or the plugin's .env file,
 * default 9222 (mutex uses port + 1). See scripts/env.mjs.
 */
import {
  readFileSync,
  appendFileSync,
  statSync,
  existsSync,
  truncateSync,
  watch,
} from "node:fs";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getPort } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(homedir(), ".zcode", "cli", "config.json");
const INJECT = join(HERE, "inject-rtl.mjs");
const RESTART = join(HERE, "restart-zcode.mjs");
const PORT = getPort();
const CDP = `http://127.0.0.1:${PORT}`;
const MUTEX_PORT = Number(PORT) + 1;
const LOGFILE = join(homedir(), ".zcode", "rtl-heartbeat.log");
// Manual on/off intent, written by inject-rtl.mjs (--set on|off). While the
// debug port is closed the in-page localStorage switch is unreachable, so
// this file is the only way to tell a manual "off" apart from an app that
// restarted without the port.
const SWITCH = join(homedir(), ".zcode", "rtl-switch");
// The Plugin Management toggle writes to the WORKSPACE scope config when a
// project is open (user scope only when none), so watch both. ZCode resolves
// scopes by AND: any scope explicitly saying false disables the plugin.
let WORKSPACE = "";

const log = (...a) => {
  const line = `[rtl-heartbeat] ${new Date().toISOString()} ${a.join(" ")}`;
  try {
    if (existsSync(LOGFILE) && statSync(LOGFILE).size > 100000) {
      truncateSync(LOGFILE);
    }
    appendFileSync(LOGFILE, line + "\n");
  } catch {
    /* logging must never break the daemon */
  }
};
const run = (cmd, args) => {
  const c = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  // A spawn error (for example ENOENT) crashes the daemon if nobody listens.
  c.on("error", (e) => log("spawn failed:", cmd, e.message || e));
  c.unref();
};

function hookStdinPayload() {
  // SessionStart hooks receive a JSON payload on stdin (cwd/workspace).
  // Race with a timer so a missing or interactive stdin can never hang us.
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
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
}

async function daemonize() {
  if (process.argv.includes("--daemon")) {
    const wi = process.argv.indexOf("--workspace");
    if (wi >= 0 && process.argv[wi + 1]) WORKSPACE = process.argv[wi + 1];
    return;
  }
  // Hook entry: read the active workspace, then detach and exit.
  const payload = await hookStdinPayload();
  const ws = payload?.cwd || payload?.workspace || "";
  const args = [fileURLToPath(import.meta.url), "--daemon"];
  if (ws) args.push("--workspace", ws);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

function mutex() {
  // Binding the port IS the singleton lock; a second copy just exits.
  return new Promise((resolve) => {
    const srv = createServer(() => {});
    srv.once("error", () => resolve(false));
    srv.listen(MUTEX_PORT, "127.0.0.1", () => resolve(true));
  });
}

function readFlag(file) {
  // null = not configured in this scope; else true/false
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    const p = (cfg && cfg.plugins) || {};
    if (p.enabled === false) return false; // global kill switch
    const eps = p.enabledPlugins || {};
    const hits = Object.entries(eps).filter(([k]) =>
      k.startsWith("zcode-rtl@"),
    );
    if (!hits.length) return null;
    // A stale second entry (an old marketplace id) may still say true;
    // an explicit false for any zcode-rtl plugin id must win.
    return hits.every(([, v]) => v !== false);
  } catch {
    return null;
  }
}

function readEnabled() {
  const u = readFlag(CONFIG);
  if (u === false) return false;
  if (WORKSPACE) {
    const w = readFlag(join(WORKSPACE, ".zcode", "config.json"));
    if (w === false) return false;
    if (w === true) return u !== false;
  }
  return u !== false; // both unset -> default enabled
}

function readSwitch() {
  // '0' = the user paused the layer, and also the default until the user
  // turns the layer on once (a fresh install must listen on nothing).
  // '1' = the user asked for RTL.
  try {
    return readFileSync(SWITCH, "utf8").trim() || "0";
  } catch {
    return "0";
  }
}

// Whether the real ZCode main app process is running. Child helpers
// started with --type= and the agent runtime (app-server, zcode.cjs)
// share the app name and must be excluded; on Linux the agent
// processes are named zcode-cli and are filtered out by the exact
// basename check. The debug-port flag is deliberately not inspected
// here: some launchers rename argv or drop it, so the port state
// itself is the only reliable signal.
function zcodeMainProcessExists() {
  // Command-line markers of helper processes and this plugin's own
  // scripts; processes matching this are never the app main process.
  const helperRe = new RegExp(
    "--type=|app-server|zcode\\.cjs" + "|restart-zcode|inject-rtl|heartbeat",
  );
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"name='ZCode.exe'\" | " +
        "Where-Object { $_.CommandLine -notlike '*--type=*' -and " +
        "$_.CommandLine -notlike '*app-server*' } | " +
        "Select-Object -First 1 ProcessId";
      const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
        windowsHide: true,
        timeout: 5000,
      }).toString();
      return /\d/.test(out);
    }
    const out = execFileSync("ps", ["ax", "-o", "command="], {
      timeout: 5000,
    }).toString();
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t || !/zcode/i.test(t)) continue;
      if (helperRe.test(t)) continue;
      const base = basename(t.split(/\s+/)[0] || "");
      if (base === "zcode" || base === "ZCode") return true;
    }
  } catch {
    /* no ps or no match */
  }
  return false;
}

async function pageProbe() {
  // null = port closed or no page target yet; else { payload } tells whether
  // the RTL layer is applied in the page right now.
  const res = await fetch(`${CDP}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });
  const targets = (await res.json()).filter(
    (t) => t.type === "page" && !/^devtools:/i.test(t.url || ""),
  );
  if (!targets.length) return null;
  return new Promise((resolve) => {
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    const done = (v) => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 3000);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: "JSON.stringify({p:!!window.__zcodeRtlProcess})",
            returnByValue: true,
          },
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(ev.data);
        const v = msg.result?.result?.value;
        done(v ? JSON.parse(v) : null);
      } catch {
        done(null);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

let lastEnabled = null;
let lastRestart = 0;
let lastClose = 0;
let restartCount = 0; // backoff index; resets when the layer is healthy
let noPortStreak = 0; // persistence guard against racing app startup
// Repeated restarts would kill the app every minute if the app kept coming
// back without the port (crash or auto-update relaunch). Back off instead:
// 1 min, 5 min, 15 min, 60 min, and give up entirely after a few attempts.
// A fresh toggle-on edge resets the attempt count.
const BACKOFF_STEPS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3];
const MAX_RESTARTS = 6;

let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    await tick();
  } catch (e) {
    log("tick error:", e.message || e);
  }
  reconciling = false;
}

async function tick() {
  const enabled = readEnabled();
  if (enabled === null) return;
  const edge = lastEnabled !== null && enabled !== lastEnabled;

  let probe = null;
  try {
    probe = await pageProbe();
  } catch {
    probe = null;
  }
  const portOpen = probe !== null;
  if (portOpen && probe.p) restartCount = 0; // healthy, forget backoff
  noPortStreak = enabled && !portOpen ? noPortStreak + 1 : 0;

  if (!enabled) {
    // Disabled: strip the layer and close the port once. The explicit edge
    // skips the cooldown; otherwise guard against rapid re-triggers.
    if (portOpen && (edge || Date.now() - lastClose > 60000)) {
      log("toggle off -> stripping RTL layer and closing the debug port");
      lastClose = Date.now();
      run(process.execPath, [RESTART, "--without-port"]);
    }
    lastEnabled = enabled;
    return;
  }

  // Plugin enabled. The manual switch (/rtl off) wins between toggle
  // edges; a rising toggle edge overrides it. A manual pause keeps the port
  // closed too, so the app never listens while the layer is off.
  const risingEdge = edge && lastEnabled === false;
  const wantOn = risingEdge || readSwitch() !== "0";
  if (risingEdge) log("toggle on edge");

  if (!wantOn) {
    if (portOpen && Date.now() - lastClose > 60000) {
      log("manual off -> closing the debug port");
      lastClose = Date.now();
      run(process.execPath, [RESTART, "--without-port"]);
    }
    lastEnabled = enabled;
    return;
  }

  if (portOpen) {
    if (!probe.p) {
      log("applying RTL layer");
      run(process.execPath, [INJECT, "--set", "on"]);
    }
  } else {
    // Enabled with no debug port. Restart at most with a hard backoff and a
    // total attempt cap, and only when a real main app process exists (the
    // daemon never launches the app from nothing). A no-port boot self-heals
    // on the second reconcile; a rising toggle edge acts immediately.
    if (risingEdge) restartCount = 0;
    const main = zcodeMainProcessExists();
    const waitMs =
      BACKOFF_STEPS[Math.min(restartCount, BACKOFF_STEPS.length - 1)];
    if (
      main &&
      restartCount < MAX_RESTARTS &&
      Date.now() - lastRestart > waitMs &&
      (risingEdge || noPortStreak >= 2)
    ) {
      log(
        `no debug port, restarting ZCode with the port ` +
          `(attempt ${restartCount + 1}/${MAX_RESTARTS}, ` +
          `next in ${waitMs / 60000} min+)`,
      );
      lastRestart = Date.now();
      restartCount++;
      run(process.execPath, [RESTART, "--with-port"]);
    }
  }

  lastEnabled = enabled;
}

daemonize()
  .then(() => mutex())
  .then(async (acquired) => {
    if (!acquired) process.exit(0); // an instance is already watching
    process.on("uncaughtException", (e) => {
      log("uncaughtException, exiting:", (e && (e.stack || e.message)) || e);
      process.exit(1);
    });
    process.on("unhandledRejection", (e) => {
      log("unhandledRejection:", (e && (e.stack || e.message)) || String(e));
    });
    log(
      `watching ${CONFIG}` +
        `${WORKSPACE ? " plus workspace " + WORKSPACE : ""} ` +
        `(mutex port ${MUTEX_PORT})`,
    );

    // Event-driven instead of a polling loop: react to config changes within
    // ~0.15 s, plus one light safety-net reconcile per minute (catches
    // renderer reloads and app restarts). Watch DIRECTORIES, not the config
    // files themselves: the app replaces config.json atomically (write plus
    // rename), which silently kills file watchers. Directory watchers survive.
    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        reconcile();
      }, 150);
    };
    const watchDir = (dir) => {
      try {
        const w = watch(dir, schedule);
        w.on("error", () => {
          /* dir replaced or removed; the 60 s net covers us */
        });
      } catch (e) {
        log("watch unavailable:", dir, e.message || e);
      }
    };
    watchDir(dirname(CONFIG));
    if (WORKSPACE) watchDir(join(WORKSPACE, ".zcode"));
    setInterval(reconcile, 60000);
    await reconcile();
    // Boot self-heal: a no-port session gets a second reconcile ~6 s after
    // start (the 60 s safety net would otherwise be the earliest retry).
    setTimeout(reconcile, 6000);
  });

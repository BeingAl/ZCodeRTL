#!/usr/bin/env node
/*
 * Restarts ZCode with or without the debug port, then syncs the RTL layer.
 * Electron reads --remote-debugging-port only at process start, so opening
 * or closing the port costs one app restart.
 *
 *   node restart-zcode.mjs --with-port      restart with the port, enable RTL
 *   node restart-zcode.mjs --without-port   strip RTL, restart without the port
 *
 * The first launch spawns a detached copy of itself and exits right away, so
 * a slash command can start it without killing the agent session that lives
 * inside ZCode. Works on Windows, macOS and Linux; the app binary is
 * auto-detected (env ZCODE_EXE overrides).
 *
 * Port: ZCODE_RTL_PORT from the environment or the plugin's .env file,
 * default 9222 (scripts/env.mjs).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPort } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INJECT = join(HERE, "inject-rtl.mjs");
const PORT = getPort();
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const QUIT_GRACE_MS = 3000;
// let the agent deliver its reply before the app dies
const START_DELAY_MS = 20000;
// Command-line markers of helper processes and this plugin's own
// scripts; processes matching this are never the app main process.
const HELPER_RE = new RegExp(
  "--type=|app-server|zcode\\.cjs" + "|restart-zcode|inject-rtl|heartbeat",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { windowsHide: true, timeout: 10000, ...opts });

async function portOpen(timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= end) return false;
    await sleep(1000);
  }
}

// Path of the running ZCode main process, read before killing it. The most
// reliable source for "where does the user launch the app from" because it
// works no matter how the app was installed.
function runningMainPath() {
  try {
    if (IS_WIN) {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"name='ZCode.exe'\" | " +
        "Where-Object { $_.CommandLine -notlike '*--type=*' -and " +
        "$_.CommandLine -notlike '*app-server*' } | " +
        "Select-Object -First 1 -ExpandProperty ExecutablePath";
      const out = run("powershell", ["-NoProfile", "-Command", ps])
        .stdout.toString()
        .trim();
      return out && existsSync(out) ? out : null;
    }
    if (!IS_MAC) {
      // Linux: resolve the real binary through /proc, immune to launchers
      // that rename argv or drop its arguments.
      for (const name of ["zcode", "ZCode"]) {
        const out = run("pgrep", ["-x", name]);
        if (out.status !== 0) continue;
        for (const pid of out.stdout
          .toString()
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)) {
          try {
            const cmd = readFileSync(join("/proc", pid, "cmdline"), "utf8");
            if (HELPER_RE.test(cmd)) continue;
            const exe = readlinkSync(join("/proc", pid, "exe"));
            if (exe && existsSync(exe)) return exe;
          } catch {
            /* process vanished or no permission */
          }
        }
      }
    }
    // macOS and generic fallback: parse ps output for a full binary path.
    const out = run("ps", ["ax", "-o", "command="]).stdout.toString();
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t || !/zcode/i.test(t)) continue;
      if (HELPER_RE.test(t)) continue;
      const exe = t.split(/\s+/)[0];
      if (
        exe &&
        exe.includes("/") &&
        existsSync(exe) &&
        /zcode/i.test(basename(exe))
      )
        return exe;
    }
  } catch {
    /* fall through to static candidates */
  }
  return null;
}

function locateApp() {
  const exe = process.env.ZCODE_EXE;
  if (exe && existsSync(exe)) return exe;
  const fromProc = runningMainPath();
  if (fromProc) return fromProc;
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const candidates = [
      join(process.env.LOCALAPPDATA || "", "Programs", "zcode", "ZCode.exe"),
      join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "ZCode.exe"),
      join(pf, "zcode", "ZCode.exe"),
      join(pf86, "zcode", "ZCode.exe"),
    ];
    return candidates.find((c) => c && existsSync(c)) || null;
  }
  if (IS_MAC) {
    const candidates = [
      "/Applications/ZCode.app/Contents/MacOS/ZCode",
      join(
        process.env.HOME || "",
        "Applications",
        "ZCode.app",
        "Contents",
        "MacOS",
        "ZCode",
      ),
    ];
    return candidates.find((c) => existsSync(c)) || null;
  }
  // Debian, Fedora, Arch and other Linux: the official package installs to
  // /opt/ZCode/zcode with a /usr/bin/zcode symlink; fall back to PATH.
  const candidates = [
    join("/usr", "bin", "zcode"),
    join("/usr", "local", "bin", "zcode"),
    "/opt/ZCode/zcode",
  ];
  const w = run("which", ["zcode"]);
  const onPath = w.status === 0 ? w.stdout.toString().trim() : null;
  return (
    (onPath && existsSync(onPath) ? onPath : null) ||
    candidates.find((c) => existsSync(c)) ||
    null
  );
}

function runningNow() {
  try {
    if (IS_WIN) {
      const out = run("tasklist", [
        "/FI",
        "IMAGENAME eq ZCode.exe",
        "/NH",
      ]).stdout.toString();
      return out.includes("ZCode.exe");
    }
    for (const name of ["ZCode", "zcode"]) {
      if (run("pgrep", ["-x", name]).status === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function quitApp() {
  try {
    if (IS_WIN) {
      run("taskkill", ["/IM", "ZCode.exe"]);
    } else if (IS_MAC) {
      run("osascript", ["-e", 'tell application "ZCode" to quit']);
    } else {
      run("pkill", ["-x", "ZCode"]);
      run("pkill", ["-x", "zcode"]);
    }
  } catch {
    /* already gone */
  }
  return new Promise((r) => setTimeout(r, QUIT_GRACE_MS));
}

function forceQuit() {
  try {
    if (IS_WIN) run("taskkill", ["/F", "/IM", "ZCode.exe"]);
    else
      for (const name of ["ZCode", "zcode"]) {
        run("pkill", ["-9", "-x", name]);
      }
  } catch {
    /* already gone */
  }
}

function startApp(flag) {
  const args = flag ? [flag] : [];
  const exe = locateApp();
  if (exe) {
    spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return true;
  }
  if (IS_MAC) {
    // Not at a known path: launch through the bundle and hand it the flag.
    spawn("open", ["-a", "ZCode", ...(flag ? ["--args", flag] : [])], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return true;
  }
  return false;
}

async function injectOn() {
  // The browser endpoint opens before the first page target is listed and
  // the renderer may still be restoring, so retry until the layer is on.
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    try {
      const out = execFileSync(process.execPath, [INJECT, "--set", "on"], {
        windowsHide: true,
        timeout: 30000,
      }).toString();
      if (out.includes("RTL_ENABLED")) return true;
    } catch (e) {
      if (String(e.stdout || "").includes("RTL_ENABLED")) return true;
    }
  }
  return false;
}

async function runRestart(withPort) {
  await sleep(START_DELAY_MS);
  const open = await portOpen(0);
  if (withPort && open) {
    // Port is already open: no restart needed, just enable the layer.
    await injectOn();
    return;
  }
  if (!withPort) {
    // Strip the layer first so the closing app never re-applies it, then
    // close the port: back to the fully-off state.
    try {
      execFileSync(process.execPath, [INJECT, "--set", "off"], {
        windowsHide: true,
        timeout: 30000,
      });
    } catch {
      /* port closed, nothing injected anywhere */
    }
    if (!(await portOpen(0))) return; // already closed, nothing to do
  }
  await quitApp();
  if (runningNow()) {
    forceQuit();
    await sleep(2000);
  }
  if (!startApp(withPort ? `--remote-debugging-port=${PORT}` : null)) return;
  if (withPort) {
    if (await portOpen(60000)) await injectOn();
  }
}

const args = process.argv.slice(2);
const withPort = args.includes("--with-port");
const withoutPort = args.includes("--without-port");

if (!args.includes("--run")) {
  if (!withPort && !withoutPort) {
    console.log("usage: node restart-zcode.mjs --with-port | --without-port");
    process.exit(1);
  }
  // Detach: the caller (a slash command inside the app) must not be killed
  // together with ZCode. The detached copy does the actual work.
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...args, "--run"],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  process.exit(0);
}

runRestart(withPort);

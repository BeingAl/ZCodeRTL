# ZCode RTL

Automatic RTL/LTR text direction for the ZCode Desktop chat UI. RTL
text becomes right aligned with correct word order, while code and
Latin text stay left to right.

ZCode Desktop has no RTL option and its plugin system cannot restyle
the host UI, so this plugin injects the direction layer into the
running app through the Chromium DevTools Protocol. No ZCode file is
modified, so it keeps working across app updates. RTL is off by
default; the debug port opens only while RTL is enabled and closes
again when you disable it.

- RTL text is detected per element by letter ratio and forced RTL;
  mostly-Latin blocks stay LTR.
- Code blocks, commands and tool-block chrome stay LTR; RTL prose
  inside tool bodies becomes RTL.
- Tables mirror (first column on the right) and wrap long values; the
  sidebar is untouched.
- The layer re-applies itself while the model is streaming.

## Requirements

| Requirement | Detail                                  |
| ----------- | --------------------------------------- |
| OS          | ZCode Desktop on Windows, macOS, Linux  |
| Node.js     | 22 or newer (`node --version` to check) |

## Installation

1. In ZCode open **Plugin Marketplace**, choose **Add**, then **Add
   Plugin Marketplace**, and paste this repository URL:

   ```text
   https://github.com/BeingAl/ZCodeRTL
   ```

2. Open the marketplace you just added (Personal tab), find
   **ZCode RTL**, and press **Install**. The plugin appears under
   **Settings > Plugin Management > Installed**.

That is all. Nothing listens and nothing runs until you enable RTL.

## Manual Setup

If you prefer to run things by hand instead of the slash command,
start ZCode with the debug port and run the injector. The port in the
examples below is the default; it must match `ZCODE_RTL_PORT` in the
plugin's `.env` file (see _Configuration_ below) if you changed it.

Windows (PowerShell):

```powershell
& "$env:LOCALAPPDATA\Programs\zcode\ZCode.exe" --remote-debugging-port=9222
node <plugin-folder>\scripts\inject-rtl.mjs --set on
```

macOS:

```bash
/Applications/ZCode.app/Contents/MacOS/ZCode --remote-debugging-port=9222 &
node <plugin-folder>/scripts/inject-rtl.mjs --set on
```

Linux (Debian, Fedora, Arch and other distributions):

```bash
zcode --remote-debugging-port=9222 &
node <plugin-folder>/scripts/inject-rtl.mjs --set on
```

`<plugin-folder>` is the plugin install cache, for example
`~/.zcode/cli/plugins/cache/zcode-rtl-plugin/zcode-rtl/<version>`.
The injector itself is plain Node with zero dependencies.

## Configuration

| Setting          | Default | Purpose                                      |
| ---------------- | ------- | -------------------------------------------- |
| `ZCODE_RTL_PORT` | `9222`  | Chromium DevTools Protocol port of the app   |
| `ZCODE_EXE`      | unset   | ZCode binary path, when auto-detection fails |

The settings live in the plugin's `.env` file at the plugin root,
next to `scripts/` (template: `.env.example`). A real environment
variable always wins over the file, and anything unset falls back to
the built-in default.

`ZCODE_RTL_PORT` must match the `--remote-debugging-port` flag
ZCode is started with; `restart-zcode.mjs` starts the app with the
same value automatically.

Set `ZCODE_EXE` only when the
auto-detection in `restart-zcode.mjs` fails on your machine.

## Usage

Type `/rtl` in the ZCode chat:

| Command    | Effect                                 |
| ---------- | -------------------------------------- |
| `/rtl on`  | Enables the RTL layer                  |
| `/rtl off` | Disables RTL and closes the debug port |

Both commands return immediately and a detached background copy does
the work. On the first `/rtl on` the debug port is still closed, so
ZCode restarts once with the port and RTL comes back on by itself.
`/rtl off` strips the layer, closes the port with one app restart,
stops the background watcher, and leaves the app in the default
state where nothing listens.

The switch is stored in `localStorage["zcodeRtl:enabled"]` and applied
by an in-page function, so it survives page reloads. An app restart is
only needed to open or close the port itself, because Electron reads
that flag at process start.

The Plugin Management toggle acts as a live switch too: a background
heartbeat, started by the SessionStart hook, applies the layer when
you enable the plugin and strips it and closes the port when you
disable it. Turning off also stops the heartbeat itself, so nothing
keeps running; the next session start brings the watcher back.

## Notes

- The debug port binds to `127.0.0.1` only and is reachable from this
  machine only. It is not exposed to the network. Do not forward it,
  for example through SSH or a container port mapping.
- The port is open only while RTL is enabled. `/rtl off` and the
  Plugin Management toggle close it again.
- The on/off state is remembered in a small local file,
  `~/.zcode/rtl-switch`. A manual off survives app restarts, and a
  fresh install starts with the port closed until you run `/rtl on`
  for the first time.
- No ZCode file is modified on disk. The layer applies live styles to
  the running renderer, so it keeps working after app updates.

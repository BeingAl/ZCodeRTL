---
description: Toggle automatic RTL/LTR text direction in the ZCode chat UI
---

Control the automatic RTL/LTR text direction layer of the ZCode Desktop
chat UI.

Locate the plugin's scripts folder first (the install cache is the
reliable place; pick the highest version folder):

```
~/.zcode/cli/plugins/cache/zcode-rtl-plugin/zcode-rtl/<version>/scripts
```

On Windows the same path lives under `C:\Users\<you>\.zcode\`
instead of `~/.zcode/`. All commands below use
`<S>` = that scripts folder. The injector talks to the ZCode renderer
over the Chromium DevTools Protocol. The port comes from the plugin's
`.env` file (key `ZCODE_RTL_PORT`, default 9222; see `<plugin>/.env`
and `.env.example`), and a real `ZCODE_RTL_PORT` environment variable
wins over the file. The debug port is read by Electron only at process
start, and the agent runs inside ZCode, so **never run
`restart-zcode.mjs` with `--run` or any foreground restart
synchronously from a session**: it would kill the app and this session
with it. Use the plain invocations below; they return immediately and
the detached background copy does the work.

User arguments: "$ARGUMENTS"

Pick the branch. With no arguments, or with arguments saying
"apply" or "fix", pick **on**:

1. **`on`**: enable the RTL layer.
   - Run: `node "<S>/inject-rtl.mjs" --set on`
   - `RTL on: <page> -> RTL_ENABLED` means it is done; no restart
     happened. Report success.
   - `PORT_CLOSED` means ZCode is running without the debug port
     (expected on first enable). Run:
     `node "<S>/restart-zcode.mjs" --with-port`
     It returns immediately; a detached background copy waits a few
     seconds, restarts ZCode once with the port, and enables RTL
     automatically. Tell the user the app will close and reopen once
     and RTL comes back on by itself.

2. **`off`** (or `disable`): turn the RTL layer off completely.
   - Run: `node "<S>/inject-rtl.mjs" --set off` (strips the layer
     instantly)
   - Then run: `node "<S>/restart-zcode.mjs" --without-port`
     It returns immediately; the detached copy closes the debug port
     with one app restart. This is the default privacy state: nothing
     listens.

Notes for the agent:

- If the injector reports that the payload threw an exception, a ZCode
  update changed the DOM. Do not attempt repairs; tell the user.

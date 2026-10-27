/*
 * ZCode RTL: automatic RTL/LTR text direction for the ZCode Desktop chat
 * renderer. Injected through the Chrome DevTools Protocol.
 *
 * RTL text becomes RTL and right aligned.
 * English text, code and tool-block chrome stay LTR.
 *
 * Behavior:
 *   - RTL text (>= 20% RTL letters) -> forced RTL, right-aligned
 *   - Latin-only and Latin-dominant text -> explicit LTR, left-aligned
 *   - code blocks                   -> LTR, untouched
 *   - tables                        -> follow their own content: an RTL
 *         table mirrors (first column at the right), an LTR table stays
 *         LTR; cells wrap long values, Latin tokens stay intact
 *   - user bubble and its edit/copy toolbar pinned right, assistant left
 *   - sidebar and app chrome        -> completely untouched
 *   - debounced 200 ms rescan after streaming mutations
 *
 * The layer has a persistent switch: localStorage["zcodeRtl:enabled"]
 * ('1' by default, '0' = off). window.__zcodeRtlSetEnabled(true|false)
 * toggles it live in both directions with no page reload: enable starts the
 * layer, disable strips exactly the styles this payload set and disconnects
 * its observer. The payload is idempotent and safe to inject repeatedly.
 */
(function zcodeRtl() {
  // Every element and property we set, so disable can strip them without a
  // page reload.
  const TOUCHED = new Map();
  function force(el, props) {
    if (!el || el.nodeType !== 1) return;
    let rec = TOUCHED.get(el);
    if (!rec) {
      rec = new Set();
      TOUCHED.set(el, rec);
    }
    for (const k in props) {
      rec.add(k);
      el.style.setProperty(k, props[k], "important");
    }
  }

  // RTL letter detection: the Unicode blocks whose letters are written
  // right-to-left, including their supplements, extensions and presentation
  // forms.
  const RTL_CHARS = new RegExp(
    "[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF" +
      "\uFB50-\uFDFF\uFE70-\uFEFF]",
  );

  // Forced RTL: `embed` (NOT `plaintext`) so the browser cannot re-resolve
  // the direction from content and override our explicit rtl.
  const RTL_FORCE = {
    direction: "rtl",
    "text-align": "right",
    "unicode-bidi": "embed",
  };
  const RTL_LIST = {
    direction: "rtl",
    "text-align": "right",
    "unicode-bidi": "embed",
    "padding-left": "0",
    "padding-right": "1.5em",
    "margin-left": "0",
    "margin-right": "0",
  };
  const LTR_TEXT = {
    direction: "ltr",
    "text-align": "left",
    "unicode-bidi": "embed",
  };
  // Tables go fully RTL: first column at the right, everything right-aligned;
  // Latin tokens stay intact as embedded LTR runs.
  const RTL_TABLE = {
    direction: "rtl",
    "text-align": "right",
    "unicode-bidi": "embed",
    "overflow-wrap": "break-word",
  };
  const NEUTRAL = {
    direction: "auto",
    "text-align": "start",
    "unicode-bidi": "plaintext",
  };

  const MSG_SEL =
    '[class*="message" i],[class*="Message" i],' +
    '[class*="chat" i],[class*="Chat" i],' +
    '[class*="bubble" i],[class*="Bubble" i],' +
    '[class*="msg" i],[class*="Msg" i],' +
    '[class*="conversation" i],[class*="Conversation" i],' +
    '[class*="markdown" i],[class*="prose" i],[class*="content" i]';

  // Sidebar and other app chrome stay completely untouched: the RTL rules
  // apply to the chat transcript only. The real workspace sidebar is the
  // ASIDE panel with the workspace-sidebar-* width classes. A generic
  // [class*="sidebar"] selector must NOT be used: on app 3.16.x the flex row
  // that holds [sidebar | chat] carries an arbitrary Tailwind class
  // whose name is built on the custom property --sidebar-task-list-divider,
  // so a substring match would exclude the whole chat transcript.
  const EXCLUDE_SEL =
    '#sidebar,[id*="sidebar" i],aside,' + '[class*="workspace-sidebar" i]';
  function isExcluded(el) {
    return !!(el.closest && el.closest(EXCLUDE_SEL));
  }

  // True when the element CONTAINS an excluded (sidebar) node. Such wrappers
  // sit above the sidebar and must never receive rtl: an rtl ancestor
  // reverses flex order and moves the app sidebar to the right edge.
  function containsExcluded(el) {
    return !!(el.querySelector && el.querySelector(EXCLUDE_SEL));
  }

  function isCode(el) {
    const t = (el.tagName || "").toLowerCase();
    return t === "pre" || t === "code" || /code/i.test(el.className || "");
  }

  // Tool blocks (terminal / thinking / edit) are shadcn collapsibles marked
  // by a .tool-summary or .reasoning row. The block chrome stays LTR, but
  // RTL prose inside the expanded body must still be RTL, so only the
  // zone root and the marker rows are locked here. Text leaves inside the
  // body fall through to the normal ratio rule.
  const TOOL_MARK = '[class*="tool-summary"],[class*="reasoning"]';
  const TOOL_ZONE = '[data-slot="collapsible"]:has(' + TOOL_MARK + ")";
  function isToolZone(el) {
    if (!el.closest) return false;
    return !!el.closest(TOOL_MARK) || !!el.closest(TOOL_ZONE);
  }
  // One pass per process(): pin zone roots LTR/left and chrome rows hard LTR.
  function fixToolBlocks(root) {
    root = root || document;
    root.querySelectorAll(TOOL_ZONE).forEach((zone) => {
      force(zone, { direction: "ltr", "text-align": "left" });
    });
    root.querySelectorAll(TOOL_MARK).forEach((m) => force(m, LTR_TEXT));
  }

  // Direction is decided by ratio, not by "any RTL char": streamed
  // thinking text is mostly English with the occasional quoted foreign
  // phrase, and a single RTL word must not flip the whole block. Real RTL
  // paragraphs score far above 20% RTL letters.
  function rtlRatio(str) {
    const letters = (str || "").replace(/\s/g, "");
    if (!letters) return 0;
    const hits = str.match(new RegExp(RTL_CHARS.source, "g")) || [];
    return hits.length / letters.length;
  }
  function isRtlDominant(str) {
    return RTL_CHARS.test(str) && rtlRatio(str) >= 0.2;
  }

  // True when any child is block-level, i.e. the element is a layout
  // container, not a text leaf. Containers must not get leaf-level
  // direction overrides.
  function hasBlockChild(el) {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const d = getComputedStyle(kids[i]).display;
      if (d !== "inline" && d !== "contents" && d.indexOf("inline") !== 0)
        return true;
    }
    return false;
  }

  // Tables follow their own content: a table whose text is RTL-dominant
  // renders fully RTL (first column at the right), an LTR table stays LTR.
  // The decision is computed once on the table container (a real <table> or
  // a div-based grid) and cached, so every part of one table gets the same
  // direction and Latin-valued cells stay aligned like their neighbors.
  function tableForce(el) {
    const container = el.closest && el.closest('table,[class*="table" i]');
    if (!container) {
      force(el, LTR_TEXT);
      return;
    }
    if (container.__zcodeRtlTableRtl === undefined) {
      container.__zcodeRtlTableRtl = isRtlDominant(container.textContent || "");
    }
    force(el, container.__zcodeRtlTableRtl ? RTL_TABLE : LTR_TEXT);
  }

  // Tables fit the pane width instead of overflowing, so long values wrap
  // and nothing needs horizontal scrolling.
  function markPaneChain(pane, table) {
    // Start above the table: the table and its cells keep going through the
    // normal branches (fully RTL); only the wrappers between the table and
    // the scroll pane (inclusive) are pinned LTR.
    let n = table.parentElement;
    while (n) {
      n.__zcodeRtlPaneChain = true;
      if (n === pane) break;
      n = n.parentElement;
    }
  }
  function fixTableScroll(root) {
    root = root || document;
    root.querySelectorAll("table").forEach((t) => {
      if (isExcluded(t)) return;
      force(t, {
        width: "100%",
        "min-width": "0",
        "table-layout": "auto",
        "white-space": "normal",
      });
      t.querySelectorAll("td,th").forEach((c) => {
        force(c, {
          "white-space": "normal",
          "overflow-wrap": "anywhere",
          "word-break": "normal",
        });
      });
      // The wrappers around the table keep native LTR so nothing re-flips.
      let anc = t.parentElement,
        depth = 0;
      while (anc && depth < 6) {
        const s = getComputedStyle(anc);
        const ox = s.overflowX;
        if (ox.indexOf("auto") >= 0 || ox.indexOf("scroll") >= 0) {
          markPaneChain(anc, t);
          force(anc, { direction: "ltr" });
          anc.scrollLeft = 0; // fitted table: nothing off-pane to scroll to
          break;
        }
        anc = anc.parentElement;
        depth++;
      }
    });
  }

  function processEl(el) {
    // One broken element must never abort a whole pass.
    try {
      processElInner(el);
    } catch (e) {
      /* skip broken subtree */
    }
  }

  function processElInner(el) {
    if (!el || el.nodeType !== 1) return;
    if (isExcluded(el)) return; // sidebar/chrome: never touched
    // Table-to-scroll-pane chain: stays native LTR. These wrappers hold the
    // table's RTL text, so the generic rule would rtl them on every
    // pass and break the pane scroll coordinates.
    if (el.__zcodeRtlPaneChain) {
      force(el, { direction: "ltr" });
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) processEl(kids[i]);
      return;
    }
    if (isCode(el)) {
      force(el, LTR_TEXT);
      return;
    }
    // Tool block zone root: pinned LTR/left so the block never mirrors.
    if (el.matches && el.matches(TOOL_ZONE)) {
      force(el, { direction: "ltr", "text-align": "left" });
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) processEl(kids[i]);
      return;
    }
    if (el.closest && el.closest(TOOL_MARK)) {
      force(el, LTR_TEXT);
      return;
    }

    const tag = (el.tagName || "").toLowerCase();

    // Tables: structure and cells follow the table's own content decision
    // (tableForce). This must run before the content rules below, so a
    // Latin-valued cell keeps the direction of its table instead of being
    // forced LTR independently.
    if (
      tag === "table" ||
      tag === "thead" ||
      tag === "tbody" ||
      tag === "tr" ||
      tag === "td" ||
      tag === "th"
    ) {
      tableForce(el);
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) processEl(kids[i]);
      return;
    }

    const text = el.textContent || "";
    const disp = getComputedStyle(el).display;
    const isLayout = disp.indexOf("flex") >= 0 || disp.indexOf("grid") >= 0;

    // Div-based tables: ZCode may render markdown tables as div grids, so
    // the td branch never fires. Apply the same per-cell rule to any
    // near-leaf element inside a table scope, again before the content
    // rules below so Latin-valued pseudo-cells keep their table direction.
    const inTable =
      !isLayout && el.closest && el.closest('table,[class*="table" i]');
    if (inTable && !hasBlockChild(el)) {
      tableForce(el);
    } else {
      // Latin-only and Latin-dominant text gets an EXPLICIT ltr. This is
      // the critical rule: `direction: auto` is not a valid CSS value on
      // normal elements, so anything left unpstyled here would silently
      // inherit rtl from an RTL ancestor and render English paragraphs
      // right-to-left. Plain English with numbers, emoji, URLs or
      // punctuation contains no RTL letters at all, and mixed text that is
      // still Latin-dominant (below the 20% threshold) must not inherit
      // rtl either.
      if (!isRtlDominant(text)) {
        force(el, LTR_TEXT);
        return;
      }
      if (tag === "ul" || tag === "ol") {
        // RTL or mixed list: goes RTL so CSS-generated markers/numbers
        // land on the right.
        force(el, RTL_LIST);
      } else if (tag === "li") {
        force(el, RTL_FORCE);
      } else if (!isLayout) {
        // Core rule: RTL by ratio, but never on an element that contains the
        // sidebar (layout wrapper): flipping those reorders the whole app
        // layout.
        if (!containsExcluded(el)) force(el, RTL_FORCE);
      }
    }

    const kids = el.children;
    for (let i = 0; i < kids.length; i++) processEl(kids[i]);
  }

  // Locate the actual chat bubble inside a row: follow the chain of
  // full-width wrappers down to the first clearly-narrower box, that is the
  // bubble. Full-width bubbles return null (nothing to pin).
  function bubbleOf(row) {
    const known = row.querySelector('[class*="max-w-"]');
    if (known && known.getBoundingClientRect().width > 20) return known;
    const rw = row.getBoundingClientRect().width;
    if (!rw) return null;
    let b = row;
    while (b.firstElementChild) {
      const c = b.firstElementChild;
      const w = c.getBoundingClientRect().width;
      if (w > 20 && w < rw * 0.985) return c;
      b = c;
    }
    return null;
  }

  // Pin the user's message bubble to the right and the assistant's to the
  // left using physical properties (direction-independent) so it never
  // flips sides.
  const USER_ROW = '[class*="user-row" i]';
  const ASST_ROW =
    '[class*="assistant-row" i],[class*="ai-row" i],' + '[class*="bot-row" i]';
  function fixBubbleSides(root) {
    root = root || document;
    root.querySelectorAll(USER_ROW).forEach((row) => {
      if (isExcluded(row)) return;
      // avatar chips etc., not chat rows
      if (row.getBoundingClientRect().width < 100) return;
      const disp = getComputedStyle(row).display;
      if (
        (disp.indexOf("flex") >= 0 || disp.indexOf("grid") >= 0) &&
        getComputedStyle(row).flexDirection !== "column" &&
        getComputedStyle(row).flexDirection !== "column-reverse"
      ) {
        // Pin direction ltr too: rows inherit rtl from an RTL message,
        // and in an rtl flex container flex-end is the physical LEFT.
        force(row, { "justify-content": "flex-end", direction: "ltr" });
      }
      const b = bubbleOf(row);
      if (b) {
        b.style.setProperty("margin-left", "auto", "important");
        b.style.setProperty("margin-right", "0", "important");
      }
      // Edit mode: while a user message is being edited the bubble is
      // replaced by an editor box that bubbleOf() cannot identify. Climb
      // from the row's textarea/contenteditable up to the row's direct
      // child and pin every box on that path physically right.
      const field = row.querySelector(
        'textarea,[contenteditable="true"],[contenteditable=""]',
      );
      if (field && !field.__zcodeRtlInputPinned) {
        let n = field;
        while (n && n !== row) {
          if (n.parentElement === row) {
            n.style.setProperty("margin-left", "auto", "important");
            n.style.setProperty("margin-right", "0", "important");
          }
          // editor chrome stays LTR; text dir is per-field
          force(n, { direction: "ltr" });
          n = n.parentElement;
        }
        force(field, {
          direction: "auto",
          "text-align": "start",
          "unicode-bidi": "plaintext",
        });
        field.__zcodeRtlInputPinned = true;
      }
    });
    root.querySelectorAll(ASST_ROW).forEach((row) => {
      if (isExcluded(row)) return;
      const disp = getComputedStyle(row).display;
      if (
        (disp.indexOf("flex") >= 0 || disp.indexOf("grid") >= 0) &&
        getComputedStyle(row).flexDirection !== "column" &&
        getComputedStyle(row).flexDirection !== "column-reverse"
      ) {
        force(row, { "justify-content": "flex-start", direction: "ltr" });
      }
      const b = bubbleOf(row);
      if (b) {
        b.style.setProperty("margin-right", "auto", "important");
        b.style.setProperty("margin-left", "0", "important");
      }
    });
  }

  // The edit/copy action toolbar under the user bubble is a flex-row
  // container; pin every button-bearing flex-row inside the user row to the
  // right edge. direction ltr is essential: these toolbars inherit rtl from
  // the RTL message, and in an rtl flex-row flex-end = physical LEFT.
  function fixUserActions(root) {
    root = root || document;
    root.querySelectorAll(USER_ROW).forEach((row) => {
      if (isExcluded(row)) return;
      row.querySelectorAll("div").forEach((d) => {
        if (!d.querySelector("button")) return;
        const cs = getComputedStyle(d);
        if (cs.display.indexOf("flex") < 0 || cs.flexDirection !== "row")
          return;
        d.style.setProperty("direction", "ltr", "important");
        d.style.setProperty("justify-content", "flex-end", "important");
        d.style.setProperty("margin-left", "auto", "important");
        d.style.setProperty("margin-right", "0", "important");
        d.style.setProperty("align-self", "flex-end", "important");
      });
    });
  }

  function processMessages(root) {
    root = root || document;
    root.querySelectorAll(MSG_SEL).forEach((el) => {
      // Only process outermost matches (recursion covers the rest) and never
      // descend into code blocks or the sidebar from outside.
      if (isExcluded(el)) return;
      if (el.parentElement && el.parentElement.closest(MSG_SEL)) return;
      if (el.closest && el.closest("pre,code")) return;
      processEl(el);
    });
    root
      .querySelectorAll(
        'textarea,input,[contenteditable="true"],[contenteditable=""]',
      )
      .forEach((e) => {
        if (!isExcluded(e)) force(e, NEUTRAL);
      });
    root.querySelectorAll('pre,code,[class*="code" i]').forEach((e) => {
      if (!isExcluded(e)) force(e, LTR_TEXT);
    });
  }

  function process(root) {
    root = root || document;
    force(root.documentElement || document.documentElement, {
      direction: "ltr",
    });
    force(root.body || document.body, { direction: "ltr" });
    processMessages(root);
    fixBubbleSides(root);
    fixUserActions(root);
    fixTableScroll(root);
    fixToolBlocks(root);
    // Repair: an earlier pass may have put inline rtl/right on layout
    // wrappers that contain the sidebar while sitting outside the chat
    // scope. That reorders the app layout and its text-align:right keeps
    // inheriting into the excluded sidebar. Reset those; chat-scoped rtl is
    // legit and untouched.
    root
      .querySelectorAll(
        '[style*="direction: rtl"],' +
          '[style*="direction:rtl"],' +
          '[style*="text-align: right"],' +
          '[style*="text-align:right"]',
      )
      .forEach((el) => {
        if (isExcluded(el)) return;
        if (el.closest && el.closest(MSG_SEL)) return;
        if (containsExcluded(el)) {
          force(el, {
            direction: "ltr",
            "text-align": "left",
            "unicode-bidi": "normal",
          });
        }
      });
  }

  // Everything that touches document.body lives in start(), which waits for
  // DOMContentLoaded when injected at document-start via CDP. Repeated
  // injections are safe: process() is idempotent and the observer is
  // guarded by window.__zcodeRtlObserver.
  function start() {
    process(document);

    // Always re-check after streaming mutations: decisions made on partial
    // content (React node reuse mid-stream) get corrected within 200 ms.
    window.__zcodeRtlProcess = process;
    if (!window.__zcodeRtlObserver) {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.closest && (n.closest("pre,code") || isExcluded(n))) continue;
            // Only style nodes inside the chat transcript scope. Processing
            // every added node made high-level layout wrappers (which merely
            // contain the messages) score RTL-dominant and flipped the
            // whole app layout rtl.
            const inChatScope =
              (n.matches && n.matches(MSG_SEL)) ||
              (n.closest && n.closest(MSG_SEL));
            if (inChatScope) processEl(n);
            if (
              (n.matches && (n.matches(USER_ROW) || n.matches(ASST_ROW))) ||
              (n.querySelector &&
                (n.querySelector(USER_ROW) || n.querySelector(ASST_ROW)))
            ) {
              fixBubbleSides(n);
              fixUserActions(n);
            }
          }
        }
        if (window.__zcodeRtlTimer == null) {
          window.__zcodeRtlTimer = setTimeout(() => {
            window.__zcodeRtlTimer = null;
            if (window.__zcodeRtlProcess) window.__zcodeRtlProcess(document);
          }, 200);
        }
      });
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.__zcodeRtlObserver = obs;
    }

    console.log("[ZCode RTL] applied.");
  }

  // Persistent on/off switch. '0' in localStorage disables the layer;
  // disabling strips exactly the styles this payload set, with no reload.
  const LS_KEY = "zcodeRtl:enabled";
  function rtlEnabled() {
    try {
      return localStorage.getItem(LS_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }
  function stripAll() {
    for (const [el, props] of TOUCHED) {
      try {
        for (const k of props) el.style.removeProperty(k);
        if (el.style && el.style.length === 0) el.removeAttribute("style");
      } catch (e) {
        /* detached node, ignore */
      }
    }
    TOUCHED.clear();
  }
  function stopObserver() {
    if (window.__zcodeRtlObserver) {
      try {
        window.__zcodeRtlObserver.disconnect();
      } catch (e) {
        /* noop */
      }
      window.__zcodeRtlObserver = null;
    }
  }
  window.__zcodeRtlSetEnabled = function (v) {
    try {
      localStorage.setItem(LS_KEY, v ? "1" : "0");
    } catch (e) {
      /* storage blocked */
    }
    if (v) {
      if (!window.__zcodeRtlObserver) start();
      console.log("[ZCode RTL] enabled.");
    } else {
      try {
        stripAll();
      } catch (e) {
        /* nothing touched */
      }
      stopObserver();
      window.__zcodeRtlProcess = null;
      console.log("[ZCode RTL] disabled.");
    }
  };

  if (!rtlEnabled()) {
    console.log("[ZCode RTL] layer off (zcodeRtl:enabled=0).");
    return;
  }

  if (document.body) {
    stopObserver(); // a previous evaluation's closure must not survive
    start();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(start, 0);
    });
  }
})();

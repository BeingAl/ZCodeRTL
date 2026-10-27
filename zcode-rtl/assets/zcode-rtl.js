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
 * Styling model: every touched element gets one data attribute and ONE
 * stylesheet carries the rules. React wipes inline styles on re-render,
 * which let RTL text inherit the wrong direction mid-stream; React never
 * manages unknown data attributes or our style tag, so this layer
 * survives app re-renders untouched.
 *
 * The layer has a persistent switch: localStorage["zcodeRtl:enabled"]
 * ('1' by default, '0' = off). window.__zcodeRtlSetEnabled(true|false)
 * toggles it live in both directions with no page reload: enable starts
 * the layer, disable removes the stylesheet and every data attribute.
 * The payload is idempotent and safe to inject repeatedly.
 */
(function zcodeRtl() {
  // One stylesheet carries every rule; touched elements only carry their
  // kind, so a repeated pass rewrites nothing and a disable removes both.
  const ATTR = "data-zcode-rtl";
  const STYLE_ID = "zcode-rtl-style";
  const RULES = [
    '[data-zcode-rtl="rtl"]{direction:rtl!important;',
    "text-align:right!important;unicode-bidi:embed!important}",
    '[data-zcode-rtl="ltr"]{direction:ltr!important;',
    "text-align:left!important;unicode-bidi:embed!important}",
    '[data-zcode-rtl="list"]{direction:rtl!important;',
    "text-align:right!important;unicode-bidi:embed!important;",
    "padding-left:0!important;padding-right:1.5em!important;",
    "margin-left:0!important;margin-right:0!important}",
    '[data-zcode-rtl="table"]{direction:rtl!important;',
    "text-align:right!important;unicode-bidi:embed!important;",
    "overflow-wrap:break-word!important}",
    '[data-zcode-rtl="ltrtable"]{direction:ltr!important;',
    "text-align:left!important;unicode-bidi:embed!important;",
    "overflow-wrap:break-word!important}",
    '[data-zcode-rtl="neutral"]{direction:auto!important;',
    "text-align:start!important;unicode-bidi:plaintext!important}",
    '[data-zcode-rtl="pane"]{direction:ltr!important}',
    '[data-zcode-rtl="zone"]{direction:ltr!important;',
    "text-align:left!important}",
    '[data-zcode-rtl="reset"]{direction:ltr!important;',
    "text-align:left!important;unicode-bidi:normal!important}",
    '[data-zcode-rtl="fit"]{width:100%!important;min-width:0!important;',
    "table-layout:auto!important;white-space:normal!important}",
    '[data-zcode-rtl="cell"]{white-space:normal!important;',
    "overflow-wrap:anywhere!important;word-break:normal!important}",
    '[data-zcode-rtl="row-end"]{justify-content:flex-end!important;',
    "direction:ltr!important}",
    '[data-zcode-rtl="row-start"]{justify-content:flex-start!important;',
    "direction:ltr!important}",
    '[data-zcode-rtl="pin-right"]{margin-left:auto!important;',
    "margin-right:0!important}",
    '[data-zcode-rtl="pin-left"]{margin-right:auto!important;',
    "margin-left:0!important}",
    '[data-zcode-rtl="edit-box"]{direction:ltr!important;',
    "margin-left:auto!important;margin-right:0!important}",
    '[data-zcode-rtl="actions"]{direction:ltr!important;',
    "justify-content:flex-end!important;margin-left:auto!important;",
    "margin-right:0!important;align-self:flex-end!important}",
  ].join(" ");
  const TOUCHED = new Set();

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = RULES;
    (document.head || document.documentElement).appendChild(tag);
  }

  function force(el, kind) {
    if (!el || el.nodeType !== 1) return;
    if (el.getAttribute(ATTR) !== kind) el.setAttribute(ATTR, kind);
    TOUCHED.add(el);
  }

  // RTL letter detection: the Unicode blocks whose letters are written
  // right-to-left, including their supplements, extensions and presentation
  // forms.
  const RTL_CHARS = new RegExp(
    "[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF" +
      "\uFB50-\uFDFF\uFE70-\uFEFF]",
  );

  const MSG_SEL =
    '[class*="message" i],[class*="Message" i],' +
    '[class*="chat" i],[class*="Chat" i],' +
    '[class*="bubble" i],[class*="Bubble" i],' +
    '[class*="msg" i],[class*="Msg" i],' +
    '[class*="conversation" i],[class*="Conversation" i],' +
    '[class*="markdown" i],[class*="prose" i],[class*="content" i]';

  // Sidebar and other app chrome stay completely untouched: the RTL rules
  // apply to the chat transcript only. The real workspace sidebar is the
  // ASIDE panel with the workspace-sidebar-* width classes. Detection is
  // token-aware: a PLAIN class token mentioning "sidebar" always marks
  // chrome, so a future rename of workspace-sidebar-* cannot let the panel
  // get flipped. Bracketed Tailwind classes like
  // [anchor-scope:--sidebar-task-list-divider...] on app 3.16.x also contain
  // the word but are generated names, not real classes, and hasPlainToken
  // skips them; a substring class match must never be used here.
  function isExcluded(el) {
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      const t = (n.tagName || "").toLowerCase();
      if (t === "aside") return true;
      if (/sidebar/i.test(n.id || "")) return true;
      if (hasPlainToken(n, /sidebar/i)) return true;
      n = n.parentElement;
    }
    return false;
  }

  // Subtree check for the wrapper-repair rules below; the plain token walk
  // would be too costly here, so the known CSS names carry this one.
  const EXCLUDE_SEL = "aside,[id*='sidebar' i],[class*='workspace-sidebar' i]";

  // True when the element CONTAINS an excluded (sidebar) node. Such wrappers
  // sit above the sidebar and must never receive rtl: an rtl ancestor
  // reverses flex order and moves the app sidebar to the right edge.
  function containsExcluded(el) {
    return !!(el.querySelector && el.querySelector(EXCLUDE_SEL));
  }

  // True when one of the element's plain class tokens matches re. Tailwind
  // arbitrary properties and values always carry a bracket somewhere in the
  // token ([--markdown-table-gutter:...], even variant-prefixed like
  // max-md:[--markdown-table-layout-left-inset:8px]) and on app 3.16.x the
  // chat scroll pane carries them: a greedy [class*="table"] match treats
  // every chat message as a table cell and forces all RTL text back to LTR.
  function hasPlainToken(el, re) {
    const cls = (el.className || "").toString();
    if (!cls) return false;
    return cls.split(/\s+/).some((t) => t && !t.includes("[") && re.test(t));
  }

  // The table scope of an element: a real table element, or a div-based
  // grid wrapper whose class token says "table".
  function closestTable(el) {
    let n = el;
    while (n) {
      const t = (n.tagName || "").toLowerCase();
      if (
        t === "table" ||
        t === "thead" ||
        t === "tbody" ||
        t === "tr" ||
        t === "td" ||
        t === "th"
      ) {
        return n;
      }
      if (hasPlainToken(n, /table/i)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function isCode(el) {
    const t = (el.tagName || "").toLowerCase();
    return t === "pre" || t === "code" || hasPlainToken(el, /code/i);
  }

  // Tool blocks (terminal / thinking / edit) are shadcn collapsibles marked
  // by a .tool-summary or .reasoning row. The block chrome stays LTR, but
  // RTL prose inside the expanded body must still be RTL, so only the
  // zone root and the marker rows are locked here. Text leaves inside the
  // body fall through to the normal ratio rule.
  const TOOL_MARK = '[class*="tool-summary"],[class*="reasoning"]';
  // :has() needs Chromium 105 or newer. Degrade to the marker rows when a
  // future engine drops it, so one selector can never break the whole pass.
  const HAS_SELECTOR =
    typeof CSS !== "undefined" &&
    !!CSS.supports &&
    CSS.supports("selector(:has(a))");
  const TOOL_ZONE = HAS_SELECTOR
    ? '[data-slot="collapsible"]:has(' + TOOL_MARK + ")"
    : TOOL_MARK;
  function isToolZone(el) {
    if (!el.closest) return false;
    return !!el.closest(TOOL_MARK) || !!el.closest(TOOL_ZONE);
  }
  // One pass per process(): pin zone roots LTR/left and chrome rows hard LTR.
  function fixToolBlocks(root) {
    root = root || document;
    root.querySelectorAll(TOOL_ZONE).forEach((zone) => {
      force(zone, "zone");
    });
    root.querySelectorAll(TOOL_MARK).forEach((m) => force(m, "ltr"));
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
  function tableForce(el, container) {
    container = container || closestTable(el);
    if (!container) {
      force(el, "ltr");
      return;
    }
    if (container.__zcodeRtlTableRtl === undefined) {
      container.__zcodeRtlTableRtl = isRtlDominant(container.textContent || "");
    }
    force(el, container.__zcodeRtlTableRtl ? "table" : "ltrtable");
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
      force(t, "fit");
      t.querySelectorAll("td,th").forEach((c) => {
        force(c, "cell");
      });
      // The wrappers around the table keep native LTR so nothing re-flips.
      let anc = t.parentElement,
        depth = 0;
      while (anc && depth < 6) {
        const s = getComputedStyle(anc);
        const ox = s.overflowX;
        if (ox.indexOf("auto") >= 0 || ox.indexOf("scroll") >= 0) {
          markPaneChain(anc, t);
          force(anc, "pane");
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
      force(el, "pane");
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) processEl(kids[i]);
      return;
    }
    if (isCode(el)) {
      force(el, "ltr");
      return;
    }
    // Tool block zone root: pinned LTR/left so the block never mirrors.
    if (el.matches && el.matches(TOOL_ZONE)) {
      force(el, "zone");
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) processEl(kids[i]);
      return;
    }
    if (el.closest && el.closest(TOOL_MARK)) {
      force(el, "ltr");
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
    const tableScope = closestTable(el);
    const inTable = !isLayout && !!tableScope;
    if (inTable && !hasBlockChild(el)) {
      tableForce(el, tableScope);
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
        force(el, "ltr");
        // Descend anyway: children may still be RTL (a Persian quote in
        // English prose, mixed chat wrappers) and must get their own
        // decision instead of keeping stale styles from an earlier pass.
        // Without this, one Latin-dominant wrapper above the transcript
        // froze every existing message at whatever an older pass had set.
      } else if (tag === "ul" || tag === "ol") {
        // RTL or mixed list: goes RTL so CSS-generated markers/numbers
        // land on the right.
        force(el, "list");
      } else if (tag === "li") {
        force(el, "rtl");
      } else if (!isLayout) {
        // Core rule: RTL by ratio, but never on an element that contains the
        // sidebar (layout wrapper): flipping those reorders the whole app
        // layout.
        if (!containsExcluded(el)) force(el, "rtl");
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
        force(row, "row-end");
      }
      const b = bubbleOf(row);
      if (b) force(b, "pin-right");
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
          // margins only on the row's direct child, direction on all
          force(n, n.parentElement === row ? "edit-box" : "ltr");
          n = n.parentElement;
        }
        force(field, "neutral");
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
        force(row, "row-start");
      }
      const b = bubbleOf(row);
      if (b) force(b, "pin-left");
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
        force(d, "actions");
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
        if (!isExcluded(e)) force(e, "neutral");
      });
    root.querySelectorAll('pre,code,[class*="code" i]').forEach((e) => {
      const t = (e.tagName || "").toLowerCase();
      if (t !== "pre" && t !== "code" && !hasPlainToken(e, /code/i)) return;
      if (!isExcluded(e)) force(e, "ltr");
    });
  }

  function process(root) {
    root = root || document;
    ensureStyle();
    force(root.documentElement || document.documentElement, "ltr");
    force(root.body || document.body, "ltr");
    processMessages(root);
    fixBubbleSides(root);
    fixUserActions(root);
    fixTableScroll(root);
    fixToolBlocks(root);
    // Repair: an earlier pass may have put rtl/right on layout wrappers
    // that contain the sidebar while sitting outside the chat scope. That
    // reorders the app layout and its text-align:right keeps inheriting
    // into the excluded sidebar. Reset those; chat-scoped rtl is legit and
    // untouched.
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
        if (containsExcluded(el)) force(el, "reset");
      });
  }

  // Everything that touches document.body lives in start(), which waits for
  // DOMContentLoaded when injected at document-start via CDP. Repeated
  // injections are safe: process() is idempotent and the observer is
  // guarded by window.__zcodeRtlObserver.
  function start() {
    ensureStyle();
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
  // disabling removes the stylesheet and every data attribute, with no
  // reload.
  const LS_KEY = "zcodeRtl:enabled";
  function rtlEnabled() {
    try {
      return localStorage.getItem(LS_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }
  function stripAll() {
    const tag = document.getElementById(STYLE_ID);
    if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    for (const el of TOUCHED) {
      try {
        el.removeAttribute(ATTR);
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

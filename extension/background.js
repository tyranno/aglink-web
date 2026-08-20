// aglink-web MV3 background service worker.
//
// Dials OUT to the local aglink-web daemon over a WebSocket and executes the
// browser commands it pushes (list_tabs / navigate / get_page_text) via the
// chrome.* APIs. No Native Messaging is involved. The daemon validates our
// chrome-extension:// Origin at the WS handshake, so arbitrary web pages that
// try ws://127.0.0.1 are rejected.
//
// Port: defaults to 48219 (must match the daemon's defaultPort / AGLINK_WEB_PORT).
// A browser extension can't read env vars or the daemon's port file, so if you
// override AGLINK_WEB_PORT, set the matching port once in the extension's options
// (chrome://extensions → aglink-web → Details → Extension options). It's stored
// in chrome.storage.local and applied on the next (re)connect.

const DEFAULT_PORT = 48219;
const DEFAULT_MAX_CHARS = 20000;

let ws = null;
let connecting = false; // guards the async gap between the connect guard and socket creation
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30000;

// currentPort reads the configured daemon port from chrome.storage.local,
// falling back to DEFAULT_PORT when unset or invalid.
async function currentPort() {
  try {
    const { port } = await chrome.storage.local.get("port");
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  } catch (e) {
    return DEFAULT_PORT;
  }
}

async function connect() {
  // Idempotent: never open a second socket while one is connecting/open.
  // onInstalled, onStartup, the keepalive alarm, storage changes, and the initial
  // load all call connect(); without this guard they would race into several
  // sockets that the daemon's "newest wins" then churns. `connecting` extends the
  // guard across the async gap while we read the port from storage.
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  connecting = true;

  const port = await currentPort();
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;
  connecting = false;

  socket.onopen = () => {
    console.log("aglink-web: connected to daemon");
    backoffMs = 1000;
  };

  socket.onmessage = async (event) => {
    let req;
    try {
      req = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    // Keepalive ping from the daemon (id 0): reply so the daemon can refresh its
    // read deadline, and — because sending/receiving a WS message resets the MV3
    // service-worker idle timer — this exchange keeps this worker alive.
    if (req.method === "__ping") {
      send(socket, { id: req.id, ok: true });
      return;
    }
    const reply = { id: req.id, ok: false };
    try {
      reply.text = await dispatch(req.method, req.params || {});
      reply.ok = true;
    } catch (e) {
      reply.error = String(e && e.message ? e.message : e);
    }
    send(socket, reply);
  };

  socket.onclose = () => {
    // Only react to the socket we currently own; a superseded older socket
    // closing must not trigger a reconnect loop.
    if (ws === socket) {
      ws = null;
      scheduleReconnect();
    }
  };

  socket.onerror = () => {
    // onclose fires next and drives reconnection.
  };
}

function send(socket, obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

// ---- command handlers -------------------------------------------------------

async function dispatch(method, params) {
  switch (method) {
    case "list_tabs":
      return await listTabs();
    case "navigate":
      return await navigate(params);
    case "get_page_text":
      return await getPageText(params);
    case "element_exists":
      return await elementExists(params);
    case "click":
      return await click(params);
    case "double_click":
      return await doubleClick(params);
    case "hover":
      return await hover(params);
    case "drag":
      return await drag(params);
    case "get_html":
      return await getHtml(params);
    case "query_all":
      return await queryAll(params);
    case "eval":
      return await evalExpression(params);
    case "get_attribute":
      return await getAttribute(params);
    case "list_elements":
      return await listElements(params);
    case "wait_for_element":
      return await waitForElement(params);
    case "screenshot":
      return await screenshot(params);
    case "type":
      return await typeText(params);
    case "get_value":
      return await getValue(params);
    case "key":
      return await keyCombo(params);
    case "scroll":
      return await scroll(params);
    case "select_option":
      return await selectOption(params);
    case "activate_tab":
      return await activateTab(params);
    case "get_console_logs":
      return await getConsoleLogs(params);
    case "get_network_requests":
      return await getNetworkRequests(params);
    case "reload_extension":
      return await reloadExtension();
    case "close_tab":
      return await closeTab(params);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// ensureHelpers injects the shared ISOLATED-world resolver (aglink-inject.js)
// into a tab right before a selector-based action runs, so every command shares
// one shadow-DOM-piercing + semantic-locator engine (see aglink-inject.js).
// It runs in the same isolated world as the action func executeScript issues
// next, so that func can call globalThis.__aglink.resolve(...). Idempotent —
// re-injecting just re-defines the global. Injection failures (e.g. a
// chrome:// page that forbids scripting) are swallowed: the action func falls
// back to document.querySelector, preserving the old behavior.
async function ensureHelpers(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["aglink-inject.js"],
    });
  } catch (e) {
    // Non-fatal — see comment above.
  }
}

// activeTabId returns params.tabId or the active tab of the focused window,
// the default-target resolution every selector command shares.
async function activeTabId(params) {
  if (params.tabId) return params.tabId;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("no active tab");
  return active.id;
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  if (tabs.length === 0) return "(no open tabs)";
  return tabs
    .map((t) => `${t.id} | ${t.active ? "[active] " : ""}${t.title || ""} | ${t.url || ""}`)
    .join("\n");
}

async function navigate(params) {
  const url = params.url;
  if (!url) throw new Error("navigate requires 'url'");
  let tab;
  if (params.tabId) {
    tab = await chrome.tabs.update(params.tabId, { url });
  } else {
    tab = await chrome.tabs.create({ url });
  }
  await waitForComplete(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return `ok: navigated tab ${updated.id} — ${updated.title || ""} — ${updated.url || ""}`;
}

async function getPageText(params) {
  const tabId = await activeTabId(params);
  const maxChars = params.maxChars || DEFAULT_MAX_CHARS;
  const selector = params.selector || null;
  // int-only params (see command.go): cursor>0 = incremental; offset<0 = tail.
  const hasCursor = Number.isFinite(params.cursor) && params.cursor > 0;
  const cursor = hasCursor ? Math.floor(params.cursor) : -1;
  const offset = Number.isFinite(params.offset) ? Math.floor(params.offset) : 0;

  if (selector) await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      let el;
      if (sel) {
        el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
        if (!el) return { found: false };
      } else {
        el = document.body;
      }
      return { found: true, text: el ? (el.innerText || "") : "" };
    },
    args: [selector],
  });
  const r = results && results[0] && results[0].result;
  if (selector && (!r || !r.found)) throw new Error(`no element matched selector: ${selector}`);
  const full = (r && r.text) || "";
  const total = full.length;

  // Incremental (cursor) mode: return only what was appended since `cursor`.
  if (hasCursor) {
    if (cursor <= total) {
      let delta = full.slice(cursor);
      let note = `new:${delta.length}`;
      if (delta.length > maxChars) { delta = delta.slice(-maxChars); note += ` truncated-to-last:${maxChars}`; }
      const body = delta.length ? delta : "(no new text since cursor)";
      return `${body}\n[cursor:${total} ${note}]`;
    }
    // The text is now shorter than the cursor — it changed/reset (e.g. a new
    // conversation loaded). Resync by returning a tail and a fresh cursor.
    const t = total > maxChars ? full.slice(-maxChars) : full;
    return `${t}\n[cursor:${total} reset (content shrank; showing last ${t.length})]`;
  }

  // Windowed read: offset<0 reads from the end (tail); otherwise from `offset`.
  let text, span;
  if (offset < 0) {
    const n = Math.min(-offset, maxChars);
    text = full.slice(-n);
    span = `${Math.max(0, total - n)}..${total}`;
  } else {
    const start = Math.min(offset, total);
    text = full.slice(start, start + maxChars);
    span = `${start}..${start + text.length}`;
  }
  const trunc = text.length < total ? ` (${span} of ${total})` : "";
  return `${text}\n[cursor:${total}${trunc}]`;
}

// elementExists cheaply reports whether a selector matches, with NO page text —
// the low-cost primitive for polling a boolean condition (e.g. "is the app busy",
// keyed off a working/stop indicator's presence) instead of get_page_text/query_all.
async function elementExists(params) {
  const selector = params.selector;
  if (!selector) throw new Error("element_exists requires 'selector'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const all = globalThis.__aglink ? globalThis.__aglink.resolveAll(sel)
                                      : Array.from(document.querySelectorAll(sel));
      let visible = false;
      for (const el of all) {
        const rc = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (rc && rc.width > 0 && rc.height > 0) { visible = true; break; }
      }
      return { exists: all.length > 0, visible, count: all.length };
    },
    args: [selector],
  });
  const r = (results && results[0] && results[0].result) || { exists: false, visible: false, count: 0 };
  return JSON.stringify(r);
}

// click left-clicks by default via the real .click() DOM method (a trusted
// primary-click equivalent — this is why click() has always worked reliably
// against real page click handlers). Right/middle are a different code path:
// there is no .rightClick()/.middleClick() DOM method, so those are
// synthesized as a mousedown+mouseup+(contextmenu|auxclick) sequence, which
// is untrusted. That reaches a page's OWN JS context-menu/middle-click
// handler (most web apps implement custom right-click menus this way) but
// will NOT summon the browser's native right-click context menu — that only
// appears for a real, OS-trusted contextmenu event, same category of
// limitation as keyCombo's dispatched KeyboardEvents.
async function click(params) {
  const selector = params.selector;
  if (!selector) throw new Error("click requires 'selector'");
  const button = (params.button || "left").toLowerCase();
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new Error(`click: unknown button ${JSON.stringify(params.button)} (want left/right/middle)`);
  }
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, btn) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ block: "center", inline: "center" });
      if (btn === "left") {
        el.click();
      } else {
        const rect = el.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: btn === "right" ? 2 : 1,
        };
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent(btn === "right" ? "contextmenu" : "auxclick", opts));
      }
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 80) };
    },
    args: [selector, button],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `ok: ${button}-clicked <${r.tag}>${r.text ? " " + JSON.stringify(r.text) : ""}`;
}

// hover moves the "pointer" onto an element by dispatching the mouseover /
// mouseenter / mousemove sequence most JS hover menus (dropdowns, tooltips,
// nav flyouts) listen for. Like right/middle click and keyCombo, these are
// untrusted (isTrusted:false) synthesized events: a page's OWN JS hover
// handlers fire, but browser-native :hover-only CSS effects that require a real
// OS pointer won't. Covers the common case (JS-driven menus) — the whole reason
// a caller reaches for hover instead of just clicking.
async function hover(params) {
  const selector = params.selector;
  if (!selector) throw new Error("hover requires 'selector'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      el.dispatchEvent(new MouseEvent("pointerover", opts));
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mousemove", opts));
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 80) };
    },
    args: [selector],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `ok: hovered <${r.tag}>${r.text ? " " + JSON.stringify(r.text) : ""}`;
}

// doubleClick fires the full mousedown/mouseup/click ×2 + dblclick sequence a
// page's own JS double-click handlers listen for (renaming a file, opening a
// row, word-select). Same untrusted-event caveat as click's right/middle path:
// JS handlers fire, but a browser-native default double-click action tied to
// trusted input alone won't.
async function doubleClick(params) {
  const selector = params.selector;
  if (!selector) throw new Error("double_click requires 'selector'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      for (let i = 0; i < 2; i++) {
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
      }
      el.dispatchEvent(new MouseEvent("dblclick", { ...opts, detail: 2 }));
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 80) };
    },
    args: [selector],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `ok: double-clicked <${r.tag}>${r.text ? " " + JSON.stringify(r.text) : ""}`;
}

// drag drags a source element onto a target (Playwright dragTo). It fires BOTH
// a pointer sequence (pointerdown/mousemove/pointerup) and the HTML5 DnD
// sequence (dragstart/dragenter/dragover/drop/dragend) sharing one DataTransfer,
// so both JS-driven reorder handlers (sortable lists, kanban boards, which
// usually listen for pointer/mouse events) and native draggable="true" drop
// zones (which need the DnD events + dataTransfer) respond. Untrusted events, so
// JS handlers fire but a browser-native OS drag won't — same category as the
// other synthesized pointer tools.
async function drag(params) {
  const selector = params.selector;
  const target = params.target;
  if (!selector) throw new Error("drag requires 'selector' (the source)");
  if (!target) throw new Error("drag requires 'target' (the destination)");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (srcSel, dstSel) => {
      const resolve = (s) => (globalThis.__aglink ? globalThis.__aglink.resolve(s) : document.querySelector(s));
      const src = resolve(srcSel);
      if (!src) return { found: false, which: "source", sel: srcSel };
      const dst = resolve(dstSel);
      if (!dst) return { found: false, which: "target", sel: dstSel };
      src.scrollIntoView({ block: "center", inline: "center" });
      const sr = src.getBoundingClientRect();
      const dr = dst.getBoundingClientRect();
      const at = (r) => ({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      const sp = at(sr);
      const dp = at(dr);
      const dt = typeof DataTransfer === "function" ? new DataTransfer() : null;
      const mouse = (type, el, p) =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY }));
      const dnd = (type, el, p) => {
        let ev;
        try {
          ev = new DragEvent(type, { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY, dataTransfer: dt });
        } catch (e) {
          // Some engines forbid passing dataTransfer to the constructor; fall
          // back to a MouseEvent with dataTransfer patched on.
          ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY });
          if (dt) try { Object.defineProperty(ev, "dataTransfer", { value: dt }); } catch (e2) {}
        }
        el.dispatchEvent(ev);
      };
      // Pointer/mouse path (JS reorder handlers).
      mouse("pointerdown", src, sp);
      mouse("mousedown", src, sp);
      mouse("mousemove", src, sp);
      mouse("mousemove", dst, dp);
      // HTML5 DnD path (native drop zones).
      dnd("dragstart", src, sp);
      dnd("dragenter", dst, dp);
      dnd("dragover", dst, dp);
      dnd("drop", dst, dp);
      dnd("dragend", src, dp);
      // Release the pointer over the target.
      mouse("mouseup", dst, dp);
      mouse("pointerup", dst, dp);
      return { found: true, srcTag: src.tagName.toLowerCase(), dstTag: dst.tagName.toLowerCase() };
    },
    args: [selector, target],
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error("drag failed");
  if (!r.found) throw new Error(`no element matched ${r.which} selector: ${r.sel}`);
  return `ok: dragged <${r.srcTag}> onto <${r.dstTag}>`;
}

// getAttribute reads a single attribute (or, for name "text", the element's
// visible textContent) off the matched element — the read-side counterpart for
// non-value state get_value can't reach: href on a link, aria-checked/
// aria-expanded/aria-selected state, disabled, class, a data-* attribute. Use
// it to confirm a page's own JS toggled state after an interaction.
async function getAttribute(params) {
  const selector = params.selector;
  const name = params.name;
  if (!selector) throw new Error("get_attribute requires 'selector'");
  if (!name) throw new Error("get_attribute requires 'name' (an attribute name, or 'text' for textContent)");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, attr) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      const tag = el.tagName.toLowerCase();
      if (attr === "text") return { found: true, tag, present: true, value: (el.textContent || "").trim() };
      return { found: true, tag, present: el.hasAttribute(attr), value: el.getAttribute(attr) };
    },
    args: [selector, name],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  if (!r.present) return `${name} = (not present) on <${r.tag}>`;
  return `${name} = ${JSON.stringify(r.value)}`;
}

// getHtml returns raw outerHTML — of the whole document (no selector) or of one
// element's subtree (selector) — for scraping structured markup get_page_text's
// innerText flattens away (tag structure, attributes, hrefs, hidden nodes). The
// read-side counterpart to get_page_text for crawling.
async function getHtml(params) {
  const tabId = await activeTabId(params);
  const maxChars = params.maxChars || DEFAULT_MAX_CHARS;
  const selector = params.selector || null;
  if (selector) await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      let el;
      if (sel) {
        el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
        if (!el) return { found: false };
      } else {
        el = document.documentElement;
      }
      return { found: true, html: el.outerHTML || "" };
    },
    args: [selector],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  let html = r.html || "";
  if (html.length > maxChars) {
    html = html.slice(0, maxChars) + `\n… [truncated at ${maxChars} chars]`;
  }
  return html;
}

// queryAll extracts a field set from EVERY element matching the selector in one
// call — the crawling workhorse. Uses the shared resolveAll (semantic locators +
// shadow piercing, visible-first). With no attrs, links auto-include href so
// `query_all a[href]` harvests a page's links; pass attrs to pull specific
// fields (href, data-*, aria-*), or "text" to force the textContent column.
async function queryAll(params) {
  const selector = params.selector;
  if (!selector) throw new Error("query_all requires 'selector'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const max = params.max || 200;
  const attrs = (params.attrs || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, attrList, maxEls) => {
      const helper = globalThis.__aglink;
      const cands = helper ? helper.resolveAll(sel) : Array.from(document.querySelectorAll(sel));
      const out = [];
      for (const el of cands) {
        if (out.length >= maxEls) break;
        const rec = {
          tag: el.tagName ? el.tagName.toLowerCase() : "",
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
          attrs: [],
        };
        for (const a of attrList) {
          if (a === "text") continue; // text is already its own column
          rec.attrs.push([a, el.getAttribute ? el.getAttribute(a) : null]);
        }
        // With no explicit attrs, surface href for links so link-harvesting works
        // out of the box.
        if (attrList.length === 0 && el.tagName === "A" && el.getAttribute && el.getAttribute("href") != null) {
          rec.attrs.push(["href", el.getAttribute("href")]);
        }
        out.push(rec);
      }
      return out;
    },
    args: [selector, attrs, max],
  });
  const els = (results && results[0] && results[0].result) || [];
  if (els.length === 0) return `(no elements matched selector: ${selector})`;
  return els
    .map((e, i) => {
      const attrStr = e.attrs.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      return `${i} | ${e.tag} | ${JSON.stringify(e.text)}${attrStr ? " | " + attrStr : ""}`;
    })
    .join("\n");
}

// evalExpression runs a JS expression in the page's MAIN world (like
// Playwright's page.evaluate) and returns the JSON-stringified value — the
// escape hatch for extraction the structured tools don't cover (map over nodes,
// read page globals/framework stores, compute a derived value). MAIN world so it
// can see the page's own JS state, not just the DOM. Caveat: a strict page CSP
// without 'unsafe-eval' blocks the in-page eval and this throws — get_html /
// query_all / get_page_text still work there.
async function evalExpression(params) {
  const expression = params.expression;
  if (!expression) throw new Error("eval requires 'expression'");
  const tabId = await activeTabId(params);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (expr) => {
      try {
        // Indirect eval so the expression evaluates in global scope; supports a
        // bare expression or an IIFE.
        const val = (0, eval)(expr);
        let json;
        if (val === undefined) {
          json = "undefined";
        } else {
          try {
            json = JSON.stringify(val, null, 2);
          } catch (e) {
            json = String(val); // circular / non-serializable → coerce to string
          }
          if (json === undefined) json = String(val); // JSON.stringify(fn) === undefined
        }
        return { ok: true, json };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    },
    args: [expression],
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error("eval returned no result (the page may block script injection)");
  if (!r.ok) throw new Error(`eval error: ${r.error}`);
  return r.json;
}

// AGLINK_ID_ATTR marks each element listElements returns with a fresh,
// guaranteed-unique attribute, so the selector it reports for that element
// (e.g. [data-aglink-id="3"]) always matches exactly the element that was
// seen — no CSS-selector guessing against the page's own classes/attributes,
// which is what caused misclicks on pages like Gmail (a generic selector
// meant for one element matching an unrelated one elsewhere on the page).
const AGLINK_ID_ATTR = "data-aglink-id";

// INTERACTIVE_SELECTOR is the set of element kinds listElements considers —
// native interactive tags plus the common ARIA interactive roles.
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=\"hidden\"])",
  "textarea",
  "select",
  "[contenteditable=\"true\"]",
  "[role=\"button\"]",
  "[role=\"link\"]",
  "[role=\"checkbox\"]",
  "[role=\"radio\"]",
  "[role=\"menuitem\"]",
  "[role=\"tab\"]",
  "[role=\"option\"]",
  "[role=\"combobox\"]",
  "[role=\"switch\"]",
  "[onclick]",
].join(",");

// listElements lists currently visible interactive elements in a tab, each
// tagged with a fresh AGLINK_ID_ATTR so the reported selector is guaranteed to
// match only that element. Re-tags from scratch on every call (clearing any
// markers a previous call left) since SPA pages re-render their DOM
// constantly — indices are only valid until the page next changes.
async function listElements(params) {
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const max = params.max || 200;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selectorList, idAttr, maxEls) => {
      // Pierce open shadow roots when the helper is present, so web-component
      // internals (buttons/inputs inside a custom element) are listed too;
      // fall back to the flat top-document scan otherwise.
      const helper = globalThis.__aglink;
      const clearSet = helper ? helper.deepQueryAll(`[${idAttr}]`) : document.querySelectorAll(`[${idAttr}]`);
      clearSet.forEach((el) => el.removeAttribute(idAttr));
      const candidates = helper ? helper.deepQueryAll(selectorList) : Array.from(document.querySelectorAll(selectorList));
      const out = [];
      let idx = 0;
      for (const el of candidates) {
        if (out.length >= maxEls) break;
        const rect = el.getBoundingClientRect();
        // A non-zero rect is enough to mean "rendered": offsetParent is null
        // (misleadingly) for <body>/<html> and for position:fixed elements
        // too, not just display:none — toasts/modals are commonly fixed, so
        // checking it here would silently drop exactly the elements a caller
        // is most likely waiting to interact with.
        if (rect.width <= 0 || rect.height <= 0) continue;
        el.setAttribute(idAttr, String(idx));
        const label = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.value ||
          el.textContent ||
          ""
        ).trim().replace(/\s+/g, " ").slice(0, 60);
        out.push({
          idx,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          type: el.getAttribute("type") || "",
          label,
          disabled: !!el.disabled,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
        idx++;
      }
      return out;
    },
    args: [INTERACTIVE_SELECTOR, AGLINK_ID_ATTR, max],
  });
  const els = (results && results[0] && results[0].result) || [];
  if (els.length === 0) return "(no visible interactive elements found)";
  return els
    .map((e) => {
      const kind = e.role ? `${e.tag}[${e.role}]` : e.tag;
      const typeStr = e.type ? ` type=${e.type}` : "";
      const disabledStr = e.disabled ? " [disabled]" : "";
      return `${e.idx} | ${kind}${typeStr} | "${e.label}" | selector=[${AGLINK_ID_ATTR}="${e.idx}"] | viewport(${e.x},${e.y})${disabledStr}`;
    })
    .join("\n");
}

// waitForElementPollMs is how often waitForElement re-checks the page while
// waiting. A top-level const (not a function default) so tests can shrink it
// via a wrapper if ever needed; kept small since each check is a real
// chrome.scripting.executeScript round trip, not a cheap in-page loop.
const WAIT_FOR_ELEMENT_POLL_MS = 150;

// waitForElement blocks until a selector matches a visible element in the
// tab, instead of the caller polling list_elements/get_page_text by hand —
// useful for SPA content that renders after navigation/a click settles.
async function waitForElement(params) {
  const selector = params.selector;
  if (!selector) throw new Error("wait_for_element requires 'selector'");
  const tabId = await activeTabId(params);
  const timeoutMs = params.timeoutMs || 8000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await ensureHelpers(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        // See listElements' matching comment: offsetParent is null for
        // <body>/<html> and position:fixed elements too, not just
        // display:none, so it must not gate visibility here.
        const visible = rect.width > 0 && rect.height > 0;
        return { found: true, visible, tag: el.tagName.toLowerCase() };
      },
      args: [selector],
    });
    const r = results && results[0] && results[0].result;
    if (r && r.found && r.visible) {
      return `ok: found <${r.tag}> matching ${selector}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for a visible element matching ${selector}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_ELEMENT_POLL_MS));
  }
}

// screenshot captures the visible viewport of a tab as a base64 PNG (no data:
// URL prefix, so the daemon/MCP bridge can pass it straight through as the
// text-result payload — see protocol.go's doc comment on why this stays
// text-based end to end). captureVisibleTab only captures the *active* tab of
// a window, so a non-active tabId is switched to first (mirrors aglink-screen's
// focus_window-before-capture behavior).
async function screenshot(params) {
  let tabId = params.tabId;
  let windowId;
  if (tabId) {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 100)); // let the tab actually paint
    }
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("no active tab");
    windowId = active.windowId;
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

// typeText sets an input/textarea/contenteditable's value and fires input+change
// events so page JS (including React/Vue controlled inputs) picks up the change.
// For plain <input>/<textarea> it goes through the *native* value setter (bypassing
// any framework-overridden instance setter) — the standard trick to make React see
// a programmatic value change: React's onChange reads the DOM value after the
// 'input' event, so as long as the DOM value is actually set via the native setter
// first, the event dispatch below is what triggers it.
async function typeText(params) {
  const selector = params.selector;
  const text = params.text;
  if (!selector) throw new Error("type requires 'selector'");
  if (text === undefined || text === null) throw new Error("type requires 'text'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, value) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(el, value);
        } else {
          el.value = value;
        }
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, tag: el.tagName.toLowerCase() };
    },
    args: [selector, text],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `ok: typed into <${r.tag}>`;
}

// getValue reads an element's CURRENT value/text — the read-side counterpart
// to typeText/selectOption. get_page_text can't see this: an <input>'s value
// isn't part of document.body.innerText, so after a page's own JS rewrites a
// field (autocomplete, a calculated total, client-side validation reformatting
// what was typed) this is the only way to confirm what it actually holds now.
async function getValue(params) {
  const selector = params.selector;
  if (!selector) throw new Error("get_value requires 'selector'");
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      const tag = el.tagName.toLowerCase();
      if (el.isContentEditable) {
        return { found: true, tag, value: el.textContent || "" };
      }
      if ("value" in el) {
        return { found: true, tag, value: el.value };
      }
      return { found: true, tag, value: el.textContent || "" };
    },
    args: [selector],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `${selector} = ${JSON.stringify(r.value)}`;
}

// KEY_SPECS maps a key token to the {key, code, keyCode} triple a
// KeyboardEvent needs. Single characters not listed here are synthesized in
// keyCombo's page-side function instead (see there).
const KEY_SPECS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  return: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  del: { key: "Delete", code: "Delete", keyCode: 46 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let i = 1; i <= 12; i++) {
  KEY_SPECS["f" + i] = { key: "F" + i, code: "F" + i, keyCode: 111 + i };
}

// MOD_PROPS maps a modifier token to the KeyboardEventInit flag it sets.
const MOD_PROPS = {
  ctrl: "ctrlKey",
  control: "ctrlKey",
  alt: "altKey",
  shift: "shiftKey",
  meta: "metaKey",
  cmd: "metaKey",
  win: "metaKey",
  super: "metaKey",
};

// keyCombo dispatches a keydown+keyup pair — e.g. "enter", "ctrl+a", "esc" —
// to document.activeElement *within the page*, scoped to that tab only.
//
// This exists specifically so Tab/Enter/Escape/shortcuts inside a page don't
// have to go through aglink-screen's OS-level key() — which requires the
// browser window to have OS focus and sends the keystroke to whatever the OS
// thinks is focused, i.e. the whole browser, not just the page. That distinction
// is exactly what turned an attempted "close this dropdown" Escape into "close
// the entire Gmail compose window" (a real incident — see feedback memory on
// web selector fragility): Gmail's own global Escape handler caught an
// OS-level Escape meant only for an autocomplete popup.
//
// Caveat: dispatched KeyboardEvents are untrusted (isTrusted: false). Page JS
// keydown/keyup listeners (React, Gmail's own handlers, etc.) fire normally,
// but browser-native default actions tied to trusted input only — e.g. a
// plain <input> submitting its <form> on Enter with no JS handler — will NOT
// happen from this alone. Most modern interactive apps handle these keys in
// JS (which is exactly the case this tool targets), so this covers the
// common case; a bare native form submit may still need clicking the submit
// button instead.
async function keyCombo(params) {
  const combo = params.combo;
  if (!combo) throw new Error("key requires 'combo'");
  let tabId = params.tabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("no active tab");
    tabId = active.id;
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (comboStr, keySpecs, modProps) => {
      const parts = comboStr.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
      if (parts.length === 0) return { ok: false, error: "empty key combo" };
      const mods = {};
      let keyToken = null;
      parts.forEach((p, i) => {
        if (modProps[p] && i !== parts.length - 1) {
          mods[modProps[p]] = true;
        } else {
          keyToken = p;
        }
      });
      if (!keyToken) return { ok: false, error: `no key in combo "${comboStr}"` };
      let spec = keySpecs[keyToken];
      if (!spec && keyToken.length === 1) {
        spec = { key: keyToken, code: "Key" + keyToken.toUpperCase(), keyCode: keyToken.toUpperCase().charCodeAt(0) };
      }
      if (!spec) return { ok: false, error: `unknown key "${keyToken}" in combo "${comboStr}"` };
      const el = document.activeElement || document.body;
      const opts = {
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        which: spec.keyCode,
        bubbles: true,
        cancelable: true,
        ...mods,
      };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      return { ok: true, tag: el.tagName ? el.tagName.toLowerCase() : "document" };
    },
    args: [combo, KEY_SPECS, MOD_PROPS],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.ok) throw new Error((r && r.error) || "key failed");
  return `ok: pressed "${combo}" on <${r.tag}>`;
}

// scroll scrolls the window (or a specific scrollable element, if 'selector'
// is given) by pixel deltas. Note the sign convention is plain DOM scrollBy
// semantics — positive dy scrolls DOWN (content moves up) — the opposite of
// aglink-screen's scroll(), which mimics physical mouse-wheel notches (positive
// dy scrolls UP) since that one drives a real wheel event. This one sets
// scroll position directly via the DOM, so it follows the DOM's own convention
// instead.
async function scroll(params) {
  const dx = params.dx || 0;
  const dy = params.dy || 0;
  if (dx === 0 && dy === 0) throw new Error("scroll requires a non-zero dx or dy");
  const tabId = await activeTabId(params);
  const selector = params.selector || null;
  if (selector) await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, dxPx, dyPx) => {
      const target = sel ? (globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel)) : null;
      if (sel && !target) return { found: false };
      (target || window).scrollBy({ left: dxPx, top: dyPx, behavior: "instant" });
      return { found: true };
    },
    args: [selector, dx, dy],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  return `ok: scrolled dx=${dx} dy=${dy}${selector ? ` on ${selector}` : ""}`;
}

// selectOption sets a native <select>'s value by option value or visible
// label and fires input+change (mirrors typeText's event dispatch, since
// setting .value directly doesn't trigger page JS on its own).
async function selectOption(params) {
  const selector = params.selector;
  const value = params.value;
  const label = params.label;
  if (!selector) throw new Error("select_option requires 'selector'");
  if (value === undefined && label === undefined) {
    throw new Error("select_option requires 'value' or 'label'");
  }
  const tabId = await activeTabId(params);
  await ensureHelpers(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val, lbl) => {
      const el = globalThis.__aglink ? globalThis.__aglink.resolve(sel) : document.querySelector(sel);
      if (!el) return { found: false };
      if (el.tagName !== "SELECT") return { found: true, isSelect: false, tag: el.tagName.toLowerCase() };
      let match = null;
      for (const opt of el.options) {
        if (val !== null && val !== undefined && opt.value === String(val)) {
          match = opt;
          break;
        }
        if (lbl !== null && lbl !== undefined && opt.textContent.trim() === String(lbl)) {
          match = opt;
          break;
        }
      }
      if (!match) return { found: true, isSelect: true, matched: false };
      el.value = match.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, isSelect: true, matched: true, selected: match.textContent.trim() };
    },
    args: [selector, value === undefined ? null : value, label === undefined ? null : label],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.found) throw new Error(`no element matched selector: ${selector}`);
  if (r.isSelect === false) throw new Error(`element <${r.tag}> matched by ${selector} is not a <select>`);
  if (!r.matched) throw new Error(`no <option> matching value=${JSON.stringify(value)} label=${JSON.stringify(label)}`);
  return `ok: selected "${r.selected}"`;
}

// activateTab makes an existing tab the active tab of its window (and brings
// that window to the foreground). Unlike every other command here, tabId is
// NOT optional — "activate the currently active tab" is a no-op, so there's
// no sensible default to fall back to. Added after repeatedly needing to open
// a brand-new tab in this same session just to make an already-open one (a
// chrome://extensions tab, mid-reload) the foreground tab for a screenshot —
// this is the tool that should have been used instead.
async function activateTab(params) {
  const tabId = params.tabId;
  if (!tabId) throw new Error("activate_tab requires 'tabId'");
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return `ok: activated tab ${tabId} — ${tab.title} — ${tab.url}`;
}

// getConsoleLogs reads the buffer console-capture.js maintains on the page's
// own window (MAIN world — see that file's comment for why isolated-world
// scripts can't see it). Useful for web debugging tasks ("did this click
// throw a JS error?") that get_page_text can't answer since console output
// isn't part of the rendered DOM at all.
async function getConsoleLogs(params) {
  let tabId = params.tabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("no active tab");
    tabId = active.id;
  }
  const max = params.max || 50;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (n) => (window.__aglinkConsole || []).slice(-n),
    args: [max],
  });
  const logs = (results && results[0] && results[0].result) || [];
  if (logs.length === 0) return "(no console messages captured)";
  return logs.map((l) => `[${l.level}] ${l.text}`).join("\n");
}

// getNetworkRequests reads the buffer network-capture.js maintains on the
// page's own window (MAIN world — same rationale as getConsoleLogs: an
// isolated-world script has its own separate window and never sees the
// page's own fetch/XHR calls). The primary tool for reverse-engineering a web
// app's own AJAX API — what endpoint a button actually calls, with what
// payload, and what it returns — which get_page_text/get_html/eval can't see
// since it never touches the rendered DOM.
async function getNetworkRequests(params) {
  let tabId = params.tabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("no active tab");
    tabId = active.id;
  }
  const max = params.max || 50;
  const filter = (params.filter || "").toLowerCase();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (n, f) => {
      const all = window.__aglinkNetwork || [];
      const matched = f ? all.filter((e) => (e.url || "").toLowerCase().includes(f)) : all;
      return matched.slice(-n);
    },
    args: [max, filter],
  });
  const entries = (results && results[0] && results[0].result) || [];
  if (entries.length === 0) return "(no network requests captured)";
  return entries
    .map((e, i) => {
      const parts = [`${i} | ${e.type} | ${e.method} ${e.url}`];
      parts.push(e.error ? `ERROR: ${e.error}` : `-> ${e.status} (${e.durationMs}ms)`);
      if (e.requestBody) parts.push(`req=${JSON.stringify(e.requestBody)}`);
      if (e.responseBody) parts.push(`resp=${JSON.stringify(e.responseBody)}`);
      return parts.join(" | ");
    })
    .join("\n");
}

// reloadExtension restarts the extension itself (chrome.runtime.reload()) —
// a dev-workflow convenience added after manually doing the
// navigate-to-chrome://extensions, screenshot, click-reload dance about 8
// times in one session whenever background.js changed. From here on, a
// background.js/manifest.json edit can be picked up with a single call
// instead of that whole sequence. The reload is delayed slightly so this
// function's "ok" response actually reaches the caller over the WebSocket
// before the service worker context is torn down — without the delay the
// reload could win the race and the caller would see a connection-closed
// error instead of a clean acknowledgement (still harmless, just less clean).
// Not useful to an end user driving their own browsing — only relevant when
// actively developing this extension.
async function reloadExtension() {
  setTimeout(() => chrome.runtime.reload(), 150);
  return "ok: reloading extension in 150ms";
}

async function closeTab(params) {
  let tabId = params.tabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("no active tab");
    tabId = active.id;
  }
  await chrome.tabs.remove(tabId);
  return `ok: closed tab ${tabId}`;
}

// waitForComplete resolves when the tab finishes loading, or after a timeout so
// a slow/hung page never blocks the command indefinitely.
//
// A fast page can reach "complete" before onUpdated is even attached, so the
// event alone would be missed and we'd wait out the whole timeout. To catch
// that, after attaching the listener we poll the tab's current status once: if
// it's already "complete", finish immediately. The listener still covers the
// normal (still-loading) case.
function waitForComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, timeoutMs);
    // Guard against the load finishing before the listener was attached.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish();
    }).catch(() => {});
  });
}

// ---- lifecycle --------------------------------------------------------------

// Connect on install and on browser startup, and keep a heartbeat alarm so the
// service worker is periodically revived to re-establish a dropped socket.
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.create("aglink-web-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "aglink-web-keepalive" && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connect();
  }
});

// Reconnect immediately when the port is changed from the options page. Drop the
// current socket first, clearing our reference so its onclose won't schedule a
// competing reconnect (same "superseded socket stays quiet" rule as elsewhere).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.port) return;
  const old = ws;
  ws = null;
  if (old) {
    try {
      old.close();
    } catch (e) {
      // ignore
    }
  }
  backoffMs = 1000;
  connect();
});

// Also connect when this worker first loads.
connect();

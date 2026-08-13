// Lightweight unit tests for the extension's background service worker.
//
// No npm dependencies and no real browser: background.js is loaded into a
// node:vm context with mocked chrome.* / WebSocket globals. Because background.js
// is a plain (non-module) script, its top-level `function`/`async function`
// declarations become properties of the vm context, so tests can call them
// directly (e.g. sb.waitForComplete). Run with: node --test extension/
//
// These cover the browser-side logic that Go tests can't reach: the navigate
// completion guard, the configurable-port resolution, tab-list formatting, and
// command dispatch routing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const DEFAULT_PORT = 48219;

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// deepMerge lets a test override just the chrome.* corners it cares about while
// keeping the rest of the mock intact.
function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = isPlainObject(base[k]) && isPlainObject(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

function makeChrome(overrides = {}) {
  const noop = () => {};
  const base = {
    runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: noop } },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: noop },
    },
    tabs: {
      query: async () => [],
      get: async () => ({ status: "complete" }),
      update: async () => ({}),
      create: async () => ({}),
      remove: async () => {},
      onUpdated: { addListener: noop, removeListener: noop },
    },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  return deepMerge(base, overrides);
}

// loadBackground evaluates background.js in a fresh sandbox and returns it so the
// test can call the worker's functions. Loading also runs connect() once; the
// WebSocket mock makes that a harmless no-op.
function loadBackground(chrome) {
  class FakeWebSocket {
    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
    }
    send() {}
    close() {}
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const sandbox = {
    chrome,
    WebSocket: FakeWebSocket,
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    JSON,
    Number,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

// resolvesFast asserts a promise settles well before its own (large) internal
// timeout — i.e. via real logic, not the fallback timer.
async function resolvesFast(promise, budgetMs = 500) {
  const outcome = await Promise.race([
    promise.then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("hung"), budgetMs)),
  ]);
  assert.strictEqual(outcome, "resolved", "promise did not settle promptly");
}

test("waitForComplete resolves immediately when the tab is already complete", async () => {
  let listenerAttached = false;
  const chrome = makeChrome({
    tabs: {
      get: async () => ({ status: "complete" }),
      onUpdated: { addListener: () => { listenerAttached = true; }, removeListener: () => {} },
    },
  });
  const sb = loadBackground(chrome);
  // Big timeout: if the get-guard didn't work, this would hang until it fires.
  await resolvesFast(sb.waitForComplete(123, 100000));
  assert.ok(listenerAttached, "listener should still be attached for the normal path");
});

test("waitForComplete resolves on the complete event while loading", async () => {
  let listener;
  const chrome = makeChrome({
    tabs: {
      get: async () => ({ status: "loading" }), // guard must NOT resolve on this
      onUpdated: { addListener: (fn) => { listener = fn; }, removeListener: () => {} },
    },
  });
  const sb = loadBackground(chrome);
  const p = sb.waitForComplete(42, 100000);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(typeof listener, "function", "listener should be registered");
  listener(99, { status: "complete" }); // wrong tab id — must be ignored
  listener(42, { status: "loading" }); // wrong status — must be ignored
  listener(42, { status: "complete" }); // the real one
  await resolvesFast(p);
});

test("currentPort falls back to the default for unset or invalid values", async () => {
  const cases = [
    [undefined, DEFAULT_PORT],
    [3000, 3000],
    ["8080", 8080],
    [0, DEFAULT_PORT],
    [-1, DEFAULT_PORT],
    [70000, DEFAULT_PORT],
    ["abc", DEFAULT_PORT],
  ];
  for (const [stored, expected] of cases) {
    const chrome = makeChrome({ storage: { local: { get: async () => ({ port: stored }) } } });
    const sb = loadBackground(chrome);
    assert.strictEqual(await sb.currentPort(), expected, `stored=${JSON.stringify(stored)}`);
  }
});

test("currentPort tolerates a storage failure", async () => {
  const chrome = makeChrome({
    storage: { local: { get: async () => { throw new Error("storage boom"); } } },
  });
  const sb = loadBackground(chrome);
  assert.strictEqual(await sb.currentPort(), DEFAULT_PORT);
});

test("listTabs formats and handles the empty case", async () => {
  const withTabs = loadBackground(
    makeChrome({
      tabs: {
        query: async () => [
          { id: 1, active: true, title: "A", url: "http://a" },
          { id: 2, active: false, title: "B", url: "http://b" },
        ],
      },
    })
  );
  assert.strictEqual(await withTabs.listTabs(), "1 | [active] A | http://a\n2 | B | http://b");

  const empty = loadBackground(makeChrome({ tabs: { query: async () => [] } }));
  assert.strictEqual(await empty.listTabs(), "(no open tabs)");
});

test("dispatch rejects unknown methods", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.dispatch("nope", {}), /unknown method: nope/);
});

test("navigate opens a tab, waits for load, and returns the final tab info", async () => {
  let created = null;
  const chrome = makeChrome({
    tabs: {
      create: async (opts) => { created = opts; return { id: 7 }; },
      get: async () => ({ id: 7, status: "complete", title: "Example", url: "https://example.com/" }),
    },
  });
  const sb = loadBackground(chrome);
  const out = await sb.navigate({ url: "https://example.com" });
  // created is built inside the vm realm, so compare the field, not the object
  // (deepStrictEqual would fail on the cross-realm prototype).
  assert.strictEqual(created.url, "https://example.com");
  assert.strictEqual(out, "ok: navigated tab 7 — Example — https://example.com/");
});

test("navigate requires a url", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.navigate({}), /navigate requires 'url'/);
});

test("click defaults to left and reports the button used", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: {
        executeScript: async () => [{ result: { found: true, tag: "button", text: "Submit" } }],
      },
    })
  );
  assert.strictEqual(await sb.click({ selector: "#go" }), 'ok: left-clicked <button> "Submit"');
});

test("click supports right/middle and rejects an unknown button", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "div", text: "" } }] },
    })
  );
  assert.strictEqual(await sb.click({ selector: "#menu", button: "right" }), "ok: right-clicked <div>");
  assert.strictEqual(await sb.click({ selector: "#menu", button: "MIDDLE" }), "ok: middle-clicked <div>");
  await assert.rejects(
    () => sb.click({ selector: "#menu", button: "double" }),
    /unknown button "double" \(want left\/right\/middle\)/
  );
});

test("hover reports the hovered element", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "a", text: "Menu" } }] },
    })
  );
  assert.strictEqual(await sb.hover({ selector: "role=link[name=Menu]" }), 'ok: hovered <a> "Menu"');
});

test("hover surfaces a missing element", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  await assert.rejects(() => sb.hover({ selector: "#nope" }), /no element matched selector: #nope/);
  await assert.rejects(() => sb.hover({}), /hover requires 'selector'/);
});

test("getAttribute reads an attribute, absence, and requires name", async () => {
  const present = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 2, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "a", present: true, value: "/next" } }] },
    })
  );
  assert.strictEqual(await present.getAttribute({ selector: "a", name: "href" }), 'href = "/next"');

  const absent = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 2, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "button", present: false, value: null } }] },
    })
  );
  assert.strictEqual(
    await absent.getAttribute({ selector: "button", name: "disabled" }),
    "disabled = (not present) on <button>"
  );

  const sb = loadBackground(makeChrome({ tabs: { query: async () => [{ id: 2, active: true }] } }));
  await assert.rejects(() => sb.getAttribute({ selector: "a" }), /get_attribute requires 'name'/);
  await assert.rejects(() => sb.getAttribute({ name: "href" }), /get_attribute requires 'selector'/);
});

test("doubleClick reports the element and needs a selector", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "div", text: "Row 1" } }] },
    })
  );
  assert.strictEqual(await sb.doubleClick({ selector: "#row" }), 'ok: double-clicked <div> "Row 1"');
  await assert.rejects(() => sb.doubleClick({}), /double_click requires 'selector'/);

  const miss = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  await assert.rejects(() => miss.doubleClick({ selector: "#nope" }), /no element matched selector: #nope/);
});

test("drag reports source/target and validates both selectors", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, srcTag: "li", dstTag: "ul" } }] },
    })
  );
  assert.strictEqual(await sb.drag({ selector: "#a", target: "#b" }), "ok: dragged <li> onto <ul>");
  await assert.rejects(() => sb.drag({ target: "#b" }), /drag requires 'selector'/);
  await assert.rejects(() => sb.drag({ selector: "#a" }), /drag requires 'target'/);

  const miss = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false, which: "target", sel: "#b" } }] },
    })
  );
  await assert.rejects(() => miss.drag({ selector: "#a", target: "#b" }), /no element matched target selector: #b/);
});

test("getHtml returns markup and truncates at maxChars", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, html: "<div>hello</div>" } }] },
    })
  );
  assert.strictEqual(await sb.getHtml({ selector: "#x" }), "<div>hello</div>");

  const long = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, html: "abcdefghij" } }] },
    })
  );
  const out = await long.getHtml({ maxChars: 4 });
  assert.ok(out.startsWith("abcd"), "should keep the first maxChars");
  assert.ok(out.includes("truncated at 4 chars"), "should note truncation");

  const miss = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  await assert.rejects(() => miss.getHtml({ selector: "#nope" }), /no element matched selector: #nope/);
});

test("queryAll formats one line per element and needs a selector", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: {
        executeScript: async () => [
          {
            result: [
              { tag: "a", text: "First", attrs: [["href", "/1"]] },
              { tag: "a", text: "Second", attrs: [["href", "/2"]] },
            ],
          },
        ],
      },
    })
  );
  assert.strictEqual(
    await sb.queryAll({ selector: "a[href]" }),
    '0 | a | "First" | href="/1"\n1 | a | "Second" | href="/2"'
  );
  await assert.rejects(() => sb.queryAll({}), /query_all requires 'selector'/);

  const empty = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: [] }] },
    })
  );
  assert.strictEqual(await empty.queryAll({ selector: ".none" }), "(no elements matched selector: .none)");
});

test("evalExpression returns json, surfaces page errors, needs an expression", async () => {
  const ok = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { ok: true, json: "42" } }] },
    })
  );
  assert.strictEqual(await ok.evalExpression({ expression: "40 + 2" }), "42");
  await assert.rejects(() => ok.evalExpression({}), /eval requires 'expression'/);

  const bad = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { ok: false, error: "x is not defined" } }] },
    })
  );
  await assert.rejects(() => bad.evalExpression({ expression: "x" }), /eval error: x is not defined/);
});

test("selector commands inject the shared resolver helper first", async () => {
  const calls = [];
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 7, active: true }] },
      scripting: {
        executeScript: async (opts) => {
          calls.push(opts);
          return [{ result: { found: true, tag: "button", text: "" } }];
        },
      },
    })
  );
  await sb.click({ selector: "role=button" });
  assert.ok(calls.length >= 2, "expected a helper-injection call plus the action call");
  // Compare element-wise: the array is built in the vm realm, so its prototype
  // differs from this realm's Array and deepStrictEqual would reject it.
  assert.ok(
    calls[0].files && calls[0].files.length === 1 && calls[0].files[0] === "aglink-inject.js",
    "first call must inject the resolver file"
  );
  assert.ok(!calls[1].files && typeof calls[1].func === "function", "second call runs the action func");
});

test("listElements formats rows and handles the empty case", async () => {
  const withEls = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 9, active: true }] },
      scripting: {
        executeScript: async () => [
          {
            result: [
              { idx: 0, tag: "button", role: "", type: "", label: "Send", disabled: false, x: 10, y: 20 },
              { idx: 1, tag: "input", role: "combobox", type: "text", label: "", disabled: true, x: 30, y: 40 },
            ],
          },
        ],
      },
    })
  );
  assert.strictEqual(
    await withEls.listElements({}),
    '0 | button | "Send" | selector=[data-aglink-id="0"] | viewport(10,20)\n' +
      '1 | input[combobox] type=text | "" | selector=[data-aglink-id="1"] | viewport(30,40) [disabled]'
  );

  const empty = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 9, active: true }] },
      scripting: { executeScript: async () => [{ result: [] }] },
    })
  );
  assert.strictEqual(await empty.listElements({}), "(no visible interactive elements found)");
});

test("listElements requires an active tab when tabId is omitted", async () => {
  const sb = loadBackground(makeChrome({ tabs: { query: async () => [] } }));
  await assert.rejects(() => sb.listElements({}), /no active tab/);
});

test("getValue reads an input's current value", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 3, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, tag: "input", value: "42500" } }] },
    })
  );
  assert.strictEqual(await sb.getValue({ selector: "#total" }), '#total = "42500"');
});

test("getValue requires a selector and surfaces a missing element", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.getValue({}), /get_value requires 'selector'/);

  const missing = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 3, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  await assert.rejects(() => missing.getValue({ selector: "#nope" }), /no element matched selector: #nope/);
});

test("activateTab requires a tabId and activates the tab + focuses its window", async () => {
  let updatedTabId, updatedTabOpts, focusedWindowId, focusedOpts;
  const sb = loadBackground(
    makeChrome({
      tabs: {
        update: async (id, opts) => {
          updatedTabId = id;
          updatedTabOpts = opts;
          return { id, windowId: 55, title: "Example", url: "https://example.com" };
        },
      },
      windows: { update: async (id, opts) => { focusedWindowId = id; focusedOpts = opts; } },
    })
  );
  const out = await sb.activateTab({ tabId: 7 });
  assert.strictEqual(updatedTabId, 7);
  assert.strictEqual(updatedTabOpts.active, true); // cross-realm object: compare fields, not deepStrictEqual (see navigate test)
  assert.strictEqual(focusedWindowId, 55);
  assert.strictEqual(focusedOpts.focused, true);
  assert.strictEqual(out, "ok: activated tab 7 — Example — https://example.com");

  await assert.rejects(() => sb.activateTab({}), /activate_tab requires 'tabId'/);
});

test("getConsoleLogs formats captured messages and handles the empty case", async () => {
  const withLogs = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 4, active: true }] },
      scripting: {
        executeScript: async () => [
          {
            result: [
              { level: "log", time: 1, text: "hello" },
              { level: "error", time: 2, text: "boom" },
            ],
          },
        ],
      },
    })
  );
  assert.strictEqual(await withLogs.getConsoleLogs({}), "[log] hello\n[error] boom");

  const empty = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 4, active: true }] },
      scripting: { executeScript: async () => [{ result: [] }] },
    })
  );
  assert.strictEqual(await empty.getConsoleLogs({}), "(no console messages captured)");
});

test("getNetworkRequests formats captured requests, applies filter, and handles the empty case", async () => {
  const entries = [
    { type: "fetch", method: "GET", url: "https://example.com/api/list", status: 200, durationMs: 12, responseBody: '{"ok":true}' },
    { type: "xhr", method: "POST", url: "https://example.com/api/approve", status: 500, durationMs: 34, requestBody: '{"id":1}', error: undefined },
  ];
  const withReqs = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 4, active: true }] },
      scripting: { executeScript: async () => [{ result: entries }] },
    })
  );
  assert.strictEqual(
    await withReqs.getNetworkRequests({}),
    '0 | fetch | GET https://example.com/api/list | -> 200 (12ms) | resp="{\\"ok\\":true}"\n' +
      '1 | xhr | POST https://example.com/api/approve | -> 500 (34ms) | req="{\\"id\\":1}"'
  );

  const empty = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 4, active: true }] },
      scripting: { executeScript: async () => [{ result: [] }] },
    })
  );
  assert.strictEqual(await empty.getNetworkRequests({}), "(no network requests captured)");
});

test("keyCombo requires a combo", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.keyCombo({}), /key requires 'combo'/);
});

test("keyCombo reports success from the page-side result", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 5, active: true }] },
      scripting: { executeScript: async () => [{ result: { ok: true, tag: "input" } }] },
    })
  );
  assert.strictEqual(await sb.keyCombo({ combo: "ctrl+a" }), 'ok: pressed "ctrl+a" on <input>');
});

test("keyCombo surfaces a page-side error (e.g. unknown key)", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 5, active: true }] },
      scripting: {
        executeScript: async () => [{ result: { ok: false, error: 'unknown key "zzz" in combo "zzz"' } }],
      },
    })
  );
  await assert.rejects(() => sb.keyCombo({ combo: "zzz" }), /unknown key "zzz"/);
});

test("waitForElement resolves once the element becomes visible", async () => {
  let calls = 0;
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 6, active: true }] },
      scripting: {
        executeScript: async () => {
          calls++;
          if (calls < 2) return [{ result: { found: false } }];
          return [{ result: { found: true, visible: true, tag: "div" } }];
        },
      },
    })
  );
  const out = await sb.waitForElement({ selector: "#late", timeoutMs: 2000 });
  assert.strictEqual(out, "ok: found <div> matching #late");
  assert.ok(calls >= 2, "expected at least 2 polls before success");
});

test("waitForElement times out when the element never appears", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 6, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  const start = Date.now();
  await assert.rejects(
    () => sb.waitForElement({ selector: "#never", timeoutMs: 100 }),
    /timed out after 100ms waiting for a visible element matching #never/
  );
  assert.ok(Date.now() - start < 2000, "should not block far past the timeout");
});

test("waitForElement requires a selector", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.waitForElement({}), /wait_for_element requires 'selector'/);
});

test("scroll requires a non-zero dx or dy", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.scroll({}), /scroll requires a non-zero dx or dy/);
  await assert.rejects(() => sb.scroll({ dx: 0, dy: 0 }), /scroll requires a non-zero dx or dy/);
});

test("scroll reports success and surfaces a missing selector", async () => {
  const ok = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true } }] },
    })
  );
  assert.strictEqual(await ok.scroll({ dy: 100 }), "ok: scrolled dx=0 dy=100");

  const missing = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 1, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: false } }] },
    })
  );
  await assert.rejects(
    () => missing.scroll({ dy: 100, selector: "#nope" }),
    /no element matched selector: #nope/
  );
});

test("selectOption requires a value or label", async () => {
  const sb = loadBackground(makeChrome());
  await assert.rejects(() => sb.selectOption({ selector: "#s" }), /select_option requires 'value' or 'label'/);
});

test("selectOption reports the selected option", async () => {
  const sb = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 2, active: true }] },
      scripting: {
        executeScript: async () => [{ result: { found: true, isSelect: true, matched: true, selected: "Korea" } }],
      },
    })
  );
  assert.strictEqual(await sb.selectOption({ selector: "#country", label: "Korea" }), 'ok: selected "Korea"');
});

test("selectOption rejects a non-<select> element and an unmatched option", async () => {
  const notSelect = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 2, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, isSelect: false, tag: "input" } }] },
    })
  );
  await assert.rejects(
    () => notSelect.selectOption({ selector: "#x", value: "a" }),
    /element <input> matched by #x is not a <select>/
  );

  const noMatch = loadBackground(
    makeChrome({
      tabs: { query: async () => [{ id: 2, active: true }] },
      scripting: { executeScript: async () => [{ result: { found: true, isSelect: true, matched: false } }] },
    })
  );
  await assert.rejects(
    () => noMatch.selectOption({ selector: "#x", value: "zz" }),
    /no <option> matching value="zz"/
  );
});

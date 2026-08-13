// aglink-web shared in-page resolver (ISOLATED world).
//
// Injected via chrome.scripting.executeScript({files:[...]}) right before every
// selector-based command runs, so all of them share ONE element-resolution
// engine instead of each calling a bare document.querySelector. Two capabilities
// this adds over document.querySelector — the Playwright-style "component
// control" gap this closes:
//
//   1. Shadow-DOM piercing. document.querySelector cannot see inside a custom
//      element's (open) shadow root, so any selector targeting a web-component's
//      internals silently returned "no element". deepQueryAll walks open shadow
//      roots too. (Closed roots are unreachable by design — nothing can pierce
//      those.)
//   2. Semantic locators. A selector may be a plain CSS selector (default,
//      shadow-piercing) OR one of these Playwright-like prefixes, which target
//      by ACCESSIBLE role/name/label instead of fragile CSS classes:
//        role=button                     — any element with that ARIA role
//        role=button[name="Save"]        — …whose accessible name matches
//        text=Login                      — visible text contains "Login"
//        text="Login"                    — …equals "Login" exactly
//        label=Email                     — form control labelled "Email"
//        placeholder=Search              — input with that placeholder
//        testid=submit                   — [data-testid=submit] (& -test-id/-test)
//
// Idempotent: re-injecting just re-defines globalThis.__aglink. Everything runs
// in the extension's isolated world, which shares globalThis with the action
// funcs executeScript runs next (same tab+frame+world), so they can call
// __aglink.resolve(...). background.js still falls back to document.querySelector
// if this global is somehow absent.
(function () {
  if (globalThis.__aglink && globalThis.__aglink.__v === 1) return;

  // isVisible mirrors the rendered-check used elsewhere (non-zero rect) plus a
  // computed-style gate, so semantic locators prefer the element a human would
  // actually see when several match.
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const st = view.getComputedStyle(el);
    if (!st) return true;
    if (st.visibility === "hidden" || st.display === "none") return false;
    return true;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // deepQueryAll matches a CSS selector across the document AND every open
  // shadow root, breadth-first so results roughly follow document order.
  function deepQueryAll(css) {
    const out = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.shift();
      let matches = [];
      try {
        matches = root.querySelectorAll(css);
      } catch (e) {
        matches = [];
      }
      for (const m of matches) out.push(m);
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) roots.push(host.shadowRoot);
      }
    }
    return out;
  }

  // deepAll returns every element in the document and all open shadow roots —
  // the candidate set the semantic locators filter down.
  function deepAll() {
    const out = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.shift();
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }

  // roleOf returns an element's explicit ARIA role, or a pragmatic implicit
  // role for the common interactive tags (enough for role= targeting; not a
  // full ARIA-in-HTML implementation).
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : "";
      case "button": return "button";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "input": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return "img";
      case "nav": return "navigation";
      default: return "";
    }
  }

  // accessibleName is a pragmatic accessible-name computation: aria-label,
  // aria-labelledby, an associated <label>, placeholder/value for inputs, then
  // alt/title, falling back to visible text.
  function accessibleName(el) {
    if (!el || !el.getAttribute) return "";
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const doc = el.ownerDocument || document;
      const txt = lb.split(/\s+/)
        .map((id) => { const t = doc.getElementById(id); return t ? t.textContent : ""; })
        .join(" ").trim();
      if (txt) return txt.replace(/\s+/g, " ");
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => l.textContent).join(" ").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea") {
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
      const t = (el.getAttribute("type") || "").toLowerCase();
      if ((t === "submit" || t === "button" || t === "reset") && el.value) return String(el.value).trim();
    }
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return (el.textContent || "").trim().replace(/\s+/g, " ");
  }

  // unquote strips matching surrounding quotes and reports whether the value was
  // quoted (quoted ⇒ exact match, unquoted ⇒ substring match).
  function unquote(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return { text: s.slice(1, -1), exact: true };
    }
    return { text: s, exact: false };
  }

  function matchText(hay, needle, exact) {
    hay = (hay || "").trim().replace(/\s+/g, " ");
    if (exact) return hay === needle;
    return hay.toLowerCase().includes(String(needle).toLowerCase());
  }

  const LOCATOR_KINDS = ["role", "text", "label", "placeholder", "testid"];

  // resolveAll returns every element matching the selector spec, visible ones
  // first (stable within each group). A leading `<kind>=` picks a semantic
  // locator; anything else is a shadow-piercing CSS selector.
  function resolveAll(selector) {
    let cands = [];
    const m = /^([a-zA-Z]+)=([\s\S]+)$/.exec(selector || "");
    const kind = m ? m[1].toLowerCase() : "";
    if (m && LOCATOR_KINDS.includes(kind)) {
      const rest = m[2];
      if (kind === "role") {
        // role=button   or   role=button[name="Save"]  (name is substring; quote for exact)
        const rm = /^\s*([a-zA-Z]+)\s*(?:\[name=([\s\S]+)\])?\s*$/.exec(rest);
        if (rm) {
          const wantRole = rm[1].toLowerCase();
          const nameSpec = rm[2] != null ? unquote(rm[2]) : null;
          cands = deepAll().filter((el) => roleOf(el) === wantRole)
            .filter((el) => !nameSpec || matchText(accessibleName(el), nameSpec.text, nameSpec.exact));
        }
      } else if (kind === "testid") {
        const v = unquote(rest).text;
        const e = cssEscape(v);
        cands = deepQueryAll(`[data-testid="${e}"],[data-test-id="${e}"],[data-test="${e}"]`);
      } else if (kind === "placeholder") {
        const v = unquote(rest);
        cands = deepAll().filter((el) => el.getAttribute && matchText(el.getAttribute("placeholder"), v.text, v.exact));
      } else if (kind === "label") {
        const v = unquote(rest);
        cands = deepAll().filter((el) => {
          const tag = el.tagName ? el.tagName.toLowerCase() : "";
          const interactive = ["input", "textarea", "select", "button", "a"].includes(tag) || (el.getAttribute && el.getAttribute("role"));
          if (!interactive) return false;
          return matchText(accessibleName(el), v.text, v.exact);
        });
      } else if (kind === "text") {
        const v = unquote(rest);
        cands = deepAll().filter((el) => el.textContent && matchText(el.textContent, v.text, v.exact));
        // Every ancestor of a match also matches; prefer the innermost/smallest
        // so text=Save targets the <button>, not <body>.
        cands.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      }
    } else {
      cands = deepQueryAll(selector);
    }
    const vis = [], hid = [];
    for (const el of cands) (isVisible(el) ? vis : hid).push(el);
    return vis.concat(hid);
  }

  function resolve(selector) {
    const all = resolveAll(selector);
    return all.length ? all[0] : null;
  }

  globalThis.__aglink = {
    __v: 1,
    resolve,
    resolveAll,
    deepQueryAll,
    deepAll,
    isVisible,
    roleOf,
    accessibleName,
  };
})();

package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

// This file is the single source of truth for the browser command set. Both the
// MCP server (mcpweb.go) and the `cmd` fast-path (cmd.go) build themselves from
// the `commands` table below, so adding or changing a command touches one place
// on the Go side. The extension's dispatch in extension/background.js is the
// matching JS half — when you add a command here, add its handler there too and
// keep the method name and param names identical.

// argType distinguishes how an argument is parsed from CLI positionals and MCP
// request fields.
type argType int

const (
	argString argType = iota
	argInt
)

// argSpec describes one command argument. The declared order is also the
// positional order for the `cmd` CLI (e.g. `type <selector> <text> [tabId]`).
// The current invariant — relied on by parseCLIArgs — is that every required
// arg is a string and every int arg is optional, so required strings always
// precede optional ints positionally.
type argSpec struct {
	name     string
	typ      argType
	required bool
	desc     string
}

// command is one browser method exposed identically over MCP and the CLI.
type command struct {
	name string
	desc string // MCP tool description
	args []argSpec
	// image marks a command whose MCP result is a base64 PNG returned as an image
	// rather than text (screenshot). The CLI still prints the base64 as text.
	image bool
}

var commands = []command{
	{
		name: "list_tabs",
		desc: "List the open tabs in the user's Chrome browser as 'tabId | [active] title | url' lines. Use a tabId with navigate or get_page_text to target a specific tab.",
	},
	{
		name: "navigate",
		desc: "Navigate a Chrome tab to a URL and wait for it to finish loading. If 'tabId' is given, that tab is used; otherwise a new tab is opened. Returns the final tab's id, title, and url.",
		args: []argSpec{
			{name: "url", typ: argString, required: true, desc: "The URL to open (include scheme, e.g. https://…)."},
			{name: "tabId", typ: argInt, desc: "Optional existing tab id to navigate (from list_tabs). Omit to open a new tab."},
		},
	},
	{
		name: "get_page_text",
		desc: "Extract the visible text (innerText) of a Chrome tab so it can be read/summarized. If 'tabId' is omitted, the active tab of the focused window is used. The reply ALWAYS ends with a '[cursor:N]' line (N = current total text length). To cheaply poll a GROWING page (e.g. a long chat) without re-reading the whole thing each time, pass that N back as 'cursor' on the next call — you then get ONLY the text added since, plus a fresh cursor. 'offset' reads a window from a character position: negative reads from the END (tail), e.g. offset=-5000 returns the last 5000 chars, so you see the newest content without having to keep raising maxChars. 'selector' scopes extraction to a single element (e.g. the conversation container) to exclude sidebars/menus. Output is capped by maxChars.",
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
			{name: "maxChars", typ: argInt, desc: "Optional cap on returned characters (default 20000)."},
			{name: "offset", typ: argInt, desc: "Start character offset. NEGATIVE reads from the END (tail): -5000 = the last 5000 chars (newest content). Default 0 = from the start. Ignored when 'cursor' is set."},
			{name: "cursor", typ: argInt, desc: "Incremental poll: pass the N from a previous reply's '[cursor:N]' line to return ONLY text added since. Cheapest way to watch a growing page — the reply carries a fresh cursor."},
			{name: "selector", typ: argString, desc: "Optional CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=, pierces open Shadow DOM) to scope text to ONE element (e.g. the chat container), excluding the rest of the page. Omit for document.body."},
		},
	},
	{
		name: "element_exists",
		desc: "Cheaply check whether an element matching the selector is present/visible, returning a tiny JSON ({\"exists\":bool,\"visible\":bool,\"count\":N}) with NO page text — the low-cost way to poll a boolean condition (e.g. is a 'Stop'/working spinner showing, meaning the app is busy?) instead of get_page_text or query_all. The selector is a CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=, pierces open Shadow DOM).",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator to test for."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "get_html",
		desc: "Extract the raw HTML markup of a Chrome tab (outerHTML), for scraping/crawling structured content that document.body.innerText flattens away — tag structure, attributes, hrefs, data-* fields, hidden markup. Omit 'selector' for the whole document; give a CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=, pierces open Shadow DOM) to get just that element's subtree (e.g. one result card, a <table>). Long output is truncated. Prefer get_page_text when you only need readable text, query_all to pull the same field from many elements at once.",
		args: []argSpec{
			{name: "selector", typ: argString, desc: "Optional CSS selector or semantic locator for a subtree. Omit for the whole page's HTML."},
			{name: "maxChars", typ: argInt, desc: "Optional cap on returned characters (default 20000)."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "query_all",
		desc: "Scrape MANY elements at once: for every element matching the selector (CSS or semantic locator — pierces open Shadow DOM), return one line with its tag, visible text, and requested attributes. This is the crawling workhorse — pull a whole list of search results, product cards, table rows, or links in a single call instead of looping list_elements/get_attribute per element. With no 'attrs', links auto-include their href (so `query_all a[href]` is a link harvester for building a crawl frontier). Pass 'attrs' as a comma-separated list (e.g. 'href,data-id,aria-label') to pull specific fields; use 'text' in attrs to force the textContent column.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator matching the set of elements to extract."},
			{name: "attrs", typ: argString, desc: "Optional comma-separated attribute names to pull per element (e.g. 'href,data-id'). Omit to just get tag+text (+href for links)."},
			{name: "max", typ: argInt, desc: "Maximum number of elements to return (default 200)."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "eval",
		desc: "Evaluate a JavaScript expression in a Chrome tab's page (MAIN world, like Playwright's page.evaluate) and return the JSON-stringified result — the general escape hatch for crawling/extraction the structured tools don't cover: map over DOM nodes, read page globals (window.__DATA__, framework stores), compute a derived value. Pass either an expression ('document.querySelectorAll(\"h2\").length') or an IIFE ('(()=>{...; return x})()'). Caveat: runs in the page's own JS context, so a strict page Content-Security-Policy without 'unsafe-eval' will block it (throws) — use get_html/query_all/get_page_text on those sites. Non-JSON-serializable results are coerced to a string.",
		args: []argSpec{
			{name: "expression", typ: argString, required: true, desc: "JavaScript expression or IIFE to evaluate in the page. Its value (JSON-stringified) is returned."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "click",
		desc: "Click a DOM element in a Chrome tab. The selector is either a CSS selector (e.g. 'button.submit', '#login', 'a[href=\"/next\"]' — now also pierces open Shadow DOM) OR a semantic locator that targets by accessible role/name/text instead of fragile CSS: role=button, role=button[name=\"Save\"] (name is a substring; quote for exact), text=Login (text=\"Login\" for exact match), label=Email, placeholder=Search, testid=submit. Scrolls the element into view first. 'button' left (default) uses the real .click() method; right/middle synthesize mousedown+mouseup+contextmenu/auxclick instead — these reach a page's own JS context-menu/middle-click handler but will NOT open the browser's native right-click menu (that requires a real OS-trusted event). If 'tabId' is omitted, the active tab of the focused window is used.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=) for the element to click."},
			{name: "button", typ: argString, desc: "Mouse button: left (default), right, or middle."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "double_click",
		desc: "Double-click a DOM element in a Chrome tab, matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=, same as click). Scrolls into view, then fires the full mousedown/mouseup/click ×2 + dblclick sequence a page's own JS double-click handlers listen for (renaming a file, opening a row, selecting a word). Like the other pointer tools these are synthesized (untrusted) events — JS handlers fire, but browser-native default double-click actions tied to trusted input alone won't. If 'tabId' is omitted, the active tab of the focused window is used.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to double-click."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "hover",
		desc: "Hover the pointer over an element in a Chrome tab, matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=, same as click). Dispatches mouseover/mouseenter/mousemove so a page's own JS hover menus (dropdowns, tooltips, nav flyouts) open — use this to reveal a menu before clicking an item inside it. Note: these are synthesized (untrusted) events, so JS hover handlers fire but pure CSS :hover effects needing a real OS pointer won't. If 'tabId' is omitted, the active tab of the focused window is used.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to hover."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "drag",
		desc: "Drag one element onto another in a Chrome tab (Playwright dragTo equivalent) — both matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=). Synthesizes the pointer sequence (pointerdown/mousemove/pointerup) AND the HTML5 drag-and-drop sequence (dragstart/dragenter/dragover/drop/dragend) with a shared DataTransfer, so both JS-driven reorder handlers (sortable lists, kanban) and native draggable=\"true\" drop zones react. These are synthesized (untrusted) events — JS handlers fire but a browser-native OS drag won't. If 'tabId' is omitted, the active tab of the focused window is used.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to drag (the source)."},
			{name: "target", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to drop onto (the destination)."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "list_elements",
		desc: "List currently visible interactive elements (links, buttons, inputs, ARIA controls — now including those inside open Shadow DOM / web components) in a Chrome tab as 'index | tag[role] | \"label\" | selector=... | viewport(x,y)' lines. The reported selector (a freshly-assigned unique attribute) is guaranteed to match exactly that element — use it directly with click/type instead of guessing a CSS selector from the page's own classes/attributes, which can silently match the wrong element on complex pages. Re-call after the page changes: indices are reassigned every call. viewport(x,y) is the element's on-screen center in CSS pixels (informational only — not an absolute screen coordinate usable by aglink-screen).",
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
			{name: "max", typ: argInt, desc: "Maximum number of elements to return (default 200)."},
		},
	},
	{
		name: "wait_for_element",
		desc: "Block until an element matching the selector becomes visible in a Chrome tab, instead of polling list_elements/get_page_text in a manual loop — useful for SPA content that renders after navigation or a click settles. The selector is a CSS selector (pierces open Shadow DOM) or a semantic locator (role=/text=/label=/placeholder=/testid=). Fails with a timeout error after 'timeoutMs' (default 8000) if it never appears.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator to wait for."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
			{name: "timeoutMs", typ: argInt, desc: "Max time to wait in milliseconds (default 8000)."},
		},
	},
	{
		name:  "screenshot",
		desc:  "Capture the visible viewport of a Chrome tab as a PNG image, so it can be looked at directly instead of read as text. Prefer get_page_text for reading content — use this only when the visual layout itself matters (e.g. verifying a rendered page, a chart, a CAPTCHA). If 'tabId' is given and it isn't the active tab of its window, it is switched to first (mirrors aglink-screen's focus-before-capture). If omitted, the active tab of the focused window is used.",
		image: true,
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "type",
		desc: "Type text into an input, textarea, or contenteditable element in a Chrome tab, matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid= — e.g. label=Email or placeholder=Search to target a field by its label). Replaces any existing value. Fires input/change events so JS-controlled forms notice. If 'tabId' is omitted, the active tab of the focused window is used. Pair with click to focus a field first if needed.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the input/textarea/contenteditable element."},
			{name: "text", typ: argString, required: true, desc: "Text to type."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "get_value",
		desc: "Read an element's CURRENT value/text (input/textarea's .value, or textContent for contenteditable), matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=). The read-side counterpart to type/select_option — get_page_text can't see this, since an <input>'s value isn't part of document.body.innerText. Use this to confirm what a field actually holds now after page JS may have rewritten it (autocomplete, a calculated total, reformatting).",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to read."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "get_attribute",
		desc: "Read one attribute of an element in a Chrome tab, matched by CSS selector or semantic locator (role=/text=/label=/placeholder=/testid=). Use name='text' to get the element's visible textContent instead of an attribute. The counterpart to get_value for non-value state get_value can't reach — href on a link, aria-checked/aria-expanded/aria-selected, disabled, class, or any data-* attribute — e.g. to confirm a page's JS toggled a control's state after a click. Returns '<name> = <value>', or '<name> = (not present)' if the attribute is absent.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector or semantic locator for the element to read."},
			{name: "name", typ: argString, required: true, desc: "Attribute name to read (e.g. 'href', 'aria-expanded', 'disabled', 'class', 'data-id'), or 'text' for the element's textContent."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "key",
		desc: "Press a key or key combo — e.g. 'enter', 'esc', 'tab', 'ctrl+a' — scoped to the currently focused element inside a Chrome tab. Prefer this over aglink-screen's OS-level key() for anything happening inside the page: that one requires OS-focusing the browser window and sends the keystroke to the whole browser (e.g. Escape can trigger the browser's own shortcut instead of just dismissing an in-page dropdown), not just the page. Note: dispatched key events are not OS-trusted, so page JS (React, most SPA keyboard handlers) reacts normally, but a bare native action with no JS handler (e.g. a plain form submitting on Enter) may not fire — click the actual button in that case.",
		args: []argSpec{
			{name: "combo", typ: argString, required: true, desc: "Key combo, e.g. 'ctrl+c' or 'enter'."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "scroll",
		desc: "Scroll the page (or a specific scrollable element, if 'selector' is given) by pixel deltas. Sign convention is plain DOM scrollBy: positive dy scrolls DOWN, positive dx scrolls RIGHT — the opposite of aglink-screen's wheel-notch-based scroll(), since this one sets scroll position directly rather than simulating a wheel event.",
		args: []argSpec{
			{name: "selector", typ: argString, desc: "Optional CSS selector of a scrollable element. Omit to scroll the whole page."},
			{name: "dx", typ: argInt, desc: "Horizontal scroll amount in pixels. Positive = right."},
			{name: "dy", typ: argInt, desc: "Vertical scroll amount in pixels. Positive = down."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "select_option",
		desc: "Set a native <select> element's value by option value or visible label, matched by CSS selector. Fires change so page JS notices. Use 'value' when you know the option's value attribute, 'label' to match by its visible text instead.",
		args: []argSpec{
			{name: "selector", typ: argString, required: true, desc: "CSS selector for the <select> element."},
			{name: "value", typ: argString, desc: "Option value to select (matches the <option>'s value attribute)."},
			{name: "label", typ: argString, desc: "Option's visible text to select (used if 'value' is omitted)."},
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
	{
		name: "activate_tab",
		desc: "Make an existing tab the active tab of its window and bring that window to the foreground. Unlike other commands, 'tabId' is required — there's no sensible default (\"activate the active tab\" is a no-op). Use this instead of opening a redundant new tab just to make an already-open one the foreground tab (e.g. before a screenshot).",
		args: []argSpec{
			{name: "tabId", typ: argInt, required: true, desc: "Tab id (from list_tabs) to activate."},
		},
	},
	{
		name: "get_console_logs",
		desc: "Read recent browser console messages (log/warn/error/info/debug, plus uncaught errors and unhandled promise rejections) captured from a tab since it loaded. Useful for web debugging tasks (\"did that click throw a JS error?\") — get_page_text can't see this, since console output isn't part of the rendered DOM.",
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
			{name: "max", typ: argInt, desc: "Maximum number of recent messages to return (default 50)."},
		},
	},
	{
		name: "get_network_requests",
		desc: "Read recent AJAX calls (fetch and XMLHttpRequest) made by the page — method, URL, status, duration, and truncated request/response bodies — captured from a tab since it loaded. The tool for reverse-engineering a web app's own API: what endpoint does clicking a button actually call, with what payload, and what does it return. get_page_text/get_html/eval can't see this, since it never touches the rendered DOM. Binary responses (images, blobs) are recorded without a body preview. Use 'filter' to narrow a busy page down to the one call you care about.",
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
			{name: "max", typ: argInt, desc: "Maximum number of recent requests to return (default 50)."},
			{name: "filter", typ: argString, desc: "Optional case-insensitive substring to filter by URL (e.g. 'approve' or '/api/')."},
		},
	},
	{
		name: "reload_extension",
		desc: "Dev-workflow convenience: reload the aglink-web extension itself (chrome.runtime.reload()) so a background.js/manifest.json edit takes effect, instead of manually navigating to chrome://extensions and clicking reload. Not useful for driving a user's own browsing — only relevant when developing this extension.",
	},
	{
		name: "close_tab",
		desc: "Close a Chrome tab. If 'tabId' is omitted, the active tab of the focused window is closed.",
		args: []argSpec{
			{name: "tabId", typ: argInt, desc: "Optional tab id (from list_tabs). Omit for the active tab."},
		},
	},
}

// lookupCommand finds a command by name.
func lookupCommand(name string) (command, bool) {
	for _, c := range commands {
		if c.name == name {
			return c, true
		}
	}
	return command{}, false
}

// commandNames renders the command list for usage/error messages.
func commandNames() string {
	names := make([]string, len(commands))
	for i, c := range commands {
		names[i] = c.name
	}
	return strings.Join(names, " | ")
}

// cliUsage renders a positional usage hint like "navigate <url> [tabId]".
func (c command) cliUsage() string {
	parts := []string{c.name}
	for _, a := range c.args {
		if a.required {
			parts = append(parts, "<"+a.name+">")
		} else {
			parts = append(parts, "["+a.name+"]")
		}
	}
	return strings.Join(parts, " ")
}

// parseCLIArgs maps positional CLI args (those after the subcommand name) onto a
// params map per the command's argSpec order. Required args must be present;
// optional int args that don't parse as integers are skipped (mirrors the
// original per-command handling). An empty string for an OPTIONAL string arg
// is likewise treated as "not provided" rather than a literal empty value —
// this lets a positional placeholder be skipped to reach a later optional arg
// (e.g. `select_option <selector> "" <label>` to set label without value),
// mirroring the MCP path's own mcpParams, which already omits empty optional
// strings. Getting this wrong once bit select_option: passing "" for value to
// skip to label matched a real <select>'s empty-value placeholder option
// instead of being skipped, silently selecting the wrong option.
func (c command) parseCLIArgs(args []string) (map[string]any, error) {
	params := map[string]any{}
	for i, a := range c.args {
		if i >= len(args) {
			if a.required {
				return nil, fmt.Errorf("usage: aglink-web cmd %s", c.cliUsage())
			}
			continue
		}
		raw := args[i]
		switch a.typ {
		case argInt:
			if n, err := strconv.Atoi(raw); err == nil {
				params[a.name] = n
			} else if a.required {
				return nil, fmt.Errorf("%s: %s must be an integer", c.name, a.name)
			}
		default: // argString
			if a.required || raw != "" {
				params[a.name] = raw
			}
		}
	}
	return params, nil
}

// mcpTool builds the MCP tool definition from the command's arg specs.
func (c command) mcpTool() mcp.Tool {
	opts := []mcp.ToolOption{mcp.WithDescription(c.desc)}
	for _, a := range c.args {
		props := []mcp.PropertyOption{mcp.Description(a.desc)}
		if a.required {
			props = append(props, mcp.Required())
		}
		switch a.typ {
		case argInt:
			opts = append(opts, mcp.WithNumber(a.name, props...))
		default:
			opts = append(opts, mcp.WithString(a.name, props...))
		}
	}
	return mcp.NewTool(c.name, opts...)
}

// mcpParams extracts this command's params from an MCP tool-call request,
// applying the same include-if-present rules the hand-written handlers used
// (optional ints included only when non-zero; optional strings when non-empty).
func (c command) mcpParams(req mcp.CallToolRequest) (map[string]any, error) {
	params := map[string]any{}
	for _, a := range c.args {
		switch a.typ {
		case argInt:
			if v := req.GetInt(a.name, 0); v != 0 {
				params[a.name] = v
			} else if a.required {
				return nil, fmt.Errorf("missing required argument '%s'", a.name)
			}
		default: // argString
			if a.required {
				v, err := req.RequireString(a.name)
				if err != nil {
					return nil, fmt.Errorf("missing required argument '%s'", a.name)
				}
				params[a.name] = v
			} else if v := req.GetString(a.name, ""); v != "" {
				params[a.name] = v
			}
		}
	}
	return params, nil
}

// mcpHandler returns the tool handler: extract params, call the daemon, and
// shape the result (image for screenshot, text otherwise).
func (c command) mcpHandler() func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		params, err := c.mcpParams(req)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		r := callDaemon(c.name, params)
		if c.image {
			if r.Error != "" {
				return mcp.NewToolResultError(r.Error), nil
			}
			return mcp.NewToolResultImage("Screenshot of the Chrome tab.", r.Text, "image/png"), nil
		}
		return toolResult(r), nil
	}
}

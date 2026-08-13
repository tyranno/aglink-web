// Runs in the MAIN world on every page load (same rationale as
// console-capture.js) so it can intercept the page's OWN fetch/XHR calls — an
// isolated-world script has its own separate `window.fetch`/`XMLHttpRequest`
// and would never see the page's requests.
//
// Purely observational: buffers request/response metadata, always forwards
// to the real fetch/XHR afterward, and never blocks, delays, or rewrites a
// request or response. Safe to run unconditionally, same as console-capture.js.
// This is the primary tool for reverse-engineering a page's own AJAX API —
// what endpoint a button click actually calls, with what payload, and what it
// returns.
(function () {
  if (window.__aglinkNetwork) return; // already installed (re-injection guard)
  const MAX_ENTRIES = 200;
  const MAX_BODY_CHARS = 4000;
  const buf = [];
  window.__aglinkNetwork = buf;

  function truncate(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + `… [truncated at ${MAX_BODY_CHARS} chars]` : s;
  }

  function record(entry) {
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) buf.shift();
  }

  // ---- fetch ----
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      const method = (init && init.method) || (input && input.method) || "GET";
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const start = Date.now();
      let requestBody;
      try {
        if (init && init.body !== undefined) {
          requestBody = truncate(typeof init.body === "string" ? init.body : String(init.body));
        }
      } catch (e) {
        requestBody = undefined;
      }
      let requestHeaders;
      try {
        if (init && init.headers) {
          requestHeaders = {};
          const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
          h.forEach((v, k) => (requestHeaders[k] = v));
        }
      } catch (e) {
        requestHeaders = undefined;
      }
      return originalFetch.call(this, input, init).then(
        (response) => {
          try {
            const ct = response.headers.get("content-type") || "";
            const isBinary = /^(image|video|audio|font)\//.test(ct) || ct.includes("octet-stream");
            if (isBinary) {
              record({ type: "fetch", method, url, status: response.status, time: start, durationMs: Date.now() - start, requestHeaders, requestBody });
            } else {
              response
                .clone()
                .text()
                .then((text) => {
                  record({
                    type: "fetch",
                    method,
                    url,
                    status: response.status,
                    time: start,
                    durationMs: Date.now() - start,
                    requestHeaders,
                    requestBody,
                    responseBody: truncate(text),
                  });
                })
                .catch(() => {
                  record({ type: "fetch", method, url, status: response.status, time: start, durationMs: Date.now() - start, requestHeaders, requestBody });
                });
            }
          } catch (e) {
            // never let capture failure break the page's own fetch
          }
          return response;
        },
        (err) => {
          record({ type: "fetch", method, url, error: String(err && err.message ? err.message : err), time: start, durationMs: Date.now() - start, requestHeaders, requestBody });
          throw err;
        }
      );
    };
  }

  // ---- XMLHttpRequest ----
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__aglink = { method, url, headers: {} };
    return OrigOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__aglink) this.__aglink.headers[name] = value;
    return OrigSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__aglink || { method: "GET", url: "", headers: {} };
    meta.start = Date.now();
    try {
      meta.requestBody = body !== undefined ? truncate(typeof body === "string" ? body : String(body)) : undefined;
    } catch (e) {
      meta.requestBody = undefined;
    }
    const onDone = () => {
      try {
        let responseBody;
        try {
          const rt = this.responseType;
          if (rt === "" || rt === "text") {
            responseBody = truncate(this.responseText);
          } else if (rt === "json") {
            responseBody = truncate(JSON.stringify(this.response));
          }
        } catch (e) {
          // binary responseType (blob/arraybuffer/document) — no text preview
        }
        record({
          type: "xhr",
          method: meta.method,
          url: meta.url,
          status: this.status,
          time: meta.start,
          durationMs: Date.now() - meta.start,
          requestHeaders: meta.headers,
          requestBody: meta.requestBody,
          responseBody,
        });
      } catch (e) {
        // never let capture failure break the page's own XHR
      }
    };
    this.addEventListener("loadend", onDone);
    return OrigSend.call(this, body);
  };
})();

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "search-worker.js"), "utf8");

for (const [name, source] of [["index.html", html], ["app.js", app], ["search-worker.js", worker]]) {
  assert.ok(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(source), `${name} must not add HTML injection sinks`);
  assert.ok(!/\beval\s*\(|\bnew\s+Function\b/.test(source), `${name} must not execute generated code`);
}

assert.match(html, /http-equiv="Content-Security-Policy"/);
assert.match(html, /script-src 'self'/);
assert.match(html, /object-src 'none'/);
assert.match(html, /script-src-attr 'none'/);
assert.match(html, /require-trusted-types-for 'script'/);
assert.match(html, /name="referrer" content="no-referrer"/);
assert.ok(
  !/<a\b[^>]*target="_blank"(?![^>]*rel="[^"]*noreferrer)/i.test(html),
  "new-tab links must suppress opener and referrer data"
);

assert.ok(!app.includes("sessionStorage"), "API keys must not be stored in browser session storage");
assert.ok(
  !app.includes("https://opendict.korean.go.kr/api/search"),
  "browser code must not send API keys directly to OpenDict"
);
assert.match(app, /redirect:\s*"error"/);
assert.match(app, /addedThisPage === 0/);
assert.match(app, /OPENDICT_MAX_PAGES/);
assert.match(worker, /validateIncomingMessage/);
assert.match(worker, /MAX_CUSTOM_TEXT_CHARS/);
assert.match(worker, /MAX_PAGE_SIZE/);

console.log("frontend security regression tests passed");

"use strict";

const assert = require("assert");
const logic = require("../app.js");

const dictionary = logic.createDictionary(
  ["\uac00\ub098", "\ub098\ub2e4", "\ub2e4\ub77c", "\ub77c\ub9c8"].join("\n")
);

const starts = logic.searchDictionary(dictionary, {
  query: "\uac00",
  sourceMode: "starts",
  pageSize: 10
});
assert.ok(starts.results.some((entry) => entry.word === "\uac00\ub098"));

const reply = logic.searchDictionary(dictionary, {
  query: "\uac00\ub098",
  sourceMode: "reply",
  pageSize: 10
});
assert.ok(reply.results.some((entry) => entry.word === "\ub098\ub2e4"));

const used = logic.searchDictionary(dictionary, {
  query: "\uac00",
  sourceMode: "starts",
  pageSize: 10,
  usedKeys: ["\ub098\ub2e4"]
});
const usedEntry = used.results.find((entry) => entry.word === "\uac00\ub098");
assert.strictEqual(usedEntry.followerCount, 0);
assert.strictEqual(usedEntry.oneShot, true);

assert.strictEqual(logic.validateSearchQuery("   ").reason, "empty");
assert.strictEqual(logic.validateSearchQuery("!!!123").reason, "invalid");
assert.strictEqual(logic.validateSearchQuery("\u1100\u1161").ok, true);
assert.deepStrictEqual(logic.searchDictionary(dictionary, { query: "!!!" }).results, []);

console.log("search regression tests passed");

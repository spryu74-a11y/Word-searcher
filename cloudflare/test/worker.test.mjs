import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, validateSearchParams } from "../src/worker.js";

test("accepts bounded Korean lookup parameters", () => {
  const result = validateSearchParams(new URLSearchParams("q=값&method=start&start=101&num=20"));
  assert.deepEqual(result, { ok: true, value: { query: "값", method: "start", start: 101, num: 20 } });
});

test("rejects duplicate, unknown, and out-of-range parameters", () => {
  assert.equal(validateSearchParams(new URLSearchParams("q=값&q=값")).ok, false);
  assert.equal(validateSearchParams(new URLSearchParams("q=값&redirect=https://evil.test")).ok, false);
  assert.equal(validateSearchParams(new URLSearchParams("q=값&start=1001")).ok, false);
  assert.equal(validateSearchParams(new URLSearchParams("q=abc")).ok, false);
});

test("rejects cross-origin API requests before any upstream call", async () => {
  let upstreamCalled = false;
  const response = await handleRequest(
    new Request("https://edge.example/api/opendict/search?q=%EA%B0%92", {
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" }
    }),
    {},
    {},
    { fetchImpl: async () => { upstreamCalled = true; } }
  );
  assert.equal(response.status, 403);
  assert.equal(upstreamCalled, false);
});

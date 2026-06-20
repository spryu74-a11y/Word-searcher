"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..");
const WORKER_PATH = path.join(ROOT, "search-worker.js");

function createWorker() {
  const bootstrap = `
    const fs = require("fs");
    const path = require("path");
    const { parentPort } = require("worker_threads");
    const ROOT = ${JSON.stringify(ROOT)};
    const WORKER_PATH = ${JSON.stringify(WORKER_PATH)};
    globalThis.self = globalThis;
    globalThis.location = { href: "file://" + ROOT.replace(/\\\\/g, "/") + "/" };
    console.debug = () => {};
    console.warn = () => {};
    globalThis.postMessage = (message) => parentPort.postMessage(message);
    parentPort.on("message", (message) => globalThis.onmessage && globalThis.onmessage({ data: message }));
    globalThis.fetch = async (url) => {
      const clean = String(url || "").split("?")[0].replace(/^\\.\\//, "");
      const body = await fs.promises.readFile(path.join(ROOT, clean));
      return {
        ok: true,
        status: 200,
        headers: { get() { return "application/json; charset=UTF-8"; } },
        async json() { return JSON.parse(body.toString("utf8")); }
      };
    };
    require(WORKER_PATH);
  `;
  return new Worker(bootstrap, { eval: true });
}

function createClient(worker) {
  let id = 0;
  const pending = new Map();
  worker.on("message", (message) => {
    const request = pending.get(message && message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") request.reject(new Error(message.message));
    else request.resolve(message);
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  return (type, body) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ type, id: requestId, ...(body || {}) });
    });
  };
}

function searchOptions(usedKeys, usedVersion) {
  return {
    query: "\uac12",
    sourceMode: "starts",
    oneShotOnly: false,
    usedKeys,
    usedVersion,
    page: 1,
    pageSize: 50
  };
}

async function main() {
  const worker = createWorker();
  const request = createClient(worker);
  try {
    const built = await request("buildDefault", { extraText: "" });
    assert.strictEqual(built.type, "built");

    const initial = await request("search", { options: searchOptions([], 0) });
    const afterUsed = await request("search", {
      options: searchOptions(["\uac12\ud45c"], 1)
    });
    assert.strictEqual(initial.type, "searchResult");
    assert.strictEqual(afterUsed.type, "searchResult");
    assert.deepStrictEqual(afterUsed.payload.results, initial.payload.results);
    assert.strictEqual(afterUsed.payload.timing.cacheHit, true);

    const valueTable = initial.payload.results.find((entry) => entry.word === "\uac12\ud45c");
    assert.ok(valueTable, "값표 must be returned for 값");
    assert.strictEqual(valueTable.blunder, true);
    assert.ok(valueTable.alternativeOneShotReplyCount >= 1);
    console.log("search worker regression tests passed");
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

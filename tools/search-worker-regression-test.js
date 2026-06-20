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

function searchOptions(query, usedKeys, usedVersion) {
  return {
    query,
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

    const valueSearch = await request("search", { options: searchOptions("\uac12", [], 0) });
    const standardValueSearch = await request("search", { options: searchOptions("\ud45c\uc900\uac12", [], 0) });
    const valueTable = valueSearch.payload.results.find((entry) => entry.word === "\uac12\ud45c");
    const standardValue = standardValueSearch.payload.results.find((entry) => entry.word === "\ud45c\uc900\uac12");
    assert.ok(valueTable, "값표 must be returned for 값");
    assert.strictEqual(valueTable.blunder, true);
    assert.ok(valueTable.alternativeOneShotReplyCount >= 1);
    assert.ok(standardValue && standardValue.alternativeOneShot, "표준값 must be an alternative one-shot");

    const broadUsedSearch = await request("search", {
      options: searchOptions("\ud504", ["\uac12\ud45c"], 1)
    });
    assert.strictEqual(broadUsedSearch.type, "searchResult");
    assert.strictEqual(broadUsedSearch.payload.timing.followerMs, 0);
    assert.ok(broadUsedSearch.payload.elapsedMs < 100, "used-word search must stay responsive");

    const customBuilt = await request("buildDefault", { extraText: "\ub05d\ud7a3\n\ud7a3\uc00d" });
    assert.strictEqual(customBuilt.type, "built");

    const initial = await request("search", { options: searchOptions("\ub05d\ud7a3", [], 0) });
    const afterUsed = await request("search", {
      options: searchOptions("\ub05d\ud7a3", ["\ud7a3\uc00d"], 1)
    });
    const cachedAfterUsed = await request("search", {
      options: searchOptions("\ub05d\ud7a3", ["\ud7a3\uc00d"], 1)
    });
    assert.strictEqual(initial.type, "searchResult");
    assert.strictEqual(afterUsed.type, "searchResult");
    assert.strictEqual(cachedAfterUsed.payload.timing.cacheHit, true);

    const endKitBefore = initial.payload.results.find((entry) => entry.word === "\ub05d\ud7a3");
    const endKitAfter = afterUsed.payload.results.find((entry) => entry.word === "\ub05d\ud7a3");
    assert.ok(endKitBefore && endKitBefore.blunder, "single-reply word must initially be a blunder");
    assert.ok(endKitAfter, "single-reply word must remain visible after its only reply is marked used");
    assert.strictEqual(endKitAfter.followerCount, 0);
    assert.strictEqual(endKitAfter.oneShot, true);
    assert.strictEqual(endKitAfter.blunder, false);

    console.log("search worker regression tests passed");
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

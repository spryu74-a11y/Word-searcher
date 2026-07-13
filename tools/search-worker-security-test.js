"use strict";

const assert = require("assert");
const path = require("path");
const { Worker } = require("worker_threads");

const workerPath = path.resolve(__dirname, "..", "search-worker.js");
const bootstrap = `
  const { parentPort } = require("worker_threads");
  globalThis.self = globalThis;
  globalThis.postMessage = (message) => parentPort.postMessage(message);
  globalThis.fetch = () => { throw new Error("validation test must not fetch"); };
  parentPort.on("message", (message) => globalThis.onmessage({ data: message }));
  require(${JSON.stringify(workerPath)});
`;

function send(worker, message) {
  return new Promise((resolve, reject) => {
    const onMessage = (response) => {
      if (response && response.id === message.id) {
        cleanup();
        resolve(response);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(message);
  });
}

async function main() {
  const worker = new Worker(bootstrap, { eval: true });
  try {
    const oversizedDictionary = await send(worker, {
      type: "buildDefault",
      id: 1,
      extraText: "x".repeat(4 * 1024 * 1024 + 1)
    });
    assert.strictEqual(oversizedDictionary.type, "error");
    assert.match(oversizedDictionary.message, /custom dictionary payload too large/);

    const oversizedUsedKeys = await send(worker, {
      type: "search",
      id: 2,
      options: {
        query: "끝",
        endQuery: "",
        usedKeys: new Array(50001).fill("값표")
      }
    });
    assert.strictEqual(oversizedUsedKeys.type, "error");
    assert.match(oversizedUsedKeys.message, /used-word payload too large/);

    const oversizedCandidates = await send(worker, {
      type: "appendOnlineCandidates",
      id: 3,
      words: new Array(5001).fill("끝힣"),
      lookup: {}
    });
    assert.strictEqual(oversizedCandidates.type, "error");
    assert.match(oversizedCandidates.message, /online candidate payload too large/);
  } finally {
    await worker.terminate();
  }
  console.log("search worker security boundary tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

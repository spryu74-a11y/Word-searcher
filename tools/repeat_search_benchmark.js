"use strict";

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SCENARIOS = [
  { name: "same-200", count: 200, mode: "same" },
  { name: "same-500", count: 500, mode: "same" },
  { name: "same-1000", count: 1000, mode: "same" },
  { name: "random-200", count: 200, mode: "random" },
  { name: "random-500", count: 500, mode: "random" },
  { name: "random-1000", count: 1000, mode: "random" },
  { name: "typing-delete-200", count: 200, mode: "typing-delete", overlap: true },
  { name: "typing-delete-500", count: 500, mode: "typing-delete", overlap: true },
  { name: "typing-delete-1000", count: 1000, mode: "typing-delete", overlap: true }
];
const DEFAULT_KEYWORDS = [
  "가",
  "나",
  "다",
  "라",
  "마",
  "바",
  "사",
  "아",
  "자",
  "차",
  "카",
  "타",
  "파",
  "하",
  "기",
  "리",
  "끝",
  "말",
  "검색",
  "사과",
  "나무",
  "바다"
];
const DEFAULT_QUERY = process.env.SEARCH_BENCH_QUERY_CODEPOINT
  ? String.fromCodePoint(Number.parseInt(process.env.SEARCH_BENCH_QUERY_CODEPOINT, 16))
  : "가";

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 10) / 10;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function createWorker() {
  const workerPath = path.join(ROOT, "search-worker.js");
  const bootstrap = `
    const fs = require("fs");
    const path = require("path");
    const { parentPort } = require("worker_threads");
    const ROOT = ${JSON.stringify(ROOT)};
    const WORKER_PATH = ${JSON.stringify(workerPath)};

    globalThis.self = globalThis;
    globalThis.location = { href: "file://" + ROOT.replace(/\\\\/g, "/") + "/" };
    globalThis.postMessage = (message) => parentPort.postMessage(message);
    parentPort.on("message", (message) => {
      if (typeof globalThis.onmessage === "function") {
        globalThis.onmessage({ data: message });
      }
    });

    function resolveLocalPath(url) {
      const raw = String(url || "");
      const clean = raw.split("?")[0].replace(/^\\.\\//, "");
      return path.join(ROOT, clean);
    }

    globalThis.fetch = async (url) => {
      const filePath = resolveLocalPath(url);
      const body = await fs.promises.readFile(filePath);
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return String(name || "").toLowerCase() === "content-type"
              ? "application/json; charset=UTF-8"
              : "";
          }
        },
        async json() {
          return JSON.parse(body.toString("utf8"));
        },
        async text() {
          return body.toString("utf8");
        }
      };
    };

    require(WORKER_PATH);
  `;
  return new Worker(bootstrap, { eval: true });
}

function buildScenarioQueries(scenario) {
  if (scenario.mode === "same") {
    return Array.from({ length: scenario.count }, () => DEFAULT_QUERY);
  }
  if (scenario.mode === "typing-delete") {
    const pattern = ["가", "가나", "가나다", "가나", "가", ""];
    return Array.from({ length: scenario.count }, (_, index) => pattern[index % pattern.length]);
  }
  return Array.from({ length: scenario.count }, (_, index) => DEFAULT_KEYWORDS[index % DEFAULT_KEYWORDS.length]);
}

function createHarness(worker) {
  let requestSeq = 0;
  let inFlight = 0;
  let canceled = 0;
  let failed = 0;
  let maxInFlight = 0;
  const pending = new Map();

  worker.on("message", (message) => {
    if (!message || !message.id || !pending.has(message.id)) {
      return;
    }
    const current = pending.get(message.id);
    pending.delete(message.id);
    inFlight = Math.max(0, inFlight - 1);
    const receivedAt = performance.now();

    if (message.type === "searchCanceled") {
      canceled += 1;
      current.resolve({ status: "canceled", totalMs: receivedAt - current.startedAt });
      return;
    }
    if (message.type === "error") {
      failed += 1;
      current.resolve({
        status: "failed",
        totalMs: receivedAt - current.startedAt,
        error: message.message || "worker error"
      });
      return;
    }
    if (message.type !== "searchResult") {
      pending.set(message.id, current);
      inFlight += 1;
      return;
    }

    const renderStart = performance.now();
    const resultCount = Array.isArray(message.payload && message.payload.results)
      ? message.payload.results.length
      : 0;
    const renderMs = performance.now() - renderStart;
    current.resolve({
      status: "ok",
      resultCount,
      totalMs: performance.now() - current.startedAt,
      workerMs: Number(message.payload && message.payload.elapsedMs) || 0,
      renderMs,
      timing: message.payload && message.payload.timing
    });
  });

  function search(query, options) {
    const id = ++requestSeq;
    const traceId = `${Date.now().toString(36)}-${id}`;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const startedAt = performance.now();
    const promise = new Promise((resolve) => {
      pending.set(id, { startedAt, resolve });
    });
    worker.postMessage({
      type: "search",
      id,
      traceId,
      options: {
        query,
        sourceMode: (options && options.sourceMode) || "starts",
        oneShotOnly: Boolean(options && options.oneShotOnly),
        bypassCache: process.env.SEARCH_BENCH_BYPASS_CACHE === "1",
        usedKeys: [],
        page: 1,
        pageSize: 50
      }
    });
    return promise;
  }

  return {
    search,
    snapshot() {
      return {
        inFlight,
        maxInFlight,
        pending: pending.size,
        canceled,
        failed,
        memoryMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
      };
    }
  };
}

async function waitForBuild(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker build timeout")), 60000);
    function onMessage(message) {
      if (message && message.type === "built") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        resolve(message);
      }
      if (message && message.type === "error") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        reject(new Error(message.message || "worker build error"));
      }
    }
    worker.on("message", onMessage);
    worker.postMessage({ type: "buildDefault", id: 1, traceId: "build-1", extraText: "" });
  });
}

async function runScenario(worker, scenario) {
  const harness = createHarness(worker);
  const queries = buildScenarioQueries(scenario);
  const samples = [];
  const startedAt = performance.now();

  if (scenario.overlap) {
    const promises = queries.map((query) => harness.search(query));
    samples.push(...(await Promise.all(promises)));
  } else {
    for (const query of queries) {
      samples.push(await harness.search(query));
    }
  }

  const okSamples = samples.filter((sample) => sample.status === "ok");
  const latencies = okSamples.map((sample) => sample.totalMs);
  const workerLatencies = okSamples.map((sample) => sample.workerMs);
  const snapshot = harness.snapshot();
  return {
    name: scenario.name,
    count: scenario.count,
    ok: okSamples.length,
    canceled: samples.filter((sample) => sample.status === "canceled").length,
    failed: samples.filter((sample) => sample.status === "failed").length,
    avgMs: average(latencies),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    workerP95Ms: percentile(workerLatencies, 95),
    totalRunMs: Math.round((performance.now() - startedAt) * 10) / 10,
    maxInFlight: snapshot.maxInFlight,
    finalInFlight: snapshot.inFlight,
    pending: snapshot.pending,
    memoryMb: snapshot.memoryMb
  };
}

async function main() {
  const worker = createWorker();
  try {
    const built = await waitForBuild(worker);
    const stats = built.stats || {};
    console.log(
      JSON.stringify({
        event: "built",
        total: stats.total || 0,
        buildMs: stats.buildMs || 0,
        memoryMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
      })
    );

    const scenarioArg = process.argv[2] || "";
    const scenarios = scenarioArg
      ? DEFAULT_SCENARIOS.filter((scenario) => scenario.name === scenarioArg)
      : DEFAULT_SCENARIOS;
    if (!scenarios.length) {
      throw new Error(`unknown scenario: ${scenarioArg}`);
    }

    for (const scenario of scenarios) {
      const result = await runScenario(worker, scenario);
      console.log(JSON.stringify({ event: "scenario", ...result }));
    }
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

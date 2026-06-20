"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_SAMPLES = Number(process.env.SEARCH_PROFILE_SAMPLES || 50);
const LEGACY_SAMPLES = Number(process.env.SEARCH_LEGACY_SAMPLES || 10);
const SOAK_ITERATIONS = Number(process.env.SEARCH_SOAK_ITERATIONS || 1000);
const P95_LIMIT_MS = Number(process.env.SEARCH_P95_LIMIT_MS || 30);
const MAX_LIMIT_MS = Number(process.env.SEARCH_MAX_LIMIT_MS || 80);
const DEGRADATION_LIMIT = Number(process.env.SEARCH_DEGRADATION_LIMIT || 0.1);
const MEMORY_LIMIT_MB = Number(process.env.SEARCH_MEMORY_LIMIT_MB || 30);
const SLOW_CHARACTER_COUNT = Number(process.env.SEARCH_SLOW_CHARACTER_COUNT || 20);
const VERBOSE = process.env.SEARCH_BENCH_VERBOSE === "1";
const FAST = ["\uc2dc", "\uc0ac", "\uac00", "\uae30"];
const REQUIRED_SLOW = ["\uac12", "\ud2c0"];

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
}

function stats(samples) {
  return {
    avgMs: round(samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(0, ...samples))
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function readSlowCharacters() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "search-index-manifest.json"), "utf8"));
  const ranked = Object.entries(manifest.shards || {})
    .map(([character, detail]) => ({ character, candidates: Number(detail && detail.count) || 0 }))
    .sort((left, right) => right.candidates - left.candidates);
  const selected = [];
  for (const character of REQUIRED_SLOW.concat(ranked.map((entry) => entry.character))) {
    if (!selected.includes(character)) selected.push(character);
    if (selected.length === SLOW_CHARACTER_COUNT) break;
  }
  return selected;
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
    console.debug = () => {};
    console.warn = () => {};
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
      const body = await fs.promises.readFile(resolveLocalPath(url));
      return {
        ok: true,
        status: 200,
        headers: { get() { return "application/json; charset=UTF-8"; } },
        async json() { return JSON.parse(body.toString("utf8")); }
      };
    };
    require(WORKER_PATH);
  `;
  // Validate the generated bootstrap too; --check only validates this file,
  // not the string evaluated by worker_threads.
  new Function(bootstrap);
  return new Worker(bootstrap, { eval: true });
}

function createClient(worker) {
  let sequence = 0;
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
  function request(type, body) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...(body || {}) });
    });
  }
  return {
    build: () => request("buildDefault", { extraText: "" }),
    snapshot: () => request("performanceSnapshot"),
    async search(query, legacyFullSort) {
      const started = performance.now();
      const message = await request("search", {
        traceId: `bench-${sequence}`,
        options: {
          query,
          sourceMode: "starts",
          oneShotOnly: false,
          page: 1,
          pageSize: 50,
          bypassCache: true,
          legacyFullSort: Boolean(legacyFullSort)
        }
      });
      const payload = message.payload || {};
      return {
        wallMs: performance.now() - started,
        workerMs: Number(payload.elapsedMs) || 0,
        candidateCount: Number(payload.timing && payload.timing.candidateCount) || 0,
        resultCount: Number(payload.total) || 0,
        timing: payload.timing || {}
      };
    }
  };
}

async function profileGroup(client, characters, samples, legacyFullSort) {
  const rows = [];
  for (const character of characters) {
    if (VERBOSE) console.error(`warm ${character}`);
    await client.search(character, false); // shard-load warm-up is not query CPU time.
    const runs = [];
    let metadata = null;
    for (let iteration = 0; iteration < samples; iteration += 1) {
      if (VERBOSE) console.error(`sample ${character} ${iteration + 1}/${samples}`);
      const result = await client.search(character, legacyFullSort);
      runs.push(result.workerMs);
      metadata = result;
    }
    rows.push({ character, ...stats(runs), ...metadata });
  }
  return rows;
}

function groupStats(rows) {
  return {
    avgMs: round(rows.reduce((sum, row) => sum + row.avgMs, 0) / Math.max(1, rows.length)),
    p95Ms: round(Math.max(0, ...rows.map((row) => row.p95Ms))),
    maxMs: round(Math.max(0, ...rows.map((row) => row.maxMs)))
  };
}

async function soak(client, characters) {
  const before = await client.snapshot();
  const latencies = [];
  for (let iteration = 0; iteration < SOAK_ITERATIONS; iteration += 1) {
    const result = await client.search(characters[iteration % characters.length], false);
    latencies.push(result.workerMs);
  }
  const after = await client.snapshot();
  const halfway = Math.floor(latencies.length / 2);
  const first = stats(latencies.slice(0, halfway));
  const last = stats(latencies.slice(halfway));
  return {
    first,
    last,
    degradation: first.p95Ms ? (last.p95Ms - first.p95Ms) / first.p95Ms : 0,
    memoryDeltaMb: round((Number(after.heapBytes) - Number(before.heapBytes)) / 1024 / 1024),
    loadedShards: after.loadedShards
  };
}

async function main() {
  const worker = createWorker();
  try {
    const client = createClient(worker);
    const built = await client.build();
    if (VERBOSE) console.error("build complete");
    const slow = readSlowCharacters();
    const legacyFast = await profileGroup(client, FAST, LEGACY_SAMPLES, true);
    const legacySlow = await profileGroup(client, slow, LEGACY_SAMPLES, true);
    const fast = await profileGroup(client, FAST, PROFILE_SAMPLES, false);
    const slowRows = await profileGroup(client, slow, PROFILE_SAMPLES, false);
    const soakResult = await soak(client, slow);
    const report = {
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        samples: PROFILE_SAMPLES,
        soakIterations: SOAK_ITERATIONS,
        dictionaryEntries: Number(built.stats && built.stats.total) || 0
      },
      slowCharacters: slow,
      before: { fast: groupStats(legacyFast), slow: groupStats(legacySlow) },
      after: { fast: groupStats(fast), slow: groupStats(slowRows) },
      profile: { fast, slow: slowRows },
      soak: soakResult
    };
    console.log(JSON.stringify(report, null, 2));
    for (const row of slowRows) {
      assert.ok(row.p95Ms < P95_LIMIT_MS, `${row.character}: p95 ${row.p95Ms}ms >= ${P95_LIMIT_MS}ms`);
      assert.ok(row.maxMs < MAX_LIMIT_MS, `${row.character}: max ${row.maxMs}ms >= ${MAX_LIMIT_MS}ms`);
    }
    assert.ok(soakResult.degradation < DEGRADATION_LIMIT, `soak degradation ${soakResult.degradation}`);
    assert.ok(soakResult.memoryDeltaMb < MEMORY_LIMIT_MB, `memory delta ${soakResult.memoryDeltaMb}MB`);
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

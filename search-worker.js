"use strict";

const INDEX_MANIFEST_URL = "./data/search-index-manifest.json?v=search-index-v2-20260620-r3";
const INDEX_URL = "./data/search-index.json?v=search-index-v2-20260620-r3";
const SHARD_BASE_URL = "./data/search-index-shards/";
const SHARD_VERSION = "search-index-v2-20260620-r3";
const DEFAULT_LIMIT = 100;
const MAX_SEARCH_QUERY_LENGTH = 80;
const ENTRY_WORD = 0;
const ENTRY_READING = 1;
const ENTRY_LANGUAGE = 2;
const ENTRY_FOLLOWER_COUNT = 3;
const ENTRY_ONE_SHOT_REPLY_COUNT = 4;
const ENTRY_ALTERNATIVE_REPLY_COUNT = 5;
const ENTRY_CATEGORY = 6;
const ENTRY_START = 7;
const ENTRY_END = 8;
const ENTRY_ALLOWED_AFTER = 9;
const ENTRY_KEY = 10;
const CATEGORY_CONNECTION = 0;
const CATEGORY_ONE_SHOT = 1;
const CATEGORY_ALTERNATIVE = 2;
const CATEGORY_BLUNDER = 3;
const LARGE_CANDIDATE_SORT_THRESHOLD = 3000;
const COUNTER_WORDS_SKIP_THRESHOLD = 5000;
const MAX_COUNTER_REPLY_WORDS = 12;
const MAX_COUNTER_REPLY_BUCKET_SCAN = 1500;
const SHARD_CACHE_MAX = 160;
const SHARD_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_RESULT_CACHE_MAX = 150;
const SINGLE_CHAR_RESULT_CACHE_MAX = 150;
const TWO_CHAR_RESULT_CACHE_MAX = 200;
const SEARCH_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
const VOWEL_COUNT = 21;
const TRAILING_COUNT = 28;
const SYLLABLE_BLOCK = VOWEL_COUNT * TRAILING_COUNT;
const NIEUN = 2;
const RIEUL = 5;
const IEUNG = 11;
const IOTIZED_VOWELS = new Set([2, 3, 6, 7, 12, 17, 20]);
const EMPTY = Object.freeze([]);
const PREWARM_STARTS = [
  0xac12, 0xd2c0, 0xd504, 0xc2a4, 0xc544, 0xc774, 0xd06c, 0xc720,
  0xb974, 0xbe0c, 0xbbc0, 0xb4dc, 0xd2b8, 0xc624, 0xd750, 0xb290,
  0xadf8, 0xc6b0, 0xc9c0, 0xc2dc, 0xac00, 0xc0ac, 0xae30
].map((codePoint) => String.fromCodePoint(codePoint));
const PREWARM_START_SET = new Set(PREWARM_STARTS);

let indexPromise = null;
let useFullIndex = false;
let shardFiles = Object.create(null);
let shardCandidateCounts = Object.create(null);
let shardPromises = new Map();
let baseEntries = [];
let baseBuckets = Object.create(null);
let baseByKey = new Map();
let baseByLast = new Map();
let basePrefixSorted = false;
let baseStats = null;
let defaultMeta = null;
let customEntries = [];
let customByStart = new Map();
let customByKey = new Map();
let cachedCustomIndices = null;
let runtimeStats = null;
let loadedShardMeta = new Map();
let searchResultCache = new Map();
let singleCharResultCache = new Map();
let twoCharResultCache = new Map();
let runtimeVersion = 0;
let activeSearchController = null;
let latestSearchId = 0;

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "cancelSearch") {
    if (message.id === latestSearchId && activeSearchController) {
      activeSearchController.abort();
    }
    return;
  }
  handleMessage(message);
};

async function handleMessage(message) {
  try {
    if (message.type === "buildDefault") {
      abortActiveSearch();
      await buildRuntime(message.extraText || "");
      self.postMessage({
        type: "built",
        id: message.id,
        stats: runtimeStats,
        defaultMeta
      });
      return;
    }

    if (message.type === "build" || message.type === "append") {
      abortActiveSearch();
      await buildRuntime(message.text || "");
      self.postMessage({
        type: "built",
        id: message.id,
        stats: runtimeStats,
        defaultMeta
      });
      return;
    }

    if (message.type === "appendOnlineCandidates") {
      abortActiveSearch();
      await ensureIndex();
      const selectedWords = appendOnlineCandidateWords(message.words || [], message.lookup || {});
      if (selectedWords.length) {
        clearSearchResultCache();
      }
      self.postMessage({
        type: "onlineAppendResult",
        id: message.id,
        stats: runtimeStats,
        words: selectedWords,
        lookup: message.lookup || {}
      });
      return;
    }

    if (message.type === "performanceSnapshot") {
      if (typeof globalThis.gc === "function") {
        globalThis.gc();
      }
      const heapBytes =
        typeof process !== "undefined" && process.memoryUsage
          ? Number(process.memoryUsage().heapUsed) || 0
          : 0;
      self.postMessage({
        type: "performanceSnapshot",
        id: message.id,
        heapBytes,
        loadedShards: loadedShardMeta.size,
        cacheEntries: searchResultCache.size + singleCharResultCache.size + twoCharResultCache.size
      });
      return;
    }

    if (message.type === "search") {
      latestSearchId = message.id;
      abortActiveSearch();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      activeSearchController = controller;
      const signal = controller && controller.signal;
      const receivedAt = now();
      try {
        await ensureIndex();
        throwIfAborted(signal);
        const payload = await searchDictionary(message.options || {}, {
          id: message.id,
          traceId: message.traceId || "",
          receivedAt,
          signal
        });
        if (message.id !== latestSearchId || isAborted(signal)) {
          self.postMessage({ type: "searchCanceled", id: message.id, traceId: message.traceId || "" });
          return;
        }
        self.postMessage({ type: "searchResult", id: message.id, traceId: message.traceId || "", payload });
      } catch (error) {
        if (isAbortError(error) || isAborted(signal)) {
          self.postMessage({ type: "searchCanceled", id: message.id, traceId: message.traceId || "" });
          return;
        }
        throw error;
      } finally {
        if (activeSearchController === controller) {
          activeSearchController = null;
        }
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message && message.id,
      message: error && error.message ? error.message : String(error)
    });
  }
}

function abortActiveSearch() {
  if (activeSearchController) {
    activeSearchController.abort();
    activeSearchController = null;
  }
}

function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

function throwIfAborted(signal) {
  if (!isAborted(signal)) {
    return;
  }
  throw createAbortError();
}

function createAbortError() {
  const error = new Error("search aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return Boolean(error && error.name === "AbortError");
}

async function ensureIndex() {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_MANIFEST_URL, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("검색 인덱스 manifest를 불러오지 못했습니다");
        }
        return response.json();
      })
      .then((payload) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("검색 인덱스 manifest 구조가 올바르지 않습니다");
        }
        useFullIndex = false;
        shardFiles = Object.create(null);
        shardCandidateCounts = Object.create(null);
        for (const [start, info] of Object.entries(payload.shards || {})) {
          const file = info && typeof info === "object" ? info.file : "";
          if (file) {
            shardFiles[start] = file;
            shardCandidateCounts[start] = Number(info.count) || 0;
          }
        }
        const total = Number(payload.total || (payload.stats && payload.stats.total) || 0);
        baseEntries = [];
        baseEntries.length = total;
        baseBuckets = Object.create(null);
        baseByKey = new Map();
        baseByLast = new Map();
        basePrefixSorted = Number(payload.version) >= 2;
        loadedShardMeta = new Map();
        baseStats = payload.stats || createEmptyStats();
        defaultMeta = payload.meta || null;
        runtimeStats = { ...baseStats, buildMs: 0 };
        return payload;
      })
      .catch((error) => {
        warnWorker("manifest 로딩 실패, 전체 인덱스로 전환합니다", error);
        return loadFullIndex();
      })
      .catch((error) => {
        indexPromise = null;
        throw error;
      });
  }
  return indexPromise;
}

function loadFullIndex() {
  return fetch(INDEX_URL, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) {
        throw new Error("검색 인덱스를 불러오지 못했습니다");
      }
      return response.json();
    })
    .then((payload) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("검색 인덱스 구조가 올바르지 않습니다");
      }
      useFullIndex = true;
      shardFiles = Object.create(null);
      shardCandidateCounts = Object.create(null);
      shardPromises = new Map();
      loadedShardMeta = new Map();
      baseEntries = Array.isArray(payload.entries) ? payload.entries : [];
      baseBuckets =
        payload.byFirstChar && typeof payload.byFirstChar === "object"
          ? payload.byFirstChar
          : payload.buckets && typeof payload.buckets === "object"
            ? payload.buckets
            : Object.create(null);
      baseStats = payload.stats || createEmptyStats();
      defaultMeta = payload.meta || null;
      basePrefixSorted = Number(payload.version) >= 2;
      buildBaseKeyMap();
      buildBaseLastMap(payload.byLastChar);
      runtimeStats = { ...baseStats, buildMs: 0 };
      return payload;
    });
}

async function loadShards(starts, signal) {
  await ensureIndex();
  throwIfAborted(signal);
  if (useFullIndex) {
    return;
  }
  const uniqueStarts = Array.from(new Set((starts || []).filter(Boolean)));
  await Promise.all(
    uniqueStarts.map((start) =>
      loadShard(start, signal).catch((error) => {
        warnWorker(`검색 shard 로딩 실패: ${start}`, error);
      })
    )
  );
  throwIfAborted(signal);
  trimShardCache(uniqueStarts);
}

async function loadShard(start, signal) {
  throwIfAborted(signal);
  if (useFullIndex || baseBuckets[start]) {
    touchShard(start);
    return;
  }

  const file = shardFiles[start];
  if (!file) {
    baseBuckets[start] = EMPTY;
    return;
  }

  if (!shardPromises.has(start)) {
    const request = fetch(`${SHARD_BASE_URL}${file}?v=${SHARD_VERSION}`, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`검색 shard를 불러오지 못했습니다: ${start}`);
        }
        return response.json();
      })
      .then((payload) => {
        const indices = [];
        const rows = payload && Array.isArray(payload.entries) ? payload.entries : [];
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) {
          warnWorker(`검색 shard 구조가 올바르지 않습니다: ${start}`, payload);
        }
        for (const row of rows) {
          if (!Array.isArray(row) || row.length <= ENTRY_CATEGORY + 1) {
            warnWorker(`검색 shard 항목을 무시했습니다: ${start}`, row);
            continue;
          }
          const index = Number(row[0]);
          if (!Number.isFinite(index)) {
            continue;
          }
          const packed = row.slice(1);
          if (!packed[ENTRY_WORD] || !packed[ENTRY_READING]) {
            warnWorker(`검색 shard 필수 필드가 없어 무시했습니다: ${start}`, row);
            continue;
          }
          baseEntries[index] = packed;
          baseByKey.set(entryKeyFromPacked(packed), index);
          addBaseLastIndex(entryEndFromPacked(packed), index);
          indices.push(index);
        }
        baseBuckets[start] = indices;
        rememberLoadedShard(start, indices);
        return indices;
      })
      .catch((err) => {
        shardPromises.delete(start);
        throw err;
      });
    shardPromises.set(start, request);
  }
  await shardPromises.get(start);
  throwIfAborted(signal);
}

function rememberLoadedShard(start, indices) {
  if (!start || !Array.isArray(indices)) {
    return;
  }
  loadedShardMeta.set(start, {
    loadedAt: Date.now(),
    usedAt: Date.now(),
    indices
  });
}

function touchShard(start) {
  const meta = loadedShardMeta.get(start);
  if (meta) {
    meta.usedAt = Date.now();
  }
}

function trimShardCache(protectedStarts) {
  if (useFullIndex || !loadedShardMeta.size) {
    return;
  }
  const protectedSet = new Set([...(protectedStarts || []), ...PREWARM_START_SET]);
  const nowMs = Date.now();
  for (const [start, meta] of loadedShardMeta.entries()) {
    if (protectedSet.has(start)) {
      continue;
    }
    if (!meta || nowMs - meta.usedAt > SHARD_CACHE_TTL_MS) {
      evictShard(start);
    }
  }
  if (loadedShardMeta.size <= SHARD_CACHE_MAX) {
    return;
  }
  const evictable = Array.from(loadedShardMeta.entries())
    .filter(([start]) => !protectedSet.has(start))
    .sort((left, right) => left[1].usedAt - right[1].usedAt);
  for (const [start] of evictable) {
    if (loadedShardMeta.size <= SHARD_CACHE_MAX) {
      break;
    }
    evictShard(start);
  }
}

function evictShard(start) {
  const indices = baseBuckets[start];
  if (Array.isArray(indices)) {
    for (const index of indices) {
      const entry = baseEntries[index];
      if (entry) {
        baseByKey.delete(entryKeyFromPacked(entry));
        removeBaseLastIndex(entryEndFromPacked(entry), index);
        baseEntries[index] = undefined;
      }
    }
  }
  delete baseBuckets[start];
  loadedShardMeta.delete(start);
  shardPromises.delete(start);
}

async function buildRuntime(extraText) {
  const started = now();
  await ensureIndex();
  await loadShards(PREWARM_STARTS);
  clearSearchResultCache();
  runtimeVersion += 1;
  customEntries = [];
  customByStart = new Map();
  customByKey = new Map();
  cachedCustomIndices = null;

  const parsed = parseCustomEntries(extraText);
  for (const entry of parsed.entries) {
    if (customByKey.has(entry.key)) {
      continue;
    }
    const index = baseEntries.length + customEntries.length;
    const packed = [
      entry.word,
      entry.reading,
      entry.language,
      0,
      0,
      0,
      CATEGORY_CONNECTION,
      entry.start,
      entry.end,
      entry.allowedAfter,
      entry.key
    ];
    customEntries.push(packed);
    customByKey.set(entry.key, index);
    const bucket = customByStart.get(entry.start);
    if (bucket) {
      bucket.push(index);
    } else {
      customByStart.set(entry.start, [index]);
    }
  }

  runtimeStats = {
    ...(baseStats || createEmptyStats()),
    total: (baseStats ? baseStats.total : baseEntries.length) + customEntries.length,
    ko: (baseStats ? baseStats.ko : 0) + customEntries.filter((entry) => entry[ENTRY_LANGUAGE] === "k").length,
    en: (baseStats ? baseStats.en : 0) + customEntries.filter((entry) => entry[ENTRY_LANGUAGE] === "e").length,
    oneShot: baseStats ? baseStats.oneShot : 0,
    invalid: (baseStats ? baseStats.invalid : 0) + parsed.invalid,
    custom: customEntries.length,
    buildMs: Math.round(now() - started)
  };
}

function appendOnlineCandidateWords(words, lookup) {
  const parsed = parseCustomEntries(uniqueTextLines(words).join("\n"));
  const selected = [];
  for (const entry of parsed.entries) {
    if (baseByKey.has(entry.key) || customByKey.has(entry.key) || !matchesLookupEntry(entry, lookup)) {
      continue;
    }
    const index = baseEntries.length + customEntries.length;
    const packed = [
      entry.word,
      entry.reading,
      entry.language,
      0,
      0,
      0,
      CATEGORY_CONNECTION,
      entry.start,
      entry.end,
      entry.allowedAfter,
      entry.key
    ];
    customEntries.push(packed);
    customByKey.set(entry.key, index);
    cachedCustomIndices = null;
    const bucket = customByStart.get(entry.start);
    if (bucket) {
      bucket.push(index);
    } else {
      customByStart.set(entry.start, [index]);
    }
    selected.push(entry.word);
  }

  if (selected.length) {
    recalculateCustomEntries();
    runtimeVersion += 1;
    clearSearchResultCache();
  }
  return selected;
}

function recalculateCustomEntries() {
  const options = createSearchOptions({});
  for (let offset = 0; offset < customEntries.length; offset += 1) {
    const index = baseEntries.length + offset;
    const entry = customEntries[offset];
    const followerCount = getAvailableFollowerCount(index, options);
    entry[ENTRY_FOLLOWER_COUNT] = followerCount;
    entry[ENTRY_CATEGORY] = followerCount === 0 ? CATEGORY_ONE_SHOT : CATEGORY_CONNECTION;
  }

  runtimeStats = {
    ...(baseStats || createEmptyStats()),
    total: (baseStats ? baseStats.total : baseEntries.length) + customEntries.length,
    ko: (baseStats ? baseStats.ko : 0) + customEntries.filter((entry) => entry[ENTRY_LANGUAGE] === "k").length,
    en: (baseStats ? baseStats.en : 0) + customEntries.filter((entry) => entry[ENTRY_LANGUAGE] === "e").length,
    oneShot:
      (baseStats ? baseStats.oneShot : 0) +
      customEntries.filter((entry) => entry[ENTRY_CATEGORY] === CATEGORY_ONE_SHOT).length,
    alternativeOneShot: baseStats ? baseStats.alternativeOneShot : 0,
    invalid: baseStats ? baseStats.invalid : 0,
    custom: customEntries.length,
    buildMs: 0
  };
}

function uniqueTextLines(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function matchesLookupEntry(entry, lookup) {
  const exactKey = normalizeKey((lookup && lookup.exactWord) || "");
  if (exactKey && entry.key === exactKey) {
    return true;
  }
  if (!lookup || !Array.isArray(lookup.prefixes) || !lookup.prefixes.length) {
    return true;
  }
  if (lookup.mode === "reply") {
    return lookup.prefixes.includes(entry.start);
  }
  return lookup.prefixes.some((prefix) => entry.reading.startsWith(prefix));
}

function buildBaseKeyMap() {
  baseByKey = new Map();
  for (let index = 0; index < baseEntries.length; index += 1) {
    if (baseEntries[index]) {
      baseByKey.set(entryKey(index), index);
    }
  }
}

function buildBaseLastMap(serializedIndex) {
  baseByLast = new Map();
  if (serializedIndex && typeof serializedIndex === "object") {
    for (const [end, indices] of Object.entries(serializedIndex)) {
      if (Array.isArray(indices)) {
        baseByLast.set(end, indices);
      }
    }
    return;
  }
  for (let index = 0; index < baseEntries.length; index += 1) {
    const entry = baseEntries[index];
    if (entry) {
      addBaseLastIndex(entryEndFromPacked(entry), index);
    }
  }
}

function addBaseLastIndex(end, index) {
  if (!end) {
    return;
  }
  const bucket = baseByLast.get(end);
  if (bucket) {
    bucket.push(index);
  } else {
    baseByLast.set(end, [index]);
  }
}

function removeBaseLastIndex(end, index) {
  const bucket = baseByLast.get(end);
  if (!bucket) {
    return;
  }
  const position = bucket.indexOf(index);
  if (position >= 0) {
    bucket.splice(position, 1);
  }
  if (!bucket.length) {
    baseByLast.delete(end);
  }
}

function createEmptyStats() {
  return {
    total: 0,
    ko: 0,
    en: 0,
    oneShot: 0,
    alternativeOneShot: 0,
    invalid: 0,
    buildMs: 0
  };
}

async function searchDictionary(options, context) {
  options = options && typeof options === "object" ? options : {};
  const signal = context && context.signal;
  const traceId = (context && context.traceId) || "";
  const started = now();
  throwIfAborted(signal);
  const pageSize = Number(options.pageSize || options.limit || DEFAULT_LIMIT);
  const page = Number(options.page || 1);
  const sourceMode = options.sourceMode === "reply" ? "reply" : "starts";
  const parseStarted = now();
  if (!validateSearchQuery(options.query)) {
    const queryInfo = getQueryInfo("", sourceMode);
    return {
      queryInfo,
      ...createEmptyResults(pageSize, page),
      elapsedMs: 0,
      timing: { parseMs: elapsed(parseStarted), shardMs: 0, searchMs: 0, stateMs: 0 }
    };
  }
  const queryInfo = getQueryInfo(options.query, sourceMode);
  const exactWord = normalizeKey(options.query || "");
  const exactReading = queryInfo.reading;
  const parseMs = elapsed(parseStarted);
  const cacheKey = getSearchResultCacheKey(options, queryInfo, sourceMode, pageSize, page);
  const cachedPayload = options.bypassCache ? null : getSearchResultCache(cacheKey, queryInfo.reading);
  if (cachedPayload) {
    const totalMs = elapsed(started);
    const result = {
      ...cachedPayload,
      elapsedMs: totalMs,
      timing: {
      ...(cachedPayload.timing || {}),
      parseMs,
      cacheHit: true,
      totalMs
      }
    };
    logWorkerTrace(traceId, "cache-hit", result.timing, result.total);
    return result;
  }

  if (!queryInfo.reading) {
    return {
      queryInfo,
      ...createEmptyResults(pageSize, page),
      elapsedMs: 0,
      timing: { parseMs, shardMs: 0, searchMs: 0, stateMs: 0 }
    };
  }

  const t0 = now();
  const searchShardStarts = getSearchShardStarts(queryInfo, sourceMode);
  await loadShards(searchShardStarts, signal);
  const shardMs = elapsed(t0);
  throwIfAborted(signal);

  const t1 = now();
  const searchOptions = createSearchOptions(options);
  const candidates =
    sourceMode === "reply"
      ? searchByReply(queryInfo.starts)
      : searchByPrefixes(queryInfo.prefixes);
  const merged = includeExactCandidates(candidates, exactWord, exactReading);

  const collected = options.legacyFullSort
    ? collectResultsLegacy(
        merged,
        Boolean(options.oneShotOnly),
        pageSize,
        page,
        exactWord,
        exactReading
      )
    : collectResults(
    merged,
    Boolean(options.oneShotOnly),
    pageSize,
    page,
    exactWord,
    exactReading,
        searchOptions
      );
  const searchMs = elapsed(t1);
  throwIfAborted(signal);

  const isDynamic = searchOptions.forceDynamic;

  const t2 = now();
  if (isDynamic) {
    const dynamicShardStarts = getAllowedAfterStartsForIndices(collected.visibleIndices);
    await loadShards(Array.from(new Set(searchShardStarts.concat(dynamicShardStarts))), signal);
  }
  const followerMs = elapsed(t2);
  throwIfAborted(signal);

  const t3 = now();
  const visibleStates = collected.visibleIndices.map((index) => getEntryState(index, searchOptions));
  const stateMs = elapsed(t3);

  const counterShardStarts = getCounterShardStarts(visibleStates);
  if (shouldPrefetchCounterShards(counterShardStarts)) {
  loadShards(counterShardStarts).catch((error) => {
    warnWorker("반격 단어 shard 사전 로딩 실패", error);
  });
  }
  // Counter-word expansion can traverse several large reply buckets per row.
  // Classification/counts are already exact; defer only the display-only word
  // list for broad searches so it cannot dominate keystroke latency.
  const skipCounterWords = candidates.length > COUNTER_WORDS_SKIP_THRESHOLD;
  const results = visibleStates.map((state) =>
    createSearchResultEntry(state, searchOptions, skipCounterWords)
  );

  const totalMs = elapsed(started);
  const payload = {
    queryInfo,
    total: collected.total,
    categoryCounts: collected.categoryCounts,
    limit: collected.pageSize,
    page: collected.page,
    pageSize: collected.pageSize,
    pageCount: collected.pageCount,
    results,
    elapsedMs: totalMs,
    timing: {
      parseMs,
      shardMs,
      searchMs,
      followerMs,
      stateMs,
      totalMs,
      cacheHit: false,
      loadedShards: loadedShardMeta.size,
      candidateCount: candidates.length
    }
  };
  if (!options.bypassCache) {
    putSearchResultCache(cacheKey, payload, queryInfo.reading);
  }
  logWorkerTrace(traceId, "search", payload.timing, payload.total);
  return payload;
}

function getSearchResultCacheKey(options, queryInfo, sourceMode, pageSize, page) {
  return [
    runtimeVersion,
    normalizeKey(options.query || ""),
    queryInfo && queryInfo.reading ? queryInfo.reading : "",
    sourceMode,
    options.oneShotOnly ? "1" : "0",
    String(Math.max(0, Math.floor(Number(options.usedVersion)) || 0)),
    String(Math.max(1, Math.floor(Number(page)) || 1)),
    String(Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT))
  ].join("|");
}

function getSearchResultCache(cacheKey, reading) {
  if (!cacheKey) {
    return null;
  }
  const cache = getSearchResultCacheStore(reading);
  const entry = cache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return null;
  }
  cache.delete(cacheKey);
  cache.set(cacheKey, {
    payload: entry.payload,
    expiresAt: entry.expiresAt,
    usedAt: Date.now()
  });
  return entry.payload;
}

function putSearchResultCache(cacheKey, payload, reading) {
  if (!cacheKey || !payload) {
    return;
  }
  const cache = getSearchResultCacheStore(reading);
  cache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + SEARCH_RESULT_CACHE_TTL_MS,
    usedAt: Date.now()
  });
  trimSearchResultCache(cache, getSearchResultCacheLimit(reading));
}

function getSearchResultCacheStore(reading) {
  const length = String(reading || "").length;
  if (length === 1) {
    return singleCharResultCache;
  }
  if (length === 2) {
    return twoCharResultCache;
  }
  return searchResultCache;
}

function getSearchResultCacheLimit(reading) {
  const length = String(reading || "").length;
  if (length === 1) {
    return SINGLE_CHAR_RESULT_CACHE_MAX;
  }
  if (length === 2) {
    return TWO_CHAR_RESULT_CACHE_MAX;
  }
  return SEARCH_RESULT_CACHE_MAX;
}

function trimSearchResultCache(cache, maxSize) {
  const nowMs = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= nowMs) {
      cache.delete(key);
    }
  }
  while (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function clearSearchResultCache() {
  searchResultCache.clear();
  singleCharResultCache.clear();
  twoCharResultCache.clear();
}

function logWorkerTrace(traceId, phase, timing, total) {
  if (!self.__SEARCH_DEBUG__) {
    return;
  }
  if (typeof console === "undefined" || typeof console.debug !== "function") {
    return;
  }
  console.debug("[search-worker-trace]", {
    traceId,
    phase,
    total,
    timing,
    loadedShards: loadedShardMeta.size,
    resultCacheSize: searchResultCache.size
  });
}

function warnWorker(message, details) {
  if (typeof console === "undefined" || typeof console.warn !== "function") {
    return;
  }
  console.warn("[search-worker]", message, details || "");
}

function createSearchOptions(options) {
  const usedKeySet = new Set();
  for (const rawKey of Array.isArray(options && options.usedKeys) ? options.usedKeys : []) {
    const key = normalizeKey(rawKey);
    if (key) {
      usedKeySet.add(key);
    }
  }
  const usedStartCounts = createUsedStartCounts(usedKeySet);
  return {
    usedKeySet,
    hasUsedWords: usedKeySet.size > 0,
    forceDynamic: customEntries.length > 0,
    usedStartCounts,
    stateCache: new Map(),
    followerCache: new Map(),
    oneShotCounterCache: new Map(),
    alternativeOneShotCounterCache: new Map()
  };
}

function createUsedStartCounts(usedKeySet) {
  const counts = new Map();
  if (!usedKeySet || !usedKeySet.size) {
    return counts;
  }
  for (const key of usedKeySet) {
    const index = getIndexByKey(key);
    const start = index >= 0 ? entryStart(index) : toReading(key)[0];
    if (!start) {
      continue;
    }
    counts.set(start, (counts.get(start) || 0) + 1);
  }
  return counts;
}

function getSearchShardStarts(queryInfo, sourceMode) {
  const starts = new Set();
  if (queryInfo && queryInfo.reading) {
    starts.add(queryInfo.reading[0]);
  }
  if (sourceMode === "reply") {
    for (const start of queryInfo.starts || []) {
      starts.add(start);
    }
  } else {
    for (const prefix of queryInfo.prefixes || []) {
      if (prefix) {
        starts.add(prefix[0]);
      }
    }
  }
  return Array.from(starts);
}

function getAllowedAfterStartsForIndices(indices) {
  const starts = new Set();
  for (const index of indices || []) {
    for (const start of getAllowedAfter(index)) {
      starts.add(start);
    }
  }
  return Array.from(starts);
}

function getCounterShardStarts(states) {
  const starts = new Set();
  for (const state of states || []) {
    if (!state || !state.blunder) {
      continue;
    }
    for (const start of state.allowedAfter || []) {
      starts.add(start);
    }
  }
  return Array.from(starts);
}

function shouldPrefetchCounterShards(starts) {
  return (starts || []).every((start) => getCandidateCountForStart(start) <= MAX_COUNTER_REPLY_BUCKET_SCAN);
}

function getCandidateCountForStart(start) {
  const loaded = baseBuckets[start];
  const customCount = (customByStart.get(start) || EMPTY).length || 0;
  if (Array.isArray(loaded)) {
    return loaded.length + customCount;
  }
  return (Number(shardCandidateCounts[start]) || 0) + customCount;
}

function searchByPrefixes(prefixes) {
  const uniquePrefixes = Array.from(new Set((prefixes || []).filter(Boolean)));
  if (!uniquePrefixes.length) {
    return [];
  }

  if (uniquePrefixes.length === 1) {
    const prefix = uniquePrefixes[0];
    const bucket = getBucket(prefix[0]);
    if (prefix.length === 1) {
      return bucket.slice();
    }
    if (!customEntries.length) {
      return basePrefixSorted
        ? getBasePrefixRange(bucket, prefix)
        : bucket.filter((index) => entryReading(index).startsWith(prefix));
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const prefix of uniquePrefixes) {
    const bucket = getBucket(prefix[0]);
    const baseCandidates = !customEntries.length && prefix.length > 1 && basePrefixSorted
      ? getBasePrefixRange(bucket, prefix)
      : bucket;
    for (const index of baseCandidates) {
      if (seen.has(index)) {
        continue;
      }
      if (prefix.length > 1 && !entryReading(index).startsWith(prefix)) {
        continue;
      }
      seen.add(index);
      candidates.push(index);
    }
    for (const index of getCustomIndices()) {
      if (seen.has(index)) {
        continue;
      }
      if (!entryReading(index).startsWith(prefix)) {
        continue;
      }
      seen.add(index);
      candidates.push(index);
    }
  }
  return candidates;
}

function searchByReply(starts) {
  const candidates = [];
  const seen = new Set();
  for (const start of starts || []) {
    for (const index of getBucket(start)) {
      if (seen.has(index)) {
        continue;
      }
      seen.add(index);
      candidates.push(index);
    }
  }
  return candidates;
}

function getBasePrefixRange(indices, prefix) {
  if (!Array.isArray(indices) || !indices.length || !prefix) {
    return [];
  }
  const first = lowerBoundByReading(indices, prefix);
  const last = lowerBoundByReading(indices, `${prefix}\uffff`);
  return indices.slice(first, last);
}

function lowerBoundByReading(indices, target) {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entryReading(indices[middle]) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function includeExactCandidates(candidates, exactWord, exactReading) {
  const seen = new Set(candidates);
  const merged = candidates.slice();
  const exactIndex = getIndexByKey(exactWord);
  if (exactIndex >= 0 && !seen.has(exactIndex)) {
    seen.add(exactIndex);
    merged.push(exactIndex);
  }
  if (exactReading && exactReading.length > 1) {
    const bucket = getBucket(exactReading[0]);
    const exactCandidates = basePrefixSorted && !customEntries.length
      ? getBasePrefixRange(bucket, exactReading)
      : bucket;
    for (const index of exactCandidates) {
      if (!seen.has(index) && entryReading(index) === exactReading) {
        seen.add(index);
        merged.push(index);
      }
    }
    for (const index of getCustomIndices()) {
      if (!seen.has(index) && entryReading(index) === exactReading) {
        seen.add(index);
        merged.push(index);
      }
    }
  }
  return merged;
}

function collectResults(candidates, oneShotOnly, pageSize, page, exactWord, exactReading, options) {
  if (!options.hasUsedWords && !options.forceDynamic) {
    return collectResultsFast(candidates, oneShotOnly, pageSize, page, exactWord, exactReading, options);
  }

  const oneShotIndices = [];
  const alternativeIndices = [];
  const blunderIndices = [];
  const safeConnectionIndices = [];

  for (const index of candidates) {
    if (options.hasUsedWords && !options.forceDynamic) {
      const followerCount = getAvailableFollowerCount(index, options);
      if (followerCount === 0) {
        oneShotIndices.push(index);
        continue;
      }
      const staticCat = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
      if (staticCat === CATEGORY_ALTERNATIVE) alternativeIndices.push(index);
      else if (staticCat === CATEGORY_BLUNDER) blunderIndices.push(index);
      else safeConnectionIndices.push(index);
    } else {
      const followerCount = getAvailableFollowerCount(index, options);
      if (followerCount === 0) {
        oneShotIndices.push(index);
        continue;
      }
      const replyOptions = createPlayedOptions(options, index);
      if (checkHasOneShotCounter(index, replyOptions) || checkHasAltOneShotCounter(index, replyOptions)) {
        blunderIndices.push(index);
      } else {
        const staticCat = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
        if (staticCat === CATEGORY_ALTERNATIVE) {
          alternativeIndices.push(index);
        } else {
          safeConnectionIndices.push(index);
        }
      }
    }
  }

  return collectCategorizedIndexGroups(
    oneShotIndices,
    alternativeIndices,
    safeConnectionIndices,
    blunderIndices,
    oneShotOnly,
    pageSize,
    page,
    exactWord,
    exactReading,
    options
  );
}

function collectResultsFast(candidates, oneShotOnly, pageSize, page, exactWord, exactReading, options) {
  const oneShotIndices = [];
  const alternativeIndices = [];
  const blunderIndices = [];
  const connectionIndices = [];

  for (const index of candidates) {
    const category = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
    if (category === CATEGORY_ONE_SHOT) {
      oneShotIndices.push(index);
    } else if (category === CATEGORY_ALTERNATIVE) {
      alternativeIndices.push(index);
    } else if (category === CATEGORY_BLUNDER) {
      blunderIndices.push(index);
    } else {
      connectionIndices.push(index);
    }
  }

  return collectCategorizedIndexGroups(
    oneShotIndices,
    alternativeIndices,
    connectionIndices,
    blunderIndices,
    oneShotOnly,
    pageSize,
    page,
    exactWord,
    exactReading,
    options
  );
}

// Benchmark-only control path.  Keeping it here makes the performance report
// reproducible against the exact previous full-sort behavior without exposing
// it to the UI.
function collectResultsLegacy(candidates, oneShotOnly, pageSize, page, exactWord, exactReading) {
  const oneShotIndices = [];
  const alternativeIndices = [];
  const blunderIndices = [];
  const connectionIndices = [];
  for (const index of candidates) {
    const category = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
    if (category === CATEGORY_ONE_SHOT) oneShotIndices.push(index);
    else if (category === CATEGORY_ALTERNATIVE) alternativeIndices.push(index);
    else if (category === CATEGORY_BLUNDER) blunderIndices.push(index);
    else connectionIndices.push(index);
  }
  sortIndexGroup(oneShotIndices, exactWord, exactReading);
  sortIndexGroup(alternativeIndices, exactWord, exactReading);
  sortIndexGroup(blunderIndices, exactWord, exactReading);
  sortConnectionIndexGroup(connectionIndices);
  const categoryCounts = {
    oneShot: oneShotIndices.length,
    alternativeOneShot: alternativeIndices.length,
    connection: connectionIndices.length,
    blunder: blunderIndices.length
  };
  const ordered = oneShotOnly
    ? oneShotIndices.concat(alternativeIndices, connectionIndices, blunderIndices)
    : connectionIndices.concat(alternativeIndices, oneShotIndices, blunderIndices);
  const pinned = pinExactMatchIndices(ordered, exactWord, exactReading);
  const size = Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT);
  const currentPage = Math.min(
    Math.max(1, Math.floor(Number(page)) || 1),
    Math.max(1, Math.ceil(ordered.length / size))
  );
  return {
    total: ordered.length,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(ordered.length / size)),
    visibleIndices: pinned.slice((currentPage - 1) * size, currentPage * size)
  };
}

function collectCategorizedIndexGroups(
  oneShotIndices,
  alternativeIndices,
  connectionIndices,
  blunderIndices,
  oneShotOnly,
  pageSize,
  page,
  exactWord,
  exactReading,
  options
) {
  const categoryCounts = {
    oneShot: oneShotIndices.length,
    alternativeOneShot: alternativeIndices.length,
    connection: connectionIndices.length,
    blunder: blunderIndices.length
  };
  const total =
    categoryCounts.oneShot +
    categoryCounts.alternativeOneShot +
    categoryCounts.connection +
    categoryCounts.blunder;
  const size = Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT);
  const requestedPage = Math.floor(Number(page)) || 1;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (currentPage - 1) * size;
  const end = start + size;

  let pinned = EMPTY;
  if (exactWord || exactReading) {
    const groups = [oneShotIndices, alternativeIndices, blunderIndices];
    const exactMatches = [];
    for (const group of groups) {
      for (let index = group.length - 1; index >= 0; index -= 1) {
        if (isExactQueryMatchIndex(group[index], exactWord, exactReading)) {
          exactMatches.push(group[index]);
          group.splice(index, 1);
        }
      }
    }
    if (exactMatches.length) {
      exactMatches.sort((left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading));
      pinned = exactMatches;
    }
  }

  const compareConnection = createConnectionIndexComparator(options);
  const orderedGroups = oneShotOnly
    ? [
        { indices: pinned, compare: compareIndexReading },
        { indices: oneShotIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) },
        { indices: alternativeIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) },
        { indices: connectionIndices, compare: compareConnection },
        { indices: blunderIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) }
      ]
    : [
        { indices: pinned, compare: compareIndexReading },
        { indices: connectionIndices, compare: compareConnection },
        { indices: alternativeIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) },
        { indices: oneShotIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) },
        { indices: blunderIndices, compare: (left, right) => compareIndexSearchGroup(left, right, exactWord, exactReading) }
      ];

  const visibleIndices = [];
  let offset = 0;
  for (const group of orderedGroups) {
    const length = group.indices.length;
    const localStart = Math.max(0, start - offset);
    const localEnd = Math.min(length, end - offset);
    if (localEnd > localStart) {
      visibleIndices.push(...selectSortedIndexRange(group.indices, localStart, localEnd, group.compare));
    }
    offset += length;
    if (offset >= end) {
      break;
    }
  }

  return {
    total,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount,
    visibleIndices
  };
}

function selectSortedIndexRange(indices, start, end, compare) {
  if (!indices.length || end <= start) {
    return [];
  }
  const upperBound = Math.min(indices.length, end);
  if (upperBound < indices.length) {
    quickSelectIndices(indices, upperBound - 1, compare);
  }
  const selected = indices.slice(0, upperBound);
  selected.sort(compare);
  return selected.slice(start, upperBound);
}

function quickSelectIndices(indices, target, compare) {
  let left = 0;
  let right = indices.length - 1;
  while (left < right) {
    const pivot = indices[(left + right) >>> 1];
    let low = left;
    let high = right;
    while (low <= high) {
      while (compare(indices[low], pivot) < 0) low += 1;
      while (compare(indices[high], pivot) > 0) high -= 1;
      if (low <= high) {
        const value = indices[low];
        indices[low] = indices[high];
        indices[high] = value;
        low += 1;
        high -= 1;
      }
    }
    if (target <= high) {
      right = high;
    } else if (target >= low) {
      left = low;
    } else {
      return;
    }
  }
}

function compareIndexSearchGroup(left, right, exactWord, exactReading) {
  const leftExact = isExactQueryMatchIndex(left, exactWord, exactReading);
  const rightExact = isExactQueryMatchIndex(right, exactWord, exactReading);
  if (leftExact !== rightExact) {
    return leftExact ? -1 : 1;
  }
  return compareIndexReading(left, right);
}

function compareConnectionIndex(left, right) {
  const leftFollowers = Number(getPackedEntry(left)[ENTRY_FOLLOWER_COUNT]) || 0;
  const rightFollowers = Number(getPackedEntry(right)[ENTRY_FOLLOWER_COUNT]) || 0;
  if (leftFollowers !== rightFollowers) {
    return leftFollowers - rightFollowers;
  }
  return compareIndexReading(left, right);
}

function createConnectionIndexComparator(options) {
  if (!options || !options.hasUsedWords) {
    return compareConnectionIndex;
  }
  return (left, right) => {
    const leftFollowers = getAvailableFollowerCount(left, options);
    const rightFollowers = getAvailableFollowerCount(right, options);
    if (leftFollowers !== rightFollowers) {
      return leftFollowers - rightFollowers;
    }
    return compareIndexReading(left, right);
  };
}

function sortIndexGroup(indices, exactWord, exactReading) {
  indices.sort((left, right) => {
    const leftExact = isExactQueryMatchIndex(left, exactWord, exactReading);
    const rightExact = isExactQueryMatchIndex(right, exactWord, exactReading);
    if (leftExact !== rightExact) {
      return leftExact ? -1 : 1;
    }
    return compareIndexReading(left, right);
  });
}

function sortConnectionIndexGroup(indices) {
  indices.sort((left, right) => {
    const leftFollowers = Number(getPackedEntry(left)[ENTRY_FOLLOWER_COUNT]) || 0;
    const rightFollowers = Number(getPackedEntry(right)[ENTRY_FOLLOWER_COUNT]) || 0;
    if (leftFollowers !== rightFollowers) {
      return leftFollowers - rightFollowers;
    }
    return compareIndexReading(left, right);
  });
}

function pinExactMatchIndices(indices, exactWord, exactReading) {
  if (!exactWord && !exactReading) {
    return indices;
  }

  const exactMatches = [];
  const rest = [];
  for (const index of indices) {
    const category = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
    if (
      isExactQueryMatchIndex(index, exactWord, exactReading) &&
      category !== CATEGORY_CONNECTION
    ) {
      exactMatches.push(index);
    } else {
      rest.push(index);
    }
  }
  return exactMatches.length ? exactMatches.concat(rest) : indices;
}

function isExactQueryMatchIndex(index, exactWord, exactReading) {
  return (
    (exactWord && entryKey(index) === exactWord) ||
    (exactReading && entryReading(index) === exactReading)
  );
}

function getEntryState(index, options) {
  const cached = options.stateCache.get(index);
  if (cached) {
    return cached;
  }

  const entry = getPackedEntry(index);
  const category = Number(entry[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
  let followerCount = Number(entry[ENTRY_FOLLOWER_COUNT]) || 0;
  let oneShot = category === CATEGORY_ONE_SHOT;
  let alternativeOneShot = category === CATEGORY_ALTERNATIVE;
  let blunder = category === CATEGORY_BLUNDER;
  let oneShotReplyCount = Number(entry[ENTRY_ONE_SHOT_REPLY_COUNT]) || 0;
  let alternativeOneShotReplyCount = Number(entry[ENTRY_ALTERNATIVE_REPLY_COUNT]) || 0;

  if (options.forceDynamic) {
    followerCount = getAvailableFollowerCount(index, options);
    const replyOptions = createPlayedOptions(options, index);
    const oneShotCounters = getOneShotCounterIndices(index, replyOptions);
    const alternativeOneShotCounters = getAlternativeOneShotCounterIndices(index, replyOptions);
    oneShot = followerCount === 0;
    oneShotReplyCount = oneShotCounters.length;
    alternativeOneShotReplyCount = alternativeOneShotCounters.length;
    blunder = followerCount > 0 && (oneShotReplyCount > 0 || alternativeOneShotReplyCount > 0);
    alternativeOneShot = !oneShot && !blunder && category === CATEGORY_ALTERNATIVE;
    if (blunder) {
      alternativeOneShot = false;
    }
  } else if (options.hasUsedWords) {
    followerCount = getAvailableFollowerCount(index, options);
    oneShot = followerCount === 0;
    if (oneShot) {
      alternativeOneShot = false;
      blunder = false;
      oneShotReplyCount = 0;
      alternativeOneShotReplyCount = 0;
    }
  }

  const state = {
    index,
    key: entryKey(index),
    word: String(entry[ENTRY_WORD]),
    language: entry[ENTRY_LANGUAGE] === "e" ? "en" : "ko",
    reading: String(entry[ENTRY_READING]),
    start: entryStart(index),
    end: entryEnd(index),
    allowedAfter: getAllowedAfter(index),
    followerCount,
    oneShotReplyCount,
    alternativeOneShotReplyCount,
    oneShot,
    alternativeOneShot,
    blunder
  };
  options.stateCache.set(index, state);
  return state;
}

function getAvailableFollowerCount(index, options) {
  const staticFollowerCount = getStaticFollowerCount(index);
  if (!options.forceDynamic && !options.hasUsedWords) {
    return staticFollowerCount;
  }
  if (options.followerCache.has(index)) {
    return options.followerCache.get(index);
  }

  if (!options.forceDynamic && options.hasUsedWords) {
    let usedFollowers = 0;
    for (const start of getAllowedAfter(index)) {
      usedFollowers += (options.usedStartCounts && options.usedStartCounts.get(start)) || 0;
    }
    if (isUsedIndex(index, options) && getAllowedAfter(index).includes(entryStart(index))) {
      usedFollowers -= 1;
    }
    const count = Math.max(0, staticFollowerCount - Math.max(0, usedFollowers));
    options.followerCache.set(index, count);
    return count;
  }

  let count = 0;
  const seen = new Set();
  for (const start of getAllowedAfter(index)) {
    forEachBucketIndex(start, (replyIndex) => {
      if (replyIndex === index || seen.has(replyIndex) || isUsedIndex(replyIndex, options)) {
        return;
      }
      seen.add(replyIndex);
      count += 1;
    });
  }
  options.followerCache.set(index, count);
  return count;
}

function getOneShotCounterIndices(index, options) {
  if (options.oneShotCounterCache.has(index)) {
    return options.oneShotCounterCache.get(index);
  }

  const replies = [];
  const seen = new Set();
  for (const start of getAllowedAfter(index)) {
    forEachBucketIndex(start, (replyIndex) => {
      if (replyIndex === index || seen.has(replyIndex) || isUsedIndex(replyIndex, options)) {
        return;
      }
      seen.add(replyIndex);
      if (!canBecomeOneShot(replyIndex, options)) {
        return;
      }
      if (getAvailableFollowerCount(replyIndex, options) === 0) {
        replies.push(replyIndex);
      }
    });
  }
  replies.sort(compareIndexReading);
  options.oneShotCounterCache.set(index, replies);
  return replies;
}

function getAlternativeOneShotCounterIndices(index, options) {
  if (options.alternativeOneShotCounterCache.has(index)) {
    return options.alternativeOneShotCounterCache.get(index);
  }

  const replies = [];
  const seen = new Set();
  for (const start of getAllowedAfter(index)) {
    forEachBucketIndex(start, (replyIndex) => {
      if (replyIndex === index || seen.has(replyIndex) || isUsedIndex(replyIndex, options)) {
        return;
      }
      seen.add(replyIndex);
      const entry = getPackedEntry(replyIndex);
      const category = Number(entry[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
      if (category === CATEGORY_ALTERNATIVE && getAvailableFollowerCount(replyIndex, options) > 0) {
        replies.push(replyIndex);
      }
    });
  }
  replies.sort(compareIndexReading);
  options.alternativeOneShotCounterCache.set(index, replies);
  return replies;
}

function createSearchResultEntry(state, options, skipCounterWords) {
  if (skipCounterWords) {
    return {
      ...state,
      oneShotReplyWords: [],
      alternativeOneShotReplyWords: []
    };
  }

  return {
    ...state,
    oneShotReplyWords: getCounterReplyWords(state, (entry) => entry.oneShot, options),
    alternativeOneShotReplyWords: getCounterReplyWords(
      state,
      (entry) => entry.alternativeOneShot,
      options
    )
  };
}

function getCounterReplyWords(state, predicate, options) {
  if (!state.blunder) {
    return [];
  }
  // This is display-only detail.  Scanning a 10k+ reply bucket to list at
  // most 12 names is the historic outlier for words such as 값/틀.
  for (const start of state.allowedAfter) {
    if (getBucket(start).length > MAX_COUNTER_REPLY_BUCKET_SCAN) {
      return [];
    }
  }
  const replyOptions = createPlayedOptions(options, state.index);
  const replies = [];
  const seen = new Set();
  for (const start of state.allowedAfter) {
    forEachBucketIndex(start, (replyIndex) => {
      if (replies.length >= MAX_COUNTER_REPLY_WORDS) {
        return;
      }
      if (replyIndex === state.index || seen.has(replyIndex) || isUsedIndex(replyIndex, replyOptions)) {
        return;
      }
      const replyState = getEntryState(replyIndex, replyOptions);
      if (!predicate(replyState)) {
        return;
      }
      seen.add(replyIndex);
      replies.push(replyState);
      if (replies.length >= MAX_COUNTER_REPLY_WORDS) {
        return;
      }
    });
    if (replies.length >= MAX_COUNTER_REPLY_WORDS) {
      break;
    }
  }
  replies.sort(compareReading);
  return replies.map((entry) => entry.word);
}

function createEmptyResults(pageSize, page) {
  const requestedSize = Math.floor(Number(pageSize)) || DEFAULT_LIMIT;
  return {
    total: 0,
    categoryCounts: {
      oneShot: 0,
      alternativeOneShot: 0,
      connection: 0,
      blunder: 0
    },
    page: Math.max(1, Math.floor(Number(page)) || 1),
    pageSize: Math.max(1, requestedSize),
    pageCount: 1,
    results: []
  };
}

function sortSearchGroup(entries, exactWord, exactReading) {
  entries.sort((left, right) => {
    const leftExact = isExactQueryMatch(left, exactWord, exactReading);
    const rightExact = isExactQueryMatch(right, exactWord, exactReading);
    if (leftExact !== rightExact) {
      return leftExact ? -1 : 1;
    }
    return compareReading(left, right);
  });
}

function sortConnectionGroup(entries) {
  entries.sort((left, right) => {
    if (left.followerCount !== right.followerCount) {
      return left.followerCount - right.followerCount;
    }
    return compareReading(left, right);
  });
}

function pinExactMatches(entries, exactWord, exactReading) {
  if (!exactWord && !exactReading) {
    return entries;
  }
  const exactMatches = [];
  const rest = [];
  for (const entry of entries) {
    if (isExactQueryMatch(entry, exactWord, exactReading) && !isSafeConnection(entry)) {
      exactMatches.push(entry);
    } else {
      rest.push(entry);
    }
  }
  return exactMatches.length ? exactMatches.concat(rest) : entries;
}

function isSafeConnection(entry) {
  return !entry.oneShot && !entry.alternativeOneShot && !entry.blunder;
}

function isExactQueryMatch(entry, exactWord, exactReading) {
  return (
    (exactWord && entry.key === exactWord) ||
    (exactReading && entry.reading === exactReading)
  );
}

function compareReading(left, right) {
  if (left.reading < right.reading) {
    return -1;
  }
  if (left.reading > right.reading) {
    return 1;
  }
  if (left.reading.length !== right.reading.length) {
    return left.reading.length - right.reading.length;
  }
  if (left.word < right.word) {
    return -1;
  }
  if (left.word > right.word) {
    return 1;
  }
  return 0;
}

function compareIndexReading(left, right) {
  return compareReading(
    {
      reading: entryReading(left),
      word: entryWord(left)
    },
    {
      reading: entryReading(right),
      word: entryWord(right)
    }
  );
}

function parseCustomEntries(text) {
  const entries = [];
  let invalid = 0;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parsed = parseCustomLine(line);
    if (!parsed) {
      invalid += 1;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, invalid };
}

function parseCustomLine(line) {
  let word = "";
  let reading = "";
  if (/(=|,|\t)/.test(line)) {
    const parts = line.split(/=|,|\t/);
    word = normalizeWord(parts[0]);
    reading = cleanHangul(parts.slice(1).join(""));
  } else {
    word = normalizeWord(line.split("/", 1)[0]);
  }

  const hangulWord = cleanHangul(word);
  if (hangulWord && hangulWord.length === word.length) {
    reading = reading || hangulWord;
  } else if (/^[A-Za-z]+$/.test(word)) {
    reading = reading || englishToHangul(word);
  }

  if (!word || !reading || reading.length < 2 || !/^[가-힣]+$/.test(reading)) {
    return null;
  }

  return {
    key: normalizeKey(word),
    word,
    reading,
    language: /^[A-Za-z]+$/.test(word) ? "e" : "k",
    start: reading[0],
    end: getLastSyllable(reading),
    allowedAfter: getAllowedStartSyllables(getLastSyllable(reading))
  };
}

function getQueryInfo(query, sourceMode) {
  const reading = toReading(query);
  if (!reading) {
    return {
      reading: "",
      prefixes: [],
      starts: [],
      display: "-"
    };
  }

  if (sourceMode === "reply") {
    const last = getLastSyllable(reading);
    return {
      reading,
      prefixes: [],
      starts: getAllowedStartSyllables(last),
      display: last
    };
  }

  const prefixes = getSearchPrefixes(reading);
  return {
    reading,
    prefixes,
    starts: [reading[0]],
    display: prefixes.join(", ")
  };
}

function getSearchPrefixes(reading) {
  if (!reading) {
    return [];
  }
  const rest = reading.slice(1);
  return getSearchStartSyllables(reading[0]).map((start) => `${start}${rest}`);
}

function getSearchStartSyllables(syllable) {
  return getAllowedStartSyllables(syllable);
}

function getAllowedAfter(index) {
  const entry = getPackedEntry(index);
  const allowed = entry && entry[ENTRY_ALLOWED_AFTER];
  if (Array.isArray(allowed)) {
    return allowed;
  }
  return getAllowedStartSyllables(entryEnd(index));
}

function getAllowedStartSyllables(syllable) {
  const info = decomposeSyllable(syllable);
  if (!info) {
    return [];
  }
  const variants = new Set([syllable]);
  if (info.lead === RIEUL) {
    const replacement = IOTIZED_VOWELS.has(info.vowel) ? IEUNG : NIEUN;
    variants.add(composeSyllable(replacement, info.vowel, info.trail));
  }
  if (info.lead === NIEUN && IOTIZED_VOWELS.has(info.vowel)) {
    variants.add(composeSyllable(IEUNG, info.vowel, info.trail));
  }
  return Array.from(variants);
}

function decomposeSyllable(syllable) {
  if (!isHangulSyllable(syllable)) {
    return null;
  }
  const offset = syllable.charCodeAt(0) - HANGUL_BASE;
  return {
    lead: Math.floor(offset / SYLLABLE_BLOCK),
    vowel: Math.floor((offset % SYLLABLE_BLOCK) / TRAILING_COUNT),
    trail: offset % TRAILING_COUNT
  };
}

function composeSyllable(lead, vowel, trail) {
  return String.fromCharCode(HANGUL_BASE + lead * SYLLABLE_BLOCK + vowel * TRAILING_COUNT + trail);
}

function toReading(value) {
  const compact = normalizeSearchQuery(value);
  if (/^[A-Za-z]+$/.test(compact)) {
    return englishToHangul(compact);
  }
  return cleanHangul(compact);
}

function normalizeSearchQuery(value) {
  return normalizeNfc(value).trim().replace(/\s+/g, "");
}

function validateSearchQuery(value) {
  const query = normalizeSearchQuery(value);
  if (!query || query.length > MAX_SEARCH_QUERY_LENGTH) {
    return false;
  }
  return Boolean(toReading(query));
}

function getLastSyllable(reading) {
  const text = String(reading || "");
  return text ? text[text.length - 1] : "";
}

function englishToHangul(value) {
  const word = String(value || "").replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!word) {
    return "";
  }
  const overrides = {
    benzene: "벤젠",
    methane: "메테인",
    ethane: "에테인",
    propane: "프로페인",
    butane: "뷰테인",
    ethanol: "에탄올",
    methanol: "메탄올",
    acetone: "아세톤",
    computer: "컴퓨터",
    cookie: "쿠키",
    secret: "시크릿"
  };
  if (overrides[word]) {
    return overrides[word];
  }
  const letters = {
    a: "아",
    b: "브",
    c: "크",
    d: "드",
    e: "이",
    f: "프",
    g: "그",
    h: "흐",
    i: "이",
    j: "지",
    k: "크",
    l: "르",
    m: "므",
    n: "느",
    o: "오",
    p: "프",
    q: "큐",
    r: "르",
    s: "스",
    t: "트",
    u: "유",
    v: "브",
    w: "우",
    x: "엑스",
    y: "이",
    z: "즈"
  };
  return Array.from(word)
    .map((char) => letters[char] || "")
    .join("");
}

function cleanHangul(value) {
  const normalized = normalizeNfc(value);
  return Array.from(normalized)
    .filter(isHangulSyllable)
    .join("");
}

function normalizeNfc(value) {
  const text = String(value == null ? "" : value);
  return typeof text.normalize === "function" ? text.normalize("NFC") : text;
}

function isHangulSyllable(char) {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return code >= HANGUL_BASE && code <= HANGUL_END;
}

function normalizeWord(value) {
  return normalizeNfc(value).replace(/\s+/g, "").trim();
}

function normalizeKey(value) {
  return normalizeWord(value).toLowerCase();
}

function getBucket(start) {
  touchShard(start);
  const base = baseBuckets[start] || EMPTY;
  const custom = customByStart.get(start) || EMPTY;
  if (!custom.length) {
    return base;
  }
  const visibleCustom = custom.filter((index) => !baseByKey.has(entryKey(index)));
  if (!visibleCustom.length) {
    return base;
  }
  if (!base.length) {
    return visibleCustom;
  }
  return base.concat(visibleCustom);
}

function forEachBucketIndex(start, callback) {
  touchShard(start);
  const base = baseBuckets[start] || EMPTY;
  for (const index of base) {
    callback(index);
  }
  const custom = customByStart.get(start) || EMPTY;
  for (const index of custom) {
    if (baseByKey.has(entryKey(index))) {
      continue;
    }
    callback(index);
  }
}

function someInBucket(start, predicate) {
  touchShard(start);
  const base = baseBuckets[start] || EMPTY;
  for (const index of base) {
    if (predicate(index)) return true;
  }
  const custom = customByStart.get(start) || EMPTY;
  for (const index of custom) {
    if (baseByKey.has(entryKey(index))) continue;
    if (predicate(index)) return true;
  }
  return false;
}

function checkHasOneShotCounter(index, options) {
  for (const start of getAllowedAfter(index)) {
    const found = someInBucket(start, (replyIndex) => {
      if (replyIndex === index || isUsedIndex(replyIndex, options)) return false;
      return getAvailableFollowerCount(replyIndex, options) === 0;
    });
    if (found) return true;
  }
  return false;
}

function checkHasAltOneShotCounter(index, options) {
  for (const start of getAllowedAfter(index)) {
    const found = someInBucket(start, (replyIndex) => {
      if (replyIndex === index || isUsedIndex(replyIndex, options)) return false;
      const cat = Number(getPackedEntry(replyIndex)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
      return cat === CATEGORY_ALTERNATIVE && getAvailableFollowerCount(replyIndex, options) > 0;
    });
    if (found) return true;
  }
  return false;
}

function getIndexByKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return -1;
  }
  if (customByKey.has(normalized)) {
    return customByKey.get(normalized);
  }
  return baseByKey.has(normalized) ? baseByKey.get(normalized) : -1;
}

function getCustomIndices() {
  if (!cachedCustomIndices) {
    cachedCustomIndices = [];
    for (let offset = 0; offset < customEntries.length; offset += 1) {
      cachedCustomIndices.push(baseEntries.length + offset);
    }
  }
  return cachedCustomIndices;
}

function isUsedIndex(index, options) {
  return Boolean(options.hasUsedWords && options.usedKeySet.has(entryKey(index)));
}

function getStaticFollowerCount(index) {
  return Number(getPackedEntry(index)[ENTRY_FOLLOWER_COUNT]) || 0;
}

function canBecomeOneShot(index, options) {
  return getAvailableFollowerCount(index, options) === 0;
}

function createPlayedOptions(options, playedIndex) {
  const playedKey = entryKey(playedIndex);
  if (!playedKey || isUsedIndex(playedIndex, options)) {
    return options;
  }
  const usedKeySet = new Set(options.usedKeySet || []);
  usedKeySet.add(playedKey);
  const usedStartCounts = new Map(options.usedStartCounts || []);
  const start = entryStart(playedIndex);
  usedStartCounts.set(start, (usedStartCounts.get(start) || 0) + 1);
  return {
    ...options,
    usedKeySet,
    hasUsedWords: true,
    usedStartCounts,
    stateCache: new Map(),
    followerCache: new Map(),
    oneShotCounterCache: new Map(),
    alternativeOneShotCounterCache: new Map()
  };
}

function getPackedEntry(index) {
  if (index < baseEntries.length) {
    return baseEntries[index];
  }
  return customEntries[index - baseEntries.length];
}

function entryWord(index) {
  return String(getPackedEntry(index)[ENTRY_WORD]);
}

function entryKey(index) {
  return entryKeyFromPacked(getPackedEntry(index));
}

function entryReading(index) {
  return String(getPackedEntry(index)[ENTRY_READING]);
}

function entryStart(index) {
  const entry = getPackedEntry(index);
  return entryStartFromPacked(entry);
}

function entryEnd(index) {
  return entryEndFromPacked(getPackedEntry(index));
}

function entryKeyFromPacked(entry) {
  if (entry && entry[ENTRY_KEY]) {
    return String(entry[ENTRY_KEY]);
  }
  return normalizeKey(entry && entry[ENTRY_WORD]);
}

function entryStartFromPacked(entry) {
  if (entry && entry[ENTRY_START]) {
    return String(entry[ENTRY_START]);
  }
  return String(entry && entry[ENTRY_READING] || "")[0] || "";
}

function entryEndFromPacked(entry) {
  if (entry && entry[ENTRY_END]) {
    return String(entry[ENTRY_END]);
  }
  return getLastSyllable(entry && entry[ENTRY_READING]);
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function elapsed(started) {
  return Math.round((now() - started) * 10) / 10;
}

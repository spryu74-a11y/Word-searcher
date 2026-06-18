"use strict";

const INDEX_MANIFEST_URL = "./data/search-index-manifest.json?v=modern-search-index-shards-20260618";
const INDEX_URL = "./data/search-index.json?v=modern-search-index-20260618-kits";
const SHARD_BASE_URL = "./data/search-index-shards/";
const SHARD_VERSION = "modern-search-index-shards-20260618";
const DEFAULT_LIMIT = 260;
const ENTRY_WORD = 0;
const ENTRY_READING = 1;
const ENTRY_LANGUAGE = 2;
const ENTRY_FOLLOWER_COUNT = 3;
const ENTRY_ONE_SHOT_REPLY_COUNT = 4;
const ENTRY_ALTERNATIVE_REPLY_COUNT = 5;
const ENTRY_CATEGORY = 6;
const CATEGORY_CONNECTION = 0;
const CATEGORY_ONE_SHOT = 1;
const CATEGORY_ALTERNATIVE = 2;
const CATEGORY_BLUNDER = 3;
const LARGE_CANDIDATE_SORT_THRESHOLD = 3000;
const MAX_CANDIDATES_PER_QUERY = 50000;
const COUNTER_WORDS_SKIP_THRESHOLD = 5000;
const MAX_COUNTER_REPLY_WORDS = 12;
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

let indexPromise = null;
let useFullIndex = false;
let shardFiles = Object.create(null);
let shardPromises = new Map();
let baseEntries = [];
let baseBuckets = Object.create(null);
let baseByKey = new Map();
let baseStats = null;
let defaultMeta = null;
let customEntries = [];
let customByStart = new Map();
let customByKey = new Map();
let cachedCustomIndices = null;
let runtimeStats = null;

self.onmessage = (event) => {
  handleMessage(event.data);
};

async function handleMessage(message) {
  try {
    if (message.type === "buildDefault") {
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
      await ensureIndex();
      const selectedWords = appendOnlineCandidateWords(message.words || [], message.lookup || {});
      self.postMessage({
        type: "onlineAppendResult",
        id: message.id,
        stats: runtimeStats,
        words: selectedWords,
        lookup: message.lookup || {}
      });
      return;
    }

    if (message.type === "search") {
      await ensureIndex();
      const payload = await searchDictionary(message.options || {});
      self.postMessage({ type: "searchResult", id: message.id, payload });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message && message.id,
      message: error && error.message ? error.message : String(error)
    });
  }
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
        useFullIndex = false;
        shardFiles = Object.create(null);
        for (const [start, info] of Object.entries(payload.shards || {})) {
          const file = info && typeof info === "object" ? info.file : "";
          if (file) {
            shardFiles[start] = file;
          }
        }
        const total = Number(payload.total || (payload.stats && payload.stats.total) || 0);
        baseEntries = [];
        baseEntries.length = total;
        baseBuckets = Object.create(null);
        baseByKey = new Map();
        baseStats = payload.stats || createEmptyStats();
        defaultMeta = payload.meta || null;
        runtimeStats = { ...baseStats, buildMs: 0 };
        prefetchAllShards();
        return payload;
      })
      .catch(() => loadFullIndex());
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
      useFullIndex = true;
      shardFiles = Object.create(null);
      shardPromises = new Map();
      baseEntries = payload.entries || [];
      baseBuckets = payload.buckets || Object.create(null);
      baseStats = payload.stats || createEmptyStats();
      defaultMeta = payload.meta || null;
      buildBaseKeyMap();
      runtimeStats = { ...baseStats, buildMs: 0 };
      return payload;
    });
}

async function loadShards(starts) {
  await ensureIndex();
  if (useFullIndex) {
    return;
  }
  const uniqueStarts = Array.from(new Set((starts || []).filter(Boolean)));
  await Promise.all(uniqueStarts.map((start) => loadShard(start).catch(() => {})));
}

async function loadShard(start) {
  if (useFullIndex || baseBuckets[start]) {
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
        for (const row of payload.entries || []) {
          const index = Number(row[0]);
          if (!Number.isFinite(index)) {
            continue;
          }
          const packed = row.slice(1);
          baseEntries[index] = packed;
          baseByKey.set(normalizeKey(packed[ENTRY_WORD]), index);
          indices.push(index);
        }
        baseBuckets[start] = indices;
        return indices;
      })
      .catch((err) => {
        shardPromises.delete(start);
        throw err;
      });
    shardPromises.set(start, request);
  }
  await shardPromises.get(start);
}

function prefetchAllShards() {
  const starts = Object.keys(shardFiles);
  if (!starts.length) return;
  let idx = 0;
  function next() {
    if (idx >= starts.length) return;
    loadShard(starts[idx++]).then(next, next);
  }
  const concurrency = Math.min(8, starts.length);
  for (let i = 0; i < concurrency; i++) next();
}

async function buildRuntime(extraText) {
  const started = now();
  await ensureIndex();
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
      CATEGORY_CONNECTION
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
      CATEGORY_CONNECTION
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

async function searchDictionary(options) {
  const started = now();
  const pageSize = Number(options.pageSize || options.limit || DEFAULT_LIMIT);
  const page = Number(options.page || 1);
  const sourceMode = options.sourceMode === "reply" ? "reply" : "starts";
  const queryInfo = getQueryInfo(options.query, sourceMode);
  const exactWord = normalizeKey(options.query || "");
  const exactReading = queryInfo.reading;

  if (!queryInfo.reading) {
    return {
      queryInfo,
      ...createEmptyResults(pageSize, page),
      elapsedMs: elapsed(started)
    };
  }

  await loadShards(getSearchShardStarts(queryInfo, sourceMode));
  const searchOptions = createSearchOptions(options);
  const candidates =
    sourceMode === "reply"
      ? searchByReply(queryInfo.starts)
      : searchByPrefixes(queryInfo.prefixes);
  const merged = includeExactCandidates(candidates, exactWord, exactReading);

  // Always use static categorization for ordering (fast, no extra shard loads needed)
  const collected = collectResultsFast(
    merged,
    Boolean(options.oneShotOnly),
    pageSize,
    page,
    exactWord,
    exactReading,
    searchOptions
  );

  const isDynamic = searchOptions.hasUsedWords || searchOptions.forceDynamic;

  // Load follower shards only for visible entries (not all candidates)
  if (isDynamic) {
    await loadShards(getAllowedAfterStartsForIndices(collected.visibleIndices));
  }

  // Compute full dynamic states for visible entries (shards now loaded)
  const visibleStates = collected.visibleIndices.map((index) => getEntryState(index, searchOptions));

  // Load counter shards in background — don't block the response
  loadShards(getCounterShardStarts(visibleStates)).catch(() => {});
  const results = visibleStates.map((state) => createSearchResultEntry(state, searchOptions, false));

  return {
    queryInfo,
    total: collected.total,
    categoryCounts: collected.categoryCounts,
    limit: collected.pageSize,
    page: collected.page,
    pageSize: collected.pageSize,
    pageCount: collected.pageCount,
    results,
    elapsedMs: elapsed(started)
  };
}

function createSearchOptions(options) {
  const usedKeySet = new Set();
  for (const rawKey of options.usedKeys || []) {
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

function searchByPrefixes(prefixes) {
  const uniquePrefixes = Array.from(new Set((prefixes || []).filter(Boolean)));
  if (!uniquePrefixes.length) {
    return [];
  }

  if (uniquePrefixes.length === 1) {
    const prefix = uniquePrefixes[0];
    const bucket = getBucket(prefix[0]);
    if (prefix.length === 1) {
      return bucket.slice(0, MAX_CANDIDATES_PER_QUERY);
    }
    if (!customEntries.length) {
      const filtered = [];
      for (const index of bucket) {
        if (entryReading(index).startsWith(prefix)) {
          filtered.push(index);
          if (filtered.length >= MAX_CANDIDATES_PER_QUERY) {
            break;
          }
        }
      }
      return filtered;
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const prefix of uniquePrefixes) {
    for (const index of getBucket(prefix[0])) {
      if (candidates.length >= MAX_CANDIDATES_PER_QUERY) {
        return candidates;
      }
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
      if (candidates.length >= MAX_CANDIDATES_PER_QUERY) {
        return candidates;
      }
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
      if (candidates.length >= MAX_CANDIDATES_PER_QUERY) {
        return candidates;
      }
      if (seen.has(index)) {
        continue;
      }
      seen.add(index);
      candidates.push(index);
    }
  }
  return candidates;
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
    for (const index of getBucket(exactReading[0])) {
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

  const total = candidates.length;
  const size = Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT);
  const requestedPage = Math.floor(Number(page)) || 1;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (currentPage - 1) * size;

  const oneShotIndices = [];
  const alternativeIndices = [];
  const blunderIndices = [];
  const safeConnectionIndices = [];

  const shouldRunDynamic = total <= LARGE_CANDIDATE_SORT_THRESHOLD;

  for (const index of candidates) {
    if (shouldRunDynamic) {
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
    } else {
      const staticCat = Number(getPackedEntry(index)[ENTRY_CATEGORY]) || CATEGORY_CONNECTION;
      if (staticCat === CATEGORY_ONE_SHOT) oneShotIndices.push(index);
      else if (staticCat === CATEGORY_ALTERNATIVE) alternativeIndices.push(index);
      else if (staticCat === CATEGORY_BLUNDER) blunderIndices.push(index);
      else safeConnectionIndices.push(index);
    }
  }

  sortIndexGroup(oneShotIndices, exactWord, exactReading);
  sortIndexGroup(alternativeIndices, exactWord, exactReading);
  sortIndexGroup(blunderIndices, exactWord, exactReading);
  sortConnectionIndexGroup(safeConnectionIndices);

  const categoryCounts = {
    oneShot: oneShotIndices.length,
    alternativeOneShot: alternativeIndices.length,
    connection: safeConnectionIndices.length,
    blunder: blunderIndices.length
  };

  const orderedIndices = oneShotOnly
    ? oneShotIndices.concat(alternativeIndices, safeConnectionIndices, blunderIndices)
    : safeConnectionIndices.concat(alternativeIndices, oneShotIndices, blunderIndices);

  const pinnedIndices = oneShotOnly
    ? pinExactMatchIndices(orderedIndices, exactWord, exactReading)
    : orderedIndices;

  const visibleIndices = pinnedIndices.slice(start, start + size);

  return {
    total,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount,
    visibleIndices
  };
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

  const total = candidates.length;
  const shouldSort = total <= LARGE_CANDIDATE_SORT_THRESHOLD;
  if (shouldSort) {
    sortIndexGroup(oneShotIndices, exactWord, exactReading);
    sortIndexGroup(alternativeIndices, exactWord, exactReading);
    sortIndexGroup(blunderIndices, exactWord, exactReading);
  }
  if (!oneShotOnly || shouldSort) {
    sortConnectionIndexGroup(connectionIndices);
  }

  const categoryCounts = {
    oneShot: oneShotIndices.length,
    alternativeOneShot: alternativeIndices.length,
    connection: connectionIndices.length,
    blunder: blunderIndices.length
  };

  const orderedIndices = oneShotOnly
    ? oneShotIndices.concat(alternativeIndices, connectionIndices, blunderIndices)
    : connectionIndices.concat(alternativeIndices, oneShotIndices, blunderIndices);
  const pinnedIndices = oneShotOnly && shouldSort
    ? pinExactMatchIndices(orderedIndices, exactWord, exactReading)
    : orderedIndices;

  const size = Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT);
  const requestedPage = Math.floor(Number(page)) || 1;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (currentPage - 1) * size;
  const visibleIndices = pinnedIndices.slice(start, start + size);

  return {
    total,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount,
    visibleIndices
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

  if (options.forceDynamic || options.hasUsedWords) {
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
  return left.word.localeCompare(right.word, "ko");
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
    start: reading[0]
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
    const last = reading[reading.length - 1];
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
  const compact = String(value || "").trim().replace(/\s+/g, "");
  if (/^[A-Za-z]+$/.test(compact)) {
    return englishToHangul(compact);
  }
  return cleanHangul(compact);
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
  const normalized = String(value || "").normalize("NFC");
  return Array.from(normalized)
    .filter(isHangulSyllable)
    .join("");
}

function isHangulSyllable(char) {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return code >= HANGUL_BASE && code <= HANGUL_END;
}

function normalizeWord(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeKey(value) {
  return normalizeWord(value).toLowerCase();
}

function getBucket(start) {
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
  return entryWord(index).toLowerCase();
}

function entryReading(index) {
  return String(getPackedEntry(index)[ENTRY_READING]);
}

function entryStart(index) {
  return entryReading(index)[0];
}

function entryEnd(index) {
  const reading = entryReading(index);
  return reading[reading.length - 1];
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function elapsed(started) {
  return Math.round((now() - started) * 10) / 10;
}

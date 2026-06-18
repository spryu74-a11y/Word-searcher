"use strict";

const INDEX_URL = "./data/search-index.json?v=modern-search-index-20260617";
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
const LARGE_DYNAMIC_RECALC_THRESHOLD = 800;
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
let baseEntries = [];
let baseBuckets = Object.create(null);
let baseByKey = null;
let baseStats = null;
let defaultMeta = null;
let customEntries = [];
let customByStart = new Map();
let customByKey = new Map();
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
      self.postMessage({
        type: "onlineAppendResult",
        id: message.id,
        stats: runtimeStats,
        words: [],
        lookup: message.lookup || {}
      });
      return;
    }

    if (message.type === "search") {
      await ensureIndex();
      const payload = searchDictionary(message.options || {});
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
    indexPromise = fetch(INDEX_URL, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("검색 인덱스를 불러오지 못했습니다");
        }
        return response.json();
      })
      .then((payload) => {
        baseEntries = payload.entries || [];
        baseBuckets = payload.buckets || Object.create(null);
        baseStats = payload.stats || createEmptyStats();
        defaultMeta = payload.meta || null;
        buildBaseKeyMap();
        runtimeStats = { ...baseStats, buildMs: 0 };
        return payload;
      });
  }
  return indexPromise;
}

async function buildRuntime(extraText) {
  const started = now();
  await ensureIndex();
  customEntries = [];
  customByStart = new Map();
  customByKey = new Map();

  const parsed = parseCustomEntries(extraText);
  for (const entry of parsed.entries) {
    if (baseByKey.has(entry.key) || customByKey.has(entry.key)) {
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

  for (let offset = 0; offset < customEntries.length; offset += 1) {
    const index = baseEntries.length + offset;
    const entry = customEntries[offset];
    const followerCount = getAvailableFollowerCount(index, createSearchOptions({}));
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
    invalid: (baseStats ? baseStats.invalid : 0) + parsed.invalid,
    custom: customEntries.length,
    buildMs: Math.round(now() - started)
  };
}

function buildBaseKeyMap() {
  if (baseByKey) {
    return;
  }
  baseByKey = new Map();
  for (let index = 0; index < baseEntries.length; index += 1) {
    baseByKey.set(entryKey(index), index);
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

function searchDictionary(options) {
  const started = now();
  const pageSize = Number(options.pageSize || options.limit || DEFAULT_LIMIT);
  const page = Number(options.page || 1);
  const sourceMode = options.sourceMode === "reply" ? "reply" : "starts";
  const queryInfo = getQueryInfo(options.query, sourceMode);
  const searchOptions = createSearchOptions(options);
  const exactWord = normalizeKey(options.query || "");
  const exactReading = queryInfo.reading;

  if (!queryInfo.reading) {
    return {
      queryInfo,
      ...createEmptyResults(pageSize, page),
      elapsedMs: elapsed(started)
    };
  }

  const candidates =
    sourceMode === "reply"
      ? searchByReply(queryInfo.starts)
      : searchByPrefixes(queryInfo.prefixes);
  const merged = includeExactCandidates(candidates, exactWord, exactReading);
  const collected = collectResults(
    merged,
    Boolean(options.oneShotOnly),
    pageSize,
    page,
    exactWord,
    exactReading,
    searchOptions
  );
  const skipCounterWords =
    searchOptions.hasUsedWords ||
    (!searchOptions.forceDynamic && collected.total >= COUNTER_WORDS_SKIP_THRESHOLD);

  return {
    queryInfo,
    total: collected.total,
    categoryCounts: collected.categoryCounts,
    limit: collected.pageSize,
    page: collected.page,
    pageSize: collected.pageSize,
    pageCount: collected.pageCount,
    results: collected.results.map((state) =>
      createSearchResultEntry(state, searchOptions, skipCounterWords)
    ),
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
  return {
    usedKeySet,
    hasUsedWords: usedKeySet.size > 0,
    forceDynamic: customEntries.length > 0,
    stateCache: new Map(),
    followerCache: new Map(),
    oneShotCounterCache: new Map()
  };
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
  if (options.hasUsedWords) {
    return collectResultsFast(
      candidates.filter((index) => !isUsedIndex(index, options)),
      oneShotOnly,
      pageSize,
      page,
      exactWord,
      exactReading,
      options
    );
  }

  if (candidates.length >= LARGE_DYNAMIC_RECALC_THRESHOLD) {
    return collectResultsFast(
      candidates,
      oneShotOnly,
      pageSize,
      page,
      exactWord,
      exactReading,
      options
    );
  }

  if (!options.hasUsedWords && !options.forceDynamic) {
    return collectResultsFast(candidates, oneShotOnly, pageSize, page, exactWord, exactReading, options);
  }

  const oneShots = [];
  const alternatives = [];
  const blunders = [];
  const safeConnections = [];
  let total = 0;

  for (const index of candidates) {
    if (isUsedIndex(index, options)) {
      continue;
    }
    const state = getEntryState(index, options);
    total += 1;
    if (state.oneShot) {
      oneShots.push(state);
    } else if (state.alternativeOneShot) {
      alternatives.push(state);
    } else if (state.blunder) {
      blunders.push(state);
    } else {
      safeConnections.push(state);
    }
  }

  sortSearchGroup(oneShots, exactWord, exactReading);
  sortSearchGroup(alternatives, exactWord, exactReading);
  sortConnectionGroup(safeConnections);
  sortSearchGroup(blunders, exactWord, exactReading);

  const categoryCounts = {
    oneShot: oneShots.length,
    alternativeOneShot: alternatives.length,
    connection: safeConnections.length,
    blunder: blunders.length
  };
  const categoryOrdered = oneShotOnly
    ? oneShots.concat(alternatives, safeConnections, blunders)
    : safeConnections.concat(alternatives, oneShots, blunders);
  const ordered = oneShotOnly
    ? pinExactMatches(categoryOrdered, exactWord, exactReading)
    : categoryOrdered;
  const size = Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_LIMIT);
  const requestedPage = Math.floor(Number(page)) || 1;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (currentPage - 1) * size;

  return {
    total,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount,
    results: ordered.slice(start, start + size)
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
    sortConnectionIndexGroup(connectionIndices);
    sortIndexGroup(blunderIndices, exactWord, exactReading);
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
  const visible = pinnedIndices.slice(start, start + size).map((index) => getEntryState(index, options));

  return {
    total,
    categoryCounts,
    page: currentPage,
    pageSize: size,
    pageCount,
    results: visible
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

  if (index >= baseEntries.length) {
    followerCount = getAvailableFollowerCount(index, options);
    const oneShotCounters = getOneShotCounterIndices(index, options);
    oneShot = followerCount === 0;
    oneShotReplyCount = oneShotCounters.length;
    if (!oneShot && !alternativeOneShot && (blunder || oneShotReplyCount > 0)) {
      blunder = true;
    }
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
  if (index < baseEntries.length) {
    return Number(getPackedEntry(index)[ENTRY_FOLLOWER_COUNT]) || 0;
  }
  if (options.followerCache.has(index)) {
    return options.followerCache.get(index);
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
      if (getAvailableFollowerCount(replyIndex, options) === 0) {
        replies.push(replyIndex);
      }
    });
  }
  replies.sort(compareIndexReading);
  options.oneShotCounterCache.set(index, replies);
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
  const replies = [];
  const seen = new Set();
  for (const start of state.allowedAfter) {
    forEachBucketIndex(start, (replyIndex) => {
      if (replyIndex === state.index || seen.has(replyIndex) || isUsedIndex(replyIndex, options)) {
        return;
      }
      const replyState = getEntryState(replyIndex, options);
      if (!predicate(replyState)) {
        return;
      }
      seen.add(replyIndex);
      replies.push(replyState);
    });
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
  if (!base.length) {
    return custom;
  }
  return base.concat(custom);
}

function forEachBucketIndex(start, callback) {
  const base = baseBuckets[start] || EMPTY;
  for (const index of base) {
    callback(index);
  }
  const custom = customByStart.get(start) || EMPTY;
  for (const index of custom) {
    callback(index);
  }
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
  const indices = [];
  for (let offset = 0; offset < customEntries.length; offset += 1) {
    indices.push(baseEntries.length + offset);
  }
  return indices;
}

function isUsedIndex(index, options) {
  return Boolean(options.hasUsedWords && options.usedKeySet.has(entryKey(index)));
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

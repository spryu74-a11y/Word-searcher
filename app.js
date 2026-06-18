(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = core;
    return;
  }

  root.KkungLogic = core;
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => initApp(core));
  }
})(typeof self !== "undefined" ? self : this, function createCore() {
  "use strict";

  const HANGUL_BASE = 0xac00;
  const HANGUL_END = 0xd7a3;
  const VOWEL_COUNT = 21;
  const TRAILING_COUNT = 28;
  const SYLLABLE_BLOCK = VOWEL_COUNT * TRAILING_COUNT;
  const NIEUN = 2;
  const RIEUL = 5;
  const IEUNG = 11;
  const TRAILING_DIGEUT = 7;
  const TRAILING_RIEUL = 8;
  const IOTIZED_VOWELS = new Set([2, 3, 6, 7, 12, 17, 20]);
  const DEFAULT_LIMIT = 260;
  const LARGE_DYNAMIC_RECALC_THRESHOLD = 800;
  const MAX_COUNTER_REPLY_WORDS = 12;
  const SURFACE_FORM_LEMMA_SUFFIXES = [
    ["져", "지다"],
    ["겨", "기다"],
    ["켜", "키다"],
    ["쳐", "치다"],
    ["려", "리다"],
    ["쥬", "다"],
    ["죠", "다"],
    ["지요", "다"],
    ["해", "하다"],
    ["해요", "하다"],
    ["하여", "하다"],
    ["한", "하다"],
    ["할", "하다"],
    ["돼요", "되다"],
    ["로워", "롭다"],
    ["러워", "럽다"],
    ["거워", "겁다"],
    ["겨워", "겹다"],
    ["까워", "깝다"],
    ["다워", "답다"],
    ["스러워", "스럽다"],
    ["려워", "렵다"],
    ["쉬워", "쉽다"]
  ];
  const SHORT_SURFACE_FORM_SUFFIXES = new Set(["해", "하여", "한", "할"]);
  const SURFACE_FORM_EXCEPTIONS = new Set(["버릊", "몽따쥬"]);
  const BLOCKED_WORDS = new Set([
    "다름스타튬",
    "늠손가락",
    "는저가락",
    "늣저가락",
    "늦저가락",
    "늠밤통"
  ]);
  const HANGUL_LETTER_NAMES = [
    "쌍기역",
    "쌍디귿",
    "쌍비읍",
    "쌍시옷",
    "쌍지읒",
    "기역",
    "니은",
    "디귿",
    "리을",
    "미음",
    "비읍",
    "시옷",
    "이응",
    "지읒",
    "치읓",
    "키읔",
    "티읕",
    "피읖",
    "히읗"
  ];
  const NON_WORD_SURFACE_FORMS = new Set([
    "몽띠쥬",
    "이쁘쥬",
    "해요",
    "지요",
    "군요",
    "구나",
    "는구나",
    "로구나",
    "습니다",
    "옜습니다",
    "올습니다",
    "읍니다",
    "아요",
    "어요",
    "시어요",
    "으시어요",
    "습죠",
    "읍죠",
    "습지요",
    "읍지요",
    "지긴지요"
  ]);
  const VOWEL_A = 0;
  const VOWEL_EO = 4;
  const VOWEL_YEO = 6;
  const VOWEL_O = 8;
  const VOWEL_WA = 9;
  const VOWEL_U = 13;
  const VOWEL_WEO = 14;
  const VOWEL_EU = 18;
  const VOWEL_I = 20;

  const FALLBACK_DICTIONARY = [
    "계란",
    "난로",
    "안색",
    "기동돓",
    "Secret",
    "benzene",
    "methane",
    "ethanol",
    "computer",
    "cookie",
    "킷값",
    "시계",
    "시장",
    "신문",
    "치즈",
    "휴지"
  ].join("\n");

  const ENGLISH_OVERRIDES = new Map(
    Object.entries({
      acetone: "아세톤",
      acid: "애시드",
      alcohol: "알코올",
      aldehyde: "알데하이드",
      alkane: "알케인",
      alkene: "알켄",
      alkyne: "알카인",
      ammonia: "암모니아",
      aniline: "아닐린",
      apple: "애플",
      argon: "아르곤",
      aspirin: "아스피린",
      banana: "바나나",
      benzaldehyde: "벤즈알데하이드",
      benzene: "벤젠",
      butane: "뷰테인",
      butanol: "부탄올",
      caffeine: "카페인",
      calcium: "칼슘",
      camera: "카메라",
      carbon: "카본",
      chloride: "클로라이드",
      chlorine: "클로린",
      chocolate: "초콜릿",
      chemistry: "케미스트리",
      chloroform: "클로로폼",
      coffee: "커피",
      computer: "컴퓨터",
      cookie: "쿠키",
      copper: "카퍼",
      decane: "데케인",
      dioxide: "다이옥사이드",
      ethane: "에테인",
      ethanol: "에탄올",
      ether: "에터",
      ethylene: "에틸렌",
      fructose: "프럭토스",
      game: "게임",
      glucose: "글루코스",
      helium: "헬륨",
      heptane: "헵테인",
      hexane: "헥세인",
      hydrogen: "하이드로젠",
      iodine: "아이오딘",
      iron: "아이언",
      ketone: "케톤",
      lemon: "레몬",
      lithium: "리튬",
      methane: "메테인",
      methanol: "메탄올",
      music: "뮤직",
      neon: "네온",
      nitrate: "나이트레이트",
      nitrogen: "나이트로젠",
      nonane: "노네인",
      octane: "옥테인",
      orange: "오렌지",
      oxygen: "옥시전",
      phenol: "페놀",
      phosphate: "포스페이트",
      phosphorus: "포스퍼러스",
      piano: "피아노",
      pizza: "피자",
      potassium: "포타슘",
      propane: "프로페인",
      propanol: "프로판올",
      protein: "프로틴",
      radio: "라디오",
      robot: "로봇",
      sandwich: "샌드위치",
      secret: "시크릿",
      silicon: "실리콘",
      sodium: "소듐",
      sucrose: "수크로스",
      sulfate: "설페이트",
      sulfur: "설퍼",
      taxi: "택시",
      toluene: "톨루엔",
      water: "워터",
      xenon: "제논"
    })
  );

  const PHONETIC_PATTERNS = [
    ["eigh", "에이"],
    ["ough", "오"],
    ["augh", "오"],
    ["tion", "션"],
    ["sion", "션"],
    ["cial", "셜"],
    ["tial", "셜"],
    ["ph", "프"],
    ["ch", "치"],
    ["sh", "시"],
    ["th", "스"],
    ["ck", "크"],
    ["qu", "쿼"],
    ["xyl", "자일"],
    ["chem", "켐"],
    ["chl", "클"],
    ["chr", "크르"],
    ["sch", "스쿨"],
    ["ing", "잉"],
    ["ium", "이움"],
    ["ane", "에인"],
    ["ene", "엔"],
    ["yne", "아인"],
    ["ose", "오스"],
    ["ide", "아이드"],
    ["ate", "에이트"],
    ["ite", "아이트"],
    ["one", "온"],
    ["ol", "올"],
    ["oo", "우"],
    ["ee", "이"],
    ["ea", "이"],
    ["ai", "에이"],
    ["ay", "에이"],
    ["oa", "오"],
    ["ou", "아우"],
    ["ow", "오"],
    ["oi", "오이"],
    ["oy", "오이"],
    ["er", "어"],
    ["ir", "어"],
    ["ur", "어"],
    ["ar", "아"],
    ["or", "오"],
    ["le", "을"]
  ];

  const LETTER_READINGS = new Map(
    Object.entries({
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
    })
  );

  function isHangulSyllable(char) {
    if (!char) {
      return false;
    }
    const code = char.charCodeAt(0);
    return code >= HANGUL_BASE && code <= HANGUL_END;
  }

  function cleanHangul(value) {
    const normalized = String(value || "").normalize("NFC");
    return Array.from(normalized)
      .filter(isHangulSyllable)
      .join("");
  }

  function cleanEnglish(value) {
    return String(value || "").replace(/[^A-Za-z]/g, "");
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

  function getSearchStartSyllables(syllable) {
    return getAllowedStartSyllables(syllable);
  }

  function englishToHangul(value) {
    const word = cleanEnglish(value).toLowerCase();
    if (!word) {
      return "";
    }

    if (ENGLISH_OVERRIDES.has(word)) {
      return ENGLISH_OVERRIDES.get(word);
    }

    let result = "";
    let index = 0;
    while (index < word.length) {
      const matched = PHONETIC_PATTERNS.find(([pattern]) => word.startsWith(pattern, index));
      if (matched) {
        result += matched[1];
        index += matched[0].length;
        continue;
      }

      result += LETTER_READINGS.get(word[index]) || "";
      index += 1;
    }

    return result.replace(/으([bcdfghjklmnpqrstvwxyz])/g, "$1");
  }

  function toReading(value) {
    const compact = String(value || "").trim().replace(/\s+/g, "");
    if (/^[A-Za-z]+$/.test(compact)) {
      return englishToHangul(compact);
    }
    return cleanHangul(compact);
  }

  function parseDictionaryLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return null;
    }

    const withReading = trimmed.match(/^(.+?)(?:=|,|\t)(.+)$/);
    if (withReading) {
      return {
        word: withReading[1].trim(),
        reading: cleanHangul(withReading[2]),
        explicitReading: true
      };
    }

    const hunspell = trimmed.match(/^([^/\s]+)\//);
    return {
      word: (hunspell ? hunspell[1] : trimmed).trim(),
      reading: "",
      explicitReading: false
    };
  }

  function normalizeEntry(raw) {
    const word = String(raw.word || "").replace(/\s+/g, "");
    let language = "";
    let reading = raw.reading;

    if (BLOCKED_WORDS.has(word.toLowerCase()) || isCombinedHangulLetterName(word)) {
      return null;
    }

    if (/^[가-힣]+$/.test(word)) {
      language = "ko";
      reading = cleanHangul(word);
    } else if (/^[A-Za-z]+$/.test(word)) {
      language = "en";
      reading = reading || englishToHangul(word);
    }

    if (!language || !reading || reading.length < 2 || !/^[가-힣]+$/.test(reading)) {
      return null;
    }

    return {
      key: word.toLowerCase(),
      word,
      language,
      reading,
      explicitReading: raw.explicitReading,
      start: reading[0],
      end: reading[reading.length - 1],
      allowedAfter: [],
      followerCount: 0,
      oneShotReplyCount: 0,
      alternativeOneShotReplyCount: 0,
      killableFollowerCount: 0,
      alternativeOneShot: false,
      blunder: false,
      oneShot: false
    };
  }

  function isCombinedHangulLetterName(value) {
    const word = String(value || "").replace(/\s+/g, "");
    if (!word) {
      return false;
    }

    let index = 0;
    let count = 0;
    while (index < word.length) {
      const name = HANGUL_LETTER_NAMES.find((candidate) => word.startsWith(candidate, index));
      if (!name) {
        return false;
      }
      index += name.length;
      count += 1;
    }

    return count >= 2;
  }

  function parseDictionary(rawText) {
    const rows = String(rawText || "").split(/\r?\n/);
    const byWord = new Map();
    let invalid = 0;

    for (const row of rows) {
      const parsed = parseDictionaryLine(row);
      if (!parsed) {
        continue;
      }

      const entry = normalizeEntry(parsed);
      if (!entry) {
        invalid += 1;
        continue;
      }

      const existing = byWord.get(entry.key);
      if (!existing || (entry.explicitReading && !existing.explicitReading)) {
        byWord.set(entry.key, entry);
      }
    }

    for (const entry of Array.from(byWord.values())) {
      if (isConjugatedSurfaceEntry(entry, [byWord])) {
        byWord.delete(entry.key);
        invalid += 1;
      }
    }

    return {
      entries: Array.from(byWord.values()),
      byKey: byWord,
      invalid
    };
  }

  function isConjugatedSurfaceEntry(entry, lookupMaps) {
    if (!entry || entry.language !== "ko" || entry.word.length < 2) {
      return false;
    }
    if (SURFACE_FORM_EXCEPTIONS.has(entry.word)) {
      return false;
    }
    if (NON_WORD_SURFACE_FORMS.has(entry.word)) {
      return true;
    }

    if (entry.word.length >= 2 && hasEntryKey(`${entry.word}다`, lookupMaps)) {
      return true;
    }

    for (const lemma of getSurfaceFormLemmaKeys(entry.word)) {
      if (lemma !== entry.key && hasEntryKey(lemma, lookupMaps)) {
        return true;
      }
    }

    return false;
  }

  function getSurfaceFormLemmaKeys(word) {
    const candidates = new Set();
    const source = String(word || "");

    function addLemma(value) {
      const lemma = String(value || "").toLowerCase();
      if (lemma && lemma !== source.toLowerCase()) {
        candidates.add(lemma);
      }
    }

    function addSuffixLemma(suffix, lemmaSuffix) {
      if (!source.endsWith(suffix)) {
        return;
      }
      if (SHORT_SURFACE_FORM_SUFFIXES.has(suffix) && source.length <= suffix.length + 1) {
        return;
      }
      addLemma(`${source.slice(0, -suffix.length)}${lemmaSuffix}`);
    }

    for (const [suffix, lemmaSuffix] of SURFACE_FORM_LEMMA_SUFFIXES) {
      addSuffixLemma(suffix, lemmaSuffix);
    }

    if (source.endsWith("돼")) {
      addLemma(`${source.slice(0, -1)}되다`);
    }
    for (const suffix of ["어", "아", "여"]) {
      if (source.endsWith(suffix) && source.length > suffix.length) {
        addLemma(`${source.slice(0, -suffix.length)}다`);
      }
    }

    const last = source[source.length - 1];
    const info = decomposeSyllable(last);
    if (!info || info.trail !== 0) {
      return candidates;
    }

    const prefix = source.slice(0, -1);
    if (info.vowel === VOWEL_YEO) {
      addLemma(`${prefix}${composeSyllable(info.lead, VOWEL_I, 0)}다`);
    }
    if (info.vowel === VOWEL_WA) {
      addLemma(`${prefix}${composeSyllable(info.lead, VOWEL_O, 0)}다`);
    }
    if (info.vowel === VOWEL_WEO) {
      addLemma(`${prefix}${composeSyllable(info.lead, VOWEL_U, 0)}다`);
    }
    if ((info.vowel === VOWEL_A || info.vowel === VOWEL_EO) && info.lead !== IEUNG) {
      addLemma(`${prefix}${composeSyllable(info.lead, VOWEL_EU, 0)}다`);
    }
    if (source.endsWith("어") && source.length > 1) {
      const previous = source[source.length - 2];
      const previousInfo = decomposeSyllable(previous);
      if (previousInfo && previousInfo.trail === TRAILING_RIEUL) {
        addLemma(
          `${source.slice(0, -2)}${composeSyllable(
            previousInfo.lead,
            previousInfo.vowel,
            TRAILING_DIGEUT
          )}다`
        );
      }
    }
    if (
      (info.vowel === VOWEL_A || info.vowel === VOWEL_EO) &&
      info.lead === RIEUL &&
      source.length > 1
    ) {
      const previous = source[source.length - 2];
      const previousInfo = decomposeSyllable(previous);
      if (previousInfo && previousInfo.trail === TRAILING_RIEUL) {
        addLemma(
          `${source.slice(0, -2)}${composeSyllable(
            previousInfo.lead,
            previousInfo.vowel,
            0
          )}${composeSyllable(RIEUL, VOWEL_EU, 0)}다`
        );
      }
    }

    return candidates;
  }

  function hasEntryKey(key, lookupMaps) {
    const normalized = String(key || "").toLowerCase();
    return (lookupMaps || []).some((map) => map && map.has(normalized));
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

  function countByStarts(entry, starts, counts, includesSelf) {
    let count = 0;
    for (const start of starts) {
      count += counts.get(start) || 0;
    }

    if (includesSelf && starts.includes(entry.start)) {
      count -= 1;
    }

    return Math.max(0, count);
  }

  function countByAllowedStarts(entry, counts, includesSelf) {
    return countByStarts(entry, entry.allowedAfter || [], counts, includesSelf);
  }

  function countStarts(entries, predicate) {
    const counts = new Map();
    for (const entry of entries) {
      if (!predicate(entry)) {
        continue;
      }
      counts.set(entry.start, (counts.get(entry.start) || 0) + 1);
    }
    return counts;
  }

  function refreshDictionaryIndexes(dictionary, started) {
    const entries = dictionary.entries || [];
    const startedAt = typeof started === "number" ? started : now();
    const startCounts = new Map();
    const byStart = new Map();
    const byReading = new Map();
    let ko = 0;
    let en = 0;
    let oneShot = 0;
    let alternativeOneShot = 0;

    for (const entry of entries) {
      startCounts.set(entry.start, (startCounts.get(entry.start) || 0) + 1);
      const bucket = byStart.get(entry.start);
      if (bucket) {
        bucket.push(entry);
      } else {
        byStart.set(entry.start, [entry]);
      }
      const readingBucket = byReading.get(entry.reading);
      if (readingBucket) {
        readingBucket.push(entry);
      } else {
        byReading.set(entry.reading, [entry]);
      }
    }

    const oneShotStartCounts = new Map();
    for (const entry of entries) {
      if (!entry.allowedAfter || !entry.allowedAfter.length) {
        entry.allowedAfter = getAllowedStartSyllables(entry.end);
      }
      entry.followerCount = countByAllowedStarts(entry, startCounts, true);
      entry.oneShot = entry.followerCount === 0;
      entry.oneShotReplyCount = 0;
      entry.alternativeOneShotReplyCount = 0;
      entry.killableFollowerCount = 0;
      entry.alternativeOneShot = false;
      entry.blunder = false;
      if (entry.oneShot) {
        oneShot += 1;
        oneShotStartCounts.set(entry.start, (oneShotStartCounts.get(entry.start) || 0) + 1);
      }
      if (entry.language === "ko") {
        ko += 1;
      } else {
        en += 1;
      }
    }

    const killableStartCounts = new Map();
    for (const entry of entries) {
      entry.oneShotReplyCount = countByAllowedStarts(entry, oneShotStartCounts, entry.oneShot);
    }

    let changed = true;
    let remainingPasses = entries.length * 2 + 1;
    while (changed && remainingPasses > 0) {
      changed = false;
      remainingPasses -= 1;

      const alternativeOneShotStartCounts = countStarts(
        entries,
        (entry) => entry.alternativeOneShot
      );
      for (const entry of entries) {
        entry.alternativeOneShotReplyCount = countByAllowedStarts(
          entry,
          alternativeOneShotStartCounts,
          entry.alternativeOneShot
        );

        if (
          !entry.oneShot &&
          !entry.alternativeOneShot &&
          !entry.blunder &&
          (entry.oneShotReplyCount > 0 || entry.alternativeOneShotReplyCount > 0)
        ) {
          entry.blunder = true;
          changed = true;
        }
      }

      killableStartCounts.clear();
      for (const entry of entries) {
        if (entry.blunder) {
          killableStartCounts.set(entry.start, (killableStartCounts.get(entry.start) || 0) + 1);
        }
      }

      for (const entry of entries) {
        entry.killableFollowerCount = countByAllowedStarts(
          entry,
          killableStartCounts,
          entry.blunder
        );
        if (
          !entry.oneShot &&
          !entry.alternativeOneShot &&
          !entry.blunder &&
          entry.followerCount > 0 &&
          entry.killableFollowerCount === entry.followerCount
        ) {
          entry.alternativeOneShot = true;
          changed = true;
        }
      }
    }

    const alternativeOneShotStartCounts = countStarts(entries, (entry) => entry.alternativeOneShot);
    killableStartCounts.clear();
    for (const entry of entries) {
      if (entry.blunder) {
        killableStartCounts.set(entry.start, (killableStartCounts.get(entry.start) || 0) + 1);
      }
      if (entry.alternativeOneShot) {
        alternativeOneShot += 1;
      }
    }
    for (const entry of entries) {
      entry.alternativeOneShotReplyCount = countByAllowedStarts(
        entry,
        alternativeOneShotStartCounts,
        entry.alternativeOneShot
      );
      entry.killableFollowerCount = countByAllowedStarts(entry, killableStartCounts, entry.blunder);
    }

    dictionary.startCounts = startCounts;
    dictionary.byStart = byStart;
    dictionary.byReading = byReading;
    dictionary.stats = {
      total: entries.length,
      ko,
      en,
      oneShot,
      alternativeOneShot,
      invalid: dictionary.invalid || 0,
      buildMs: Math.round(now() - startedAt)
    };
    return dictionary;
  }

  function createDictionary(rawText) {
    const started = now();
    const parsed = parseDictionary(rawText);
    return refreshDictionaryIndexes(
      {
        entries: parsed.entries,
        byKey: parsed.byKey,
        byStart: new Map(),
        byReading: new Map(),
        invalid: parsed.invalid,
        startCounts: new Map(),
        stats: null
      },
      started
    );
  }

  function extendDictionary(dictionary, rawText) {
    if (!dictionary) {
      return createDictionary(rawText);
    }

    const started = now();
    const parsed = parseDictionary(rawText);
    const byKey = dictionary.byKey || new Map((dictionary.entries || []).map((entry) => [entry.key, entry]));
    let changed = false;

    for (const entry of parsed.entries) {
      if (isConjugatedSurfaceEntry(entry, [parsed.byKey, byKey])) {
        dictionary.invalid = (dictionary.invalid || 0) + 1;
        continue;
      }
      const existing = byKey.get(entry.key);
      if (!existing) {
        byKey.set(entry.key, entry);
        changed = true;
        continue;
      }
      if (entry.explicitReading && !existing.explicitReading) {
        byKey.set(entry.key, entry);
        changed = true;
      }
    }

    dictionary.invalid = (dictionary.invalid || 0) + parsed.invalid;
    dictionary.byKey = byKey;
    if (!changed && !parsed.invalid) {
      dictionary.stats = {
        ...(dictionary.stats || {}),
        buildMs: Math.round(now() - started)
      };
      return dictionary;
    }

    dictionary.entries = Array.from(byKey.values());
    return refreshDictionaryIndexes(dictionary, started);
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

  function collectResults(
    candidates,
    oneShotOnly,
    pageSize,
    page,
    exactWord,
    exactReading,
    dictionary,
    options
  ) {
    const oneShots = [];
    const alternatives = [];
    const blunders = [];
    const safeConnections = [];
    let total = 0;
    const useStaticState =
      options &&
      options.usedKeySet &&
      options.usedKeySet.size &&
      candidates.length >= LARGE_DYNAMIC_RECALC_THRESHOLD;

    for (const entry of candidates) {
      const resultEntry = useStaticState ? entry : getSearchEntryState(dictionary, entry, options);
      total += 1;
      if (resultEntry.oneShot) {
        oneShots.push(resultEntry);
      } else if (resultEntry.alternativeOneShot) {
        alternatives.push(resultEntry);
      } else if (resultEntry.blunder) {
        blunders.push(resultEntry);
      } else {
        safeConnections.push(resultEntry);
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
    const requestedSize = Math.floor(Number(pageSize)) || DEFAULT_LIMIT;
    const requestedPage = Math.floor(Number(page)) || 1;
    const size = Math.max(1, requestedSize);
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
      const leftFollowers = Number(left.followerCount) || 0;
      const rightFollowers = Number(right.followerCount) || 0;
      if (leftFollowers !== rightFollowers) {
        return leftFollowers - rightFollowers;
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
    return Boolean(entry && !entry.oneShot && !entry.alternativeOneShot && !entry.blunder);
  }

  function isExactQueryMatch(entry, exactWord, exactReading) {
    return (
      (exactWord && entry.key === exactWord) ||
      (exactReading && entry.reading === exactReading)
    );
  }

  function createUsedKeySet(dictionary, usedKeys) {
    if (!Array.isArray(usedKeys) || !usedKeys.length || !dictionary || !dictionary.byKey) {
      return new Set();
    }
    const result = new Set();
    for (const rawKey of usedKeys) {
      const key = String(rawKey || "").trim().toLowerCase();
      if (key && dictionary.byKey.has(key)) {
        result.add(key);
      }
    }
    return result;
  }

  function isUsedEntry(entry, options) {
    return Boolean(entry && options && options.usedKeySet && options.usedKeySet.has(entry.key));
  }

  function createPlayedOptions(options, entry) {
    if (!entry || !entry.key || isUsedEntry(entry, options)) {
      return options;
    }
    const usedKeySet = new Set((options && options.usedKeySet) || []);
    usedKeySet.add(entry.key);
    return {
      ...(options || {}),
      usedKeySet,
      stateCache: new Map(),
      followerCountCache: new Map(),
      oneShotCounterCache: new Map()
    };
  }

  function getAvailableFollowerCount(dictionary, entry, options) {
    if (!options || !options.usedKeySet || !options.usedKeySet.size) {
      return Number(entry && entry.followerCount) || 0;
    }
    if (!options.followerCountCache) {
      options.followerCountCache = new Map();
    }
    if (options.followerCountCache.has(entry.key)) {
      return options.followerCountCache.get(entry.key);
    }

    let count = 0;
    const seen = new Set();
    for (const start of entry.allowedAfter || []) {
      const bucket = dictionary.byStart.get(start) || [];
      for (const reply of bucket) {
        if (reply.key === entry.key || seen.has(reply.key) || isUsedEntry(reply, options)) {
          continue;
        }
        seen.add(reply.key);
        count += 1;
      }
    }
    options.followerCountCache.set(entry.key, count);
    return count;
  }

  function getOneShotCounterEntries(dictionary, entry, options) {
    if (!options.oneShotCounterCache) {
      options.oneShotCounterCache = new Map();
    }
    if (options.oneShotCounterCache.has(entry.key)) {
      return options.oneShotCounterCache.get(entry.key);
    }

    const replies = [];
    const seen = new Set();
    for (const start of entry.allowedAfter || []) {
      const bucket = dictionary.byStart.get(start) || [];
      for (const reply of bucket) {
        if (reply.key === entry.key || seen.has(reply.key) || isUsedEntry(reply, options)) {
          continue;
        }
        seen.add(reply.key);
        if (getAvailableFollowerCount(dictionary, reply, options) === 0) {
          replies.push(reply);
        }
      }
    }
    replies.sort(compareReading);
    options.oneShotCounterCache.set(entry.key, replies);
    return replies;
  }

  function getSearchEntryState(dictionary, entry, options) {
    if (!entry || !options || !options.usedKeySet || !options.usedKeySet.size) {
      return entry;
    }
    if (!options.stateCache) {
      options.stateCache = new Map();
    }
    if (options.stateCache.has(entry.key)) {
      return options.stateCache.get(entry.key);
    }

    const followerCount = getAvailableFollowerCount(dictionary, entry, options);
    const replyOptions = createPlayedOptions(options, entry);
    const oneShotReplyCount = getOneShotCounterEntries(dictionary, entry, replyOptions).length;
    const state = {
      ...entry,
      followerCount,
      oneShot: followerCount === 0,
      alternativeOneShot: false,
      alternativeOneShotReplyCount: 0,
      oneShotReplyCount,
      blunder: followerCount > 0 && oneShotReplyCount > 0
    };
    options.stateCache.set(entry.key, state);
    return state;
  }

  function getCounterReplyWords(dictionary, entry, predicate, options) {
    if (!entry.blunder) {
      return [];
    }

    const replyOptions = createPlayedOptions(options, entry);
    const replies = [];
    const seen = new Set();
    for (const start of entry.allowedAfter) {
      const bucket = dictionary.byStart.get(start) || [];
      for (const reply of bucket) {
        if (replies.length >= MAX_COUNTER_REPLY_WORDS) {
          break;
        }
        if (reply.key === entry.key || seen.has(reply.key) || isUsedEntry(reply, replyOptions)) {
          continue;
        }
        const replyState = getSearchEntryState(dictionary, reply, replyOptions);
        if (!predicate(replyState)) {
          continue;
        }
        seen.add(reply.key);
        replies.push(replyState);
      }
      if (replies.length >= MAX_COUNTER_REPLY_WORDS) {
        break;
      }
    }

    return replies.sort(compareReading).map((reply) => reply.word);
  }

  function getOneShotReplyWords(dictionary, entry, options) {
    return getCounterReplyWords(dictionary, entry, isOneShotReply, options);
  }

  function getAlternativeOneShotReplyWords(dictionary, entry, options) {
    return getCounterReplyWords(dictionary, entry, isAlternativeOneShotReply, options);
  }

  function isOneShotReply(entry) {
    return Boolean(entry && entry.oneShot);
  }

  function isAlternativeOneShotReply(entry) {
    return Boolean(entry && entry.alternativeOneShot);
  }

  function createSearchResultEntry(dictionary, entry, options) {
    return {
      ...entry,
      oneShotReplyWords: getOneShotReplyWords(dictionary, entry, options),
      alternativeOneShotReplyWords: getAlternativeOneShotReplyWords(dictionary, entry, options)
    };
  }

  function searchByPrefix(dictionary, prefix, options) {
    if (!prefix) {
      const exactCandidates = includeExactCandidates(dictionary, [], options);
      return exactCandidates.length
        ? collectResults(
            exactCandidates,
            options.oneShotOnly,
            options.pageSize,
            options.page,
            options.exactWord,
            options.exactReading,
            dictionary,
            options
          )
        : createEmptyResults(options.pageSize, options.page);
    }

    const bucket = dictionary.byStart.get(prefix[0]) || [];
    if (prefix.length === 1) {
      return collectResults(
        includeExactCandidates(dictionary, bucket, options),
        options.oneShotOnly,
        options.pageSize,
        options.page,
        options.exactWord,
        options.exactReading,
        dictionary,
        options
      );
    }

    return collectResults(
      includeExactCandidates(
        dictionary,
        bucket.filter((entry) => entry.reading.startsWith(prefix)),
        options
      ),
      options.oneShotOnly,
      options.pageSize,
      options.page,
      options.exactWord,
      options.exactReading,
      dictionary,
      options
    );
  }

  function searchByPrefixes(dictionary, prefixes, options) {
    const uniquePrefixes = Array.from(new Set(prefixes.filter(Boolean)));
    if (!uniquePrefixes.length) {
      const exactCandidates = includeExactCandidates(dictionary, [], options);
      return exactCandidates.length
        ? collectResults(
            exactCandidates,
            options.oneShotOnly,
            options.pageSize,
            options.page,
            options.exactWord,
            options.exactReading,
            dictionary,
            options
          )
        : createEmptyResults(options.pageSize, options.page);
    }

    if (uniquePrefixes.length === 1) {
      return searchByPrefix(dictionary, uniquePrefixes[0], options);
    }

    const candidates = [];
    const seen = new Set();
    for (const prefix of uniquePrefixes) {
      const bucket = dictionary.byStart.get(prefix[0]) || [];
      for (const entry of bucket) {
        if (!entry.reading.startsWith(prefix) || seen.has(entry.key)) {
          continue;
        }
        seen.add(entry.key);
        candidates.push(entry);
      }
    }

    return collectResults(
      includeExactCandidates(dictionary, candidates, options),
      options.oneShotOnly,
      options.pageSize,
      options.page,
      options.exactWord,
      options.exactReading,
      dictionary,
      options
    );
  }

  function searchByReply(dictionary, starts, options) {
    const candidates = [];
    const seen = new Set();

    for (const start of starts) {
      const bucket = dictionary.byStart.get(start) || [];
      for (const entry of bucket) {
        if (!seen.has(entry.key)) {
          seen.add(entry.key);
          candidates.push(entry);
        }
      }
    }

    return collectResults(
      includeExactCandidates(dictionary, candidates, options),
      options.oneShotOnly,
      options.pageSize,
      options.page,
      options.exactWord,
      options.exactReading,
      dictionary,
      options
    );
  }

  function includeExactCandidates(dictionary, candidates, options) {
    const exactEntries = getExactQueryEntries(dictionary, options);
    if (!exactEntries.length) {
      return candidates;
    }

    const seen = new Set(candidates.map((entry) => entry.key));
    const merged = candidates.slice();
    for (const entry of exactEntries) {
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        merged.push(entry);
      }
    }
    return merged;
  }

  function getExactQueryEntries(dictionary, options) {
    const exactWord = options && options.exactWord;
    const exactReading = options && options.exactReading;
    if (!exactWord && !exactReading) {
      return [];
    }

    const entries = [];
    const seen = new Set();
    if (exactWord && dictionary.byKey) {
      const entry = dictionary.byKey.get(exactWord);
      if (entry) {
        entries.push(entry);
        seen.add(entry.key);
      }
    }

    if (exactReading && dictionary.byReading) {
      const readingEntries = dictionary.byReading.get(exactReading) || [];
      for (const entry of readingEntries) {
        if (!seen.has(entry.key)) {
          seen.add(entry.key);
          entries.push(entry);
        }
      }
    }

    return entries;
  }

  function searchDictionary(dictionary, options) {
    const started = now();
    const pageSize = Number(options.pageSize || options.limit || DEFAULT_LIMIT);
    const page = Number(options.page || 1);
    const queryInfo = getQueryInfo(options.query, options.sourceMode);
    const exactWord = String(options.query || "").trim().replace(/\s+/g, "").toLowerCase();
    const exactReading = queryInfo.reading;
    const oneShotOnly = Boolean(options.oneShotOnly);
    const sourceMode = options.sourceMode === "reply" ? "reply" : "starts";
    const searchOptions = {
      oneShotOnly,
      pageSize,
      page,
      exactWord,
      exactReading,
      usedKeySet: createUsedKeySet(dictionary, options.usedKeys)
    };
    const collected =
      sourceMode === "reply"
        ? searchByReply(dictionary, queryInfo.starts, searchOptions)
        : searchByPrefixes(dictionary, queryInfo.prefixes, searchOptions);

    return {
      queryInfo,
      total: collected.total,
      categoryCounts: collected.categoryCounts,
      limit: collected.pageSize,
      page: collected.page,
      pageSize: collected.pageSize,
      pageCount: collected.pageCount,
      results: collected.results.map((entry) => createSearchResultEntry(dictionary, entry, searchOptions)),
      elapsedMs: Math.round((now() - started) * 10) / 10
    };
  }

  function selectOnlineWords(dictionary, words, target, lookup) {
    const candidates = getOnlineCandidateEntries(dictionary, words, lookup);
    return candidates.map((entry) => entry.word);
  }

  function getOnlineCandidateEntries(dictionary, words, lookup) {
    const parsed = parseDictionary(uniqueTextLines(words).join("\n"));
    const existing = dictionary.byKey || new Map((dictionary.entries || []).map((entry) => [entry.key, entry]));
    return parsed.entries.filter(
      (entry) =>
        !existing.has(entry.key) &&
        !isConjugatedSurfaceEntry(entry, [parsed.byKey, existing]) &&
        ((lookup && lookup.includeSupplementWords) || matchesLookupEntry(entry, lookup))
    );
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
    const exactKey = String((lookup && lookup.exactWord) || "").trim().replace(/\s+/g, "").toLowerCase();
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

  function now() {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  return {
    __factory: createCore,
    FALLBACK_DICTIONARY,
    cleanHangul,
    createDictionary,
    englishToHangul,
    extendDictionary,
    getAllowedStartSyllables,
    getQueryInfo,
    getSearchPrefixes,
    isCombinedHangulLetterName,
    searchDictionary,
    selectOnlineWords,
    toReading
  };
});

function initApp(core) {
  "use strict";

  const CUSTOM_STORAGE_KEY = "kkung-custom-dictionary-v2";
  const ONLINE_STORAGE_KEY = "kkung-online-dictionary-v8";
  const USED_WORDS_STORAGE_KEY = "kkung-used-words-v1";
  const USED_WORD_CONTROLS_STORAGE_KEY = "kkung-used-word-controls-v1";
  const OPENDICT_API_KEY_SESSION_STORAGE_KEY = "kkung-opendict-api-key-session-v1";
  const ONLINE_PREFIX_CACHE_STORAGE_KEY = "kkung-online-prefix-cache-v16";
  const ONLINE_ONESHOT_PRELOAD_STORAGE_KEY = "kkung-online-oneshot-preload-v3";
  const OPENDICT_SEARCH_ENDPOINT = "https://opendict.korean.go.kr/api/search";
  const OPENDICT_PROXY_ENDPOINT = "api/opendict/search";
  const WORDROW_START_ENDPOINT = "https://wordrow.kr/%EC%8B%9C%EC%9E%91%ED%95%98%EB%8A%94-%EB%A7%90/";
  const WORDROW_MEANING_ENDPOINT = "https://wordrow.kr/%EC%9D%98%EB%AF%B8/";
  const WORDROW_ONESHOT_ENDPOINT = "https://wordrow.kr/%EC%8B%9C%EC%9E%91%ED%95%98%EB%8A%94-%EB%A7%90/%EB%AA%A8%EB%93%A0-%ED%95%9C%EA%B8%80-%EB%8B%A8%EC%96%B4%EC%9D%98-%EC%8B%9C%EC%9E%91%EA%B3%BC-%EB%81%9D/";
  const WORDROW_READER_ENDPOINTS = [
    "https://r.jina.ai/http://",
    "https://r.jina.ai/http://r.jina.ai/http://"
  ];
  const ONLINE_LOOKUP_ENDPOINT = "https://ko.wiktionary.org/w/api.php";
  const ONLINE_LOOKUP_LIMIT = 500;
  const ONLINE_LOOKUP_MAX_REQUESTS = 6;
  const ONLINE_VERIFY_BATCH_SIZE = 40;
  const ONLINE_CACHE_MAX_WORDS = 20000;
  const ONLINE_PREFIX_CACHE_MAX = 512;
  const ONLINE_NORMAL_PREFIX_WORD_LIMIT = 1000;
  const ONLINE_ONESHOT_PREFIX_WORD_LIMIT = 3000;
  const ONLINE_ONESHOT_VERIFY_CANDIDATE_LIMIT = 80;
  const ONLINE_ONESHOT_VERIFY_PREFIX_LIMIT = 80;
  const ONLINE_ONESHOT_VERIFY_WORD_LIMIT = 120;
  const ONLINE_ONESHOT_VERIFY_BATCH_SIZE = 6;
  const ONLINE_ONESHOT_VERIFY_DEPTH = 2;
  const ONLINE_PREFIX_CACHE_WORD_LIMIT = 3000;
  const OPENDICT_PREFIX_WORD_LIMIT = 100;
  const OPENDICT_ONESHOT_PREFIX_WORD_LIMIT = 500;
  const OPENDICT_EXACT_WORD_LIMIT = 20;
  const ONLINE_ONESHOT_PRELOAD_WORD_LIMIT = 3000;
  const ONLINE_ONESHOT_PRELOAD_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const ONLINE_ONESHOT_EXACT_PRELOAD_WORDS = ["해질녘", "과일쨤", "다래쨤", "과실쨤", "치마긶"];
  const ONLINE_WORDROW_FETCH_TIMEOUT_MS = 4500;
  const ONLINE_API_FETCH_TIMEOUT_MS = 5500;
  const WORDROW_WORD_LIMIT = 3000;
  const WORDROW_WIKTIONARY_MERGE_THRESHOLD = 40;
  const ONLINE_PREFIX_CACHE_SAVE_DELAY = 350;
  const RESULT_PAGE_SIZE = 50;
  const TABLET_RESULT_PAGE_SIZE = 40;
  const MOBILE_RESULT_PAGE_SIZE = 25;
  const ONE_SHOT_RESULT_PAGE_SIZE = 120;
  const SEARCH_WATCHDOG_MS = 8000;
  const REQUIRED_SUPPLEMENT_WORDS = ["킷값"];
  const DICTIONARY_DRAWER_QUERY = "(max-width: 1180px)";
  const MOBILE_QUERY = "(max-width: 780px)";
  const elements = {
    allowedPreview: document.getElementById("allowedPreview"),
    applyDictionary: document.getElementById("applyDictionary"),
    buildState: document.getElementById("buildState"),
    closeDictionary: document.getElementById("closeDictionary"),
    customDictionary: document.getElementById("customDictionary"),
    defaultSourceMeta: document.getElementById("defaultSourceMeta"),
    dictionaryPanel: document.getElementById("dictionaryPanel"),
    dictionaryState: document.getElementById("dictionaryState"),
    fileInput: document.getElementById("fileInput"),
    fileState: document.getElementById("fileState"),
    guildSearch: document.getElementById("guildSearch"),
    guildSettings: document.getElementById("guildSettings"),
    invalidPreview: document.getElementById("invalidPreview"),
    oneShotOnly: document.getElementById("oneShotOnly"),
    panelBackdrop: document.getElementById("panelBackdrop"),
    queryInput: document.getElementById("queryInput"),
    readingPreview: document.getElementById("readingPreview"),
    resetDictionary: document.getElementById("resetDictionary"),
    resetUsedWords: document.getElementById("resetUsedWords"),
    resultPager: document.getElementById("resultPager"),
    resultList: document.getElementById("resultList"),
    resultMeta: document.getElementById("resultMeta"),
    searchButton: document.getElementById("searchButton"),
    searchChannel: document.getElementById("searchChannel"),
    settingsLanguage: document.getElementById("settingsLanguage"),
    settingsOneShotOnly: document.getElementById("settingsOneShotOnly"),
    settingsSearch: document.getElementById("settingsSearch"),
    statEn: document.getElementById("statEn"),
    statKo: document.getElementById("statKo"),
    statAlt: document.getElementById("statAlt"),
    statOneShot: document.getElementById("statOneShot"),
    statTotal: document.getElementById("statTotal"),
    toggleDictionary: document.getElementById("toggleDictionary"),
    backToTop: document.getElementById("backToTop")
  };

  const defaultDictionaryTextUrl = new URL(
    "./data/default-dictionary.txt?v=offline-text-pack-20260617",
    window.location.href
  ).toString();
  const defaultDictionaryMetaUrl = new URL(
    "./data/default-dictionary-meta.json?v=offline-text-pack-20260617",
    window.location.href
  ).toString();
  const defaultDictionaryScriptUrl = new URL(
    "./data/default-dictionary.js?v=offline-woorimalsam-20260617",
    window.location.href
  ).toString();
  const fallbackDefaultText = core.FALLBACK_DICTIONARY;
  const defaultMeta = window.KKUNG_DEFAULT_DICTIONARY_META || {
    korean: 0,
    english: 0,
    sources: ["fallback"]
  };
  const initialOnlineText = readLocalStorage(ONLINE_STORAGE_KEY, "");
  const initialOnlineWords = parseOnlineWords(initialOnlineText);

  const state = {
    dictionary: null,
    fileText: "",
    fileName: "",
    onlineText: initialOnlineWords.join("\n"),
    onlineWords: initialOnlineWords,
    onlineWordSet: new Set(initialOnlineWords.map((word) => word.toLowerCase())),
    onlineAttempts: new Set(),
    onlineMisses: new Set(),
    onlineAbortController: null,
    onlinePrefixCache: loadOnlinePrefixCache(),
    onlinePrefixRequests: new Map(),
    onlinePrefixSaveTimer: 0,
    onlineOneShotPreloadMeta: loadOnlineOneShotPreloadMeta(),
    onlineOneShotPreloadId: 0,
    onlineOneShotPreloadStarted: false,
    onlineLookupId: 0,
    onlineStatus: "",
    opendictStatus: "",
    opendictProxyUnavailable: false,
    page: 1,
    requestId: 0,
    searchRequestId: 0,
    searchTimer: 0,
    searchWatchdogTimer: 0,
    searchInFlight: false,
    pendingSearch: false,
    observedQuery: "",
    showUsedControls: true,
    sourceMode: "starts",
    usedWordKeys: loadUsedWordKeys(),
    worker: createSearchWorker(core, {
      textUrl: defaultDictionaryTextUrl,
      metaUrl: defaultDictionaryMetaUrl,
      scriptUrl: defaultDictionaryScriptUrl,
      fallbackText: fallbackDefaultText
    }),
    workerReady: false
  };
  const dictionaryDrawerMedia = window.matchMedia(DICTIONARY_DRAWER_QUERY);
  const mobileMedia = window.matchMedia(MOBILE_QUERY);

  elements.customDictionary.value = readLocalStorage(CUSTOM_STORAGE_KEY, "");
  syncSettingsControls();
  elements.defaultSourceMeta.textContent =
    `KO ${formatNumber(defaultMeta.korean)} / EN ${formatNumber(defaultMeta.english)} / 추가 ${formatNumber(defaultMeta.extra)}`;
  elements.defaultSourceMeta.textContent = "오프라인 단어팩 로딩";
  updateOnlineState();
  updateOpendictState();

  attachWorkerHandlers(state.worker);

  function attachWorkerHandlers(worker) {
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerError;
    worker.onmessageerror = handleWorkerMessageError;
  }

  function handleWorkerMessage(event) {
    const message = event.data;
    if (message.type === "built") {
      state.workerReady = true;
      state.searchInFlight = false;
      clearSearchWatchdog();
      if (message.defaultMeta) {
        elements.defaultSourceMeta.textContent =
          `KO ${formatNumber(message.defaultMeta.korean)} / EN ${formatNumber(message.defaultMeta.english)} / 추가 ${formatNumber(message.defaultMeta.extra)}`;
      }
      updateStats(message.stats);
      setBusy(false, `인덱스 ${formatMs(message.stats.buildMs)}`);
      if (state.pendingSearch || String(elements.queryInput.value || "").trim()) {
        scheduleSearch(0);
      }
      return;
    }

    if (message.type === "searchResult") {
      if (message.id !== state.searchRequestId) {
        return;
      }
      clearSearchWatchdog();
      state.searchInFlight = false;
      const currentQuery = String(elements.queryInput.value || "").trim();
      const currentReading = core.toReading(currentQuery);
      const resultReading = message.payload && message.payload.queryInfo ? message.payload.queryInfo.reading || "" : "";
      if (!currentQuery) {
        state.pendingSearch = false;
        renderStartScreen();
        return;
      }
      if (state.pendingSearch || currentReading !== resultReading) {
        renderPendingSearch(currentQuery);
        scheduleSearch(0, currentReading !== resultReading);
        return;
      }
      renderSearch(message.payload);
      if (state.pendingSearch) {
        scheduleSearch(0);
      }
      return;
    }

    if (message.type === "onlineAppendResult") {
      handleOnlineAppendResult(message);
      return;
    }

    if (message.type === "error") {
      if (recoverSearchWorker(message.message)) {
        return;
      }
      clearSearchWatchdog();
      state.searchInFlight = false;
      setBusy(false, "오류");
      renderEmpty(message.message || "처리 중 오류가 났습니다");
    }
  }

  function handleWorkerError(event) {
    if (recoverSearchWorker(event && event.message)) {
      return;
    }
    state.workerReady = false;
    state.searchInFlight = false;
    clearSearchWatchdog();
    state.pendingSearch = false;
    setBusy(false, "검색 오류");
    const message = event && event.message ? event.message : "검색 엔진을 시작하지 못했습니다";
    renderEmpty(message);
  }

  function handleWorkerMessageError() {
    if (recoverSearchWorker("worker message error")) {
      return;
    }
    state.workerReady = false;
    state.searchInFlight = false;
    clearSearchWatchdog();
    state.pendingSearch = false;
    setBusy(false, "검색 오류");
    renderEmpty("검색 결과를 읽지 못했습니다");
  }

  function recoverSearchWorker(reason) {
    if (state.worker && state.worker.__isInlineFallback) {
      return false;
    }
    if (state.worker && typeof state.worker.terminate === "function") {
      state.worker.terminate();
    }

    state.worker = createInlineWorkerFallback(core, {
      textUrl: defaultDictionaryTextUrl,
      metaUrl: defaultDictionaryMetaUrl,
      fallbackText: fallbackDefaultText
    });
    attachWorkerHandlers(state.worker);
    state.workerReady = false;
    state.searchInFlight = false;
    clearSearchWatchdog();
    state.pendingSearch = true;
    state.page = 1;
    setBusy(true, "검색 엔진 복구중");
    renderEmpty("검색 엔진을 다시 시작하고 있습니다");
    rebuildDictionary();
    return true;
  }

  document.querySelectorAll("[data-source-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setSourceMode(button.dataset.sourceMode, true);
    });
  });

  document.querySelectorAll("[data-focus-dictionary]").forEach((button) => {
    button.addEventListener("click", openSettingsPanel);
  });

  document.querySelectorAll("[data-search-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      setDictionaryPanelOpen(false);
      setGuildSelection(false);
      elements.queryInput.focus();
    });
  });

  elements.toggleDictionary.addEventListener("click", () => {
    setDictionaryPanelOpen(!elements.dictionaryPanel.classList.contains("open"));
  });
  elements.closeDictionary.addEventListener("click", () => setDictionaryPanelOpen(false));
  elements.panelBackdrop.addEventListener("click", () => setDictionaryPanelOpen(false));
  elements.searchButton.addEventListener("click", () => {
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(0, true);
  });
  elements.queryInput.addEventListener("compositionstart", () => {
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(80, true);
  });
  elements.queryInput.addEventListener("compositionend", () => {
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(0, true);
  });
  elements.queryInput.addEventListener("blur", () => {
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(0, true);
  });
  elements.queryInput.addEventListener("input", () => {
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(80, true);
  });
  elements.queryInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    state.observedQuery = elements.queryInput.value;
    scheduleSearch(0, true);
    if (mobileMedia.matches) {
      elements.queryInput.blur();
    }
  });
  elements.oneShotOnly.addEventListener("change", () => {
    setOneShotOnly(elements.oneShotOnly.checked, true);
  });
  if (elements.settingsOneShotOnly) {
    elements.settingsOneShotOnly.addEventListener("change", () => {
      setOneShotOnly(elements.settingsOneShotOnly.checked, true);
    });
  }
  if (elements.settingsSearch) {
    elements.settingsSearch.addEventListener("input", filterSettings);
  }
  if (elements.resetUsedWords) {
    elements.resetUsedWords.addEventListener("click", () => {
      state.usedWordKeys.clear();
      saveUsedWordKeys();
      scheduleSearch(0, true);
    });
  }
  elements.resultPager.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button) {
      return;
    }
    setResultPage(Number(button.dataset.page));
  });
  elements.resultList.addEventListener("scroll", updateBackToTop);
  elements.backToTop.addEventListener("click", () => {
    animateResultListToTop();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setDictionaryPanelOpen(false);
    }
  });
  addMediaListener(dictionaryDrawerMedia, (event) => {
    if (!event.matches) {
      setDictionaryPanelOpen(false);
    }
  });
  addMediaListener(mobileMedia, () => scheduleSearch(0, true));

  elements.applyDictionary.addEventListener("click", () => {
    writeLocalStorage(CUSTOM_STORAGE_KEY, elements.customDictionary.value);
    rebuildDictionary();
  });

  elements.resetDictionary.addEventListener("click", () => {
    elements.customDictionary.value = "";
    elements.fileInput.value = "";
    state.fileText = "";
    state.fileName = "";
    state.onlineText = "";
    state.onlineWords = [];
    state.onlineWordSet = new Set();
    state.onlineAttempts.clear();
    state.onlineMisses.clear();
    state.onlinePrefixCache.clear();
    state.onlinePrefixRequests.clear();
    state.onlineOneShotPreloadMeta = { checkedAt: 0, count: 0 };
    state.onlineOneShotPreloadId += 1;
    state.onlineOneShotPreloadStarted = false;
    state.opendictProxyUnavailable = false;
    state.usedWordKeys.clear();
    abortOnlineLookup();
    window.clearTimeout(state.onlinePrefixSaveTimer);
    [
      CUSTOM_STORAGE_KEY,
      ONLINE_STORAGE_KEY,
      ONLINE_PREFIX_CACHE_STORAGE_KEY,
      ONLINE_ONESHOT_PRELOAD_STORAGE_KEY,
      USED_WORDS_STORAGE_KEY
    ].forEach(removeLocalStorage);
    elements.fileState.textContent = "없음";
    updateOnlineState();
    rebuildDictionary();
  });

  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files && elements.fileInput.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    setBusy(true, "파일 읽는중");
    reader.addEventListener("load", () => {
      state.fileText = String(reader.result || "");
      state.fileName = file.name;
      elements.fileState.textContent = `${file.name} (${formatNumber(file.size)}B)`;
      rebuildDictionary();
    });
    reader.addEventListener("error", () => {
      setBusy(false, "파일 오류");
      elements.fileState.textContent = "읽기 실패";
    });
    reader.readAsText(file, "utf-8");
  });

  renderEmpty("단어장 인덱스를 만들고 있습니다");
  rebuildDictionary();
  window.setInterval(() => {
    const currentQuery = elements.queryInput.value;
    const currentReading = core.toReading(currentQuery);
    const renderedReading = elements.readingPreview.textContent;
    if (
      currentQuery === state.observedQuery &&
      (!currentReading || renderedReading === currentReading || state.pendingSearch)
    ) {
      return;
    }
    state.observedQuery = currentQuery;
    scheduleSearch(80, true);
  }, 150);

  function rebuildDictionary() {
    abortOnlineLookup();
    clearSearchWatchdog();
    const extraText = [REQUIRED_SUPPLEMENT_WORDS.join("\n"), elements.customDictionary.value, state.fileText, state.onlineText]
      .filter(Boolean)
      .join("\n");
    state.workerReady = false;
    state.searchInFlight = false;
    state.page = 1;
    state.searchRequestId = 0;
    state.pendingSearch = true;
    setBusy(true, "인덱스 생성중");
    state.worker.postMessage({
      type: "buildDefault",
      id: ++state.requestId,
      extraText
    });
  }

  function appendOnlineCandidates(words, lookup) {
    if (!Array.isArray(words) || !words.length) {
      return;
    }

    const isPreload = Boolean(lookup && lookup.preload);
    if (!isPreload) {
      state.workerReady = false;
      state.searchInFlight = false;
      clearSearchWatchdog();
      state.page = 1;
      setBusy(true, "검색중...");
    } else {
      updateOnlineState("한방 반영중");
    }
    state.worker.postMessage({
      type: "appendOnlineCandidates",
      id: ++state.requestId,
      words,
      target: lookup.target,
      lookup: {
        mode: lookup.mode,
        prefixes: lookup.prefixes,
        exactWord: lookup.exactWord,
        query: lookup.query,
        oneShotOnly: lookup.oneShotOnly,
        wasEmpty: lookup.wasEmpty,
        attemptKey: lookup.attemptKey,
        preload: isPreload,
        candidateCount: Number(lookup.candidateCount) || words.length
      }
    });
  }

  function handleOnlineAppendResult(message) {
    state.workerReady = true;
    if (message.stats) {
      updateStats(message.stats);
    }

    const selectedWords = Array.isArray(message.words) ? message.words : [];
    const isPreload = Boolean(message.lookup && message.lookup.preload);
    if (!selectedWords.length) {
      if (isPreload) {
        updateOnlineState((message.lookup && message.lookup.candidateCount) ? "한방 준비됨" : "한방 미발견");
        scheduleSearch(0);
        return;
      }
      if (message.lookup && message.lookup.candidateCount) {
        setBusy(false, "검색 완료");
        updateOnlineState("이미 저장됨");
        scheduleSearch(0);
        return;
      }
      setBusy(false, "검색 완료");
      updateOnlineState("미발견");
      markOnlineLookupMiss(message.lookup || {});
      return;
    }

    const onlineUpdate = addOnlineWords(selectedWords);
    if (!onlineUpdate.additions.length) {
      if (isPreload) {
        updateOnlineState("한방 준비됨");
        scheduleSearch(0);
        return;
      }
      setBusy(false, "검색 완료");
      updateOnlineState("이미 저장됨");
      scheduleSearch(0);
      return;
    }

    updateOnlineState(
      isPreload
        ? `${formatNumber(onlineUpdate.additions.length)}개 한방 추가`
        : `${formatNumber(onlineUpdate.additions.length)}개 추가`
    );
    if (onlineUpdate.evictedCount) {
      rebuildDictionary();
      return;
    }

    if (!isPreload) {
      setBusy(false, `인덱스 ${formatMs(message.stats && message.stats.buildMs)}`);
    } else {
      elements.buildState.textContent = "한방 준비됨";
    }
    scheduleSearch(0);
  }

  function scheduleSearch(delay, resetPage) {
    if (resetPage) {
      state.page = 1;
      animateResultListToTop();
    }
    state.pendingSearch = true;
    const query = String(elements.queryInput.value || "").trim();
    if (query) {
      renderPendingSearch(query);
    } else if (state.workerReady) {
      renderStartScreen();
    }
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(runSearch, delay);
  }

  function runSearch() {
    const query = String(elements.queryInput.value || "").trim();
    if (!query) {
      state.pendingSearch = false;
      state.searchInFlight = false;
      state.searchRequestId = 0;
      clearSearchWatchdog();
      renderStartScreen();
      return;
    }
    if (!state.workerReady) {
      state.pendingSearch = true;
      return;
    }
    if (state.searchInFlight) {
      state.pendingSearch = true;
      return;
    }

    state.pendingSearch = false;
    const requestId = ++state.requestId;
    state.searchRequestId = requestId;
    state.searchInFlight = true;
    startSearchWatchdog(requestId);
    state.worker.postMessage({
      type: "search",
      id: requestId,
      options: {
        query,
        sourceMode: state.sourceMode,
        oneShotOnly: elements.oneShotOnly.checked,
        usedKeys: Array.from(state.usedWordKeys),
        page: state.page,
        pageSize: getPageSize()
      }
    });
  }

  function startSearchWatchdog(requestId) {
    clearSearchWatchdog();
    state.searchWatchdogTimer = window.setTimeout(() => {
      if (!state.searchInFlight || state.searchRequestId !== requestId) {
        return;
      }
      restartSearchWorker("검색 재시작중");
    }, SEARCH_WATCHDOG_MS);
  }

  function clearSearchWatchdog() {
    window.clearTimeout(state.searchWatchdogTimer);
    state.searchWatchdogTimer = 0;
  }

  function restartSearchWorker(label) {
    clearSearchWatchdog();
    if (state.worker && typeof state.worker.terminate === "function") {
      state.worker.terminate();
    }
    state.worker = createSearchWorker(core, {
      textUrl: defaultDictionaryTextUrl,
      metaUrl: defaultDictionaryMetaUrl,
      scriptUrl: defaultDictionaryScriptUrl,
      fallbackText: fallbackDefaultText
    });
    attachWorkerHandlers(state.worker);
    state.workerReady = false;
    state.searchInFlight = false;
    state.pendingSearch = true;
    setBusy(true, label || "검색 재시작중");
    rebuildDictionary();
  }

  function getPageSize() {
    if (elements.oneShotOnly.checked) {
      return ONE_SHOT_RESULT_PAGE_SIZE;
    }
    if (mobileMedia.matches) {
      return MOBILE_RESULT_PAGE_SIZE;
    }
    if (dictionaryDrawerMedia.matches) {
      return TABLET_RESULT_PAGE_SIZE;
    }
    return RESULT_PAGE_SIZE;
  }

  function setResultPage(page) {
    const nextPage = Math.max(1, Math.floor(Number(page) || 1));
    if (nextPage === state.page) {
      return;
    }
    state.page = nextPage;
    animateResultListToTop();
    updateBackToTop();
    scheduleSearch(0);
  }

  function updateBackToTop() {
    elements.backToTop.classList.toggle("visible", elements.resultList.scrollTop > 360);
  }

  function animateResultListToTop() {
    const start = elements.resultList.scrollTop;
    if (start <= 0) {
      updateBackToTop();
      return;
    }

    const duration = Math.min(650, Math.max(260, start * 0.45));
    const started = performance.now();

    function step(now) {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      elements.resultList.scrollTop = Math.round(start * (1 - eased));
      updateBackToTop();

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  function usesDictionaryDrawer() {
    return false;
  }

  function setDictionaryPanelOpen(isOpen) {
    const nextOpen = Boolean(isOpen);
    elements.dictionaryPanel.classList.toggle("open", nextOpen);
    document.body.classList.remove("dictionary-open");
    document.body.classList.toggle("settings-channel", nextOpen);
    elements.toggleDictionary.setAttribute("aria-expanded", String(nextOpen));
    setGuildSelection(nextOpen);
  }

  function openSettingsPanel() {
    setDictionaryPanelOpen(true);
    const focusTarget = elements.settingsSearch || elements.customDictionary;
    if (focusTarget) {
      focusTarget.focus();
    }
  }

  function setGuildSelection(isSettingsSelected) {
    if (elements.guildSearch) {
      elements.guildSearch.classList.toggle("selected", !isSettingsSelected);
    }
    if (elements.guildSettings) {
      elements.guildSettings.classList.toggle("selected", Boolean(isSettingsSelected));
    }
    if (elements.searchChannel) {
      elements.searchChannel.classList.toggle("active", !isSettingsSelected);
    }
  }

  function setSourceMode(mode, resetPage) {
    const nextMode = mode === "reply" ? "reply" : "starts";
    state.sourceMode = nextMode;
    document.querySelectorAll("[data-source-mode]").forEach((target) => {
      target.classList.toggle("active", target.dataset.sourceMode === nextMode);
    });
    scheduleSearch(0, Boolean(resetPage));
  }

  function setOneShotOnly(isChecked, resetPage) {
    const nextChecked = Boolean(isChecked);
    elements.oneShotOnly.checked = nextChecked;
    if (elements.settingsOneShotOnly) {
      elements.settingsOneShotOnly.checked = nextChecked;
    }
    scheduleSearch(0, Boolean(resetPage));
  }

  function setShowUsedControls(isVisible) {
    state.showUsedControls = true;
    saveBooleanSetting(USED_WORD_CONTROLS_STORAGE_KEY, state.showUsedControls);
    applyUsedControlsVisibility();
    scheduleSearch(0);
  }

  function syncSettingsControls() {
    if (elements.settingsOneShotOnly) {
      elements.settingsOneShotOnly.checked = elements.oneShotOnly.checked;
    }
    applyUsedControlsVisibility();
    filterSettings();
  }

  function applyUsedControlsVisibility() {
    document.body.classList.remove("hide-used-controls");
  }

  function filterSettings() {
    if (!elements.settingsSearch) {
      return;
    }
    const needle = normalizeSettingsText(elements.settingsSearch.value);
    document.querySelectorAll(".settings-section").forEach((section) => {
      const haystack = normalizeSettingsText(
        `${section.dataset.settingsText || ""} ${section.textContent || ""}`
      );
      section.hidden = Boolean(needle) && !haystack.includes(needle);
    });
  }

  function normalizeSettingsText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function addMediaListener(media, listener) {
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", listener);
      return;
    }
    media.addListener(listener);
  }

  function updateStats(stats) {
    elements.statTotal.textContent = formatNumber(stats.total);
    elements.statKo.textContent = formatNumber(stats.ko);
    elements.statEn.textContent = formatNumber(stats.en);
    elements.statOneShot.textContent = formatNumber(stats.oneShot);
    elements.statAlt.textContent = formatNumber(stats.alternativeOneShot);
    elements.invalidPreview.textContent = formatNumber(stats.invalid);
    elements.dictionaryState.textContent = `${formatNumber(stats.total)} 단어`;
  }

  function maybeRunOnlineLookup(payload) {
    if (!isOnlineLookupEnabled() || !payload) {
      return;
    }
    const target = getOnlineSupplementTarget(payload);
    if (!target) {
      return;
    }
    if (typeof fetch !== "function") {
      updateOnlineState("지원 안 됨");
      return;
    }
    if (navigator.onLine === false) {
      updateOnlineState("오프라인");
      return;
    }

    const lookup = getOnlineLookupInfo(payload, target);
    if (!lookup.prefixes.length) {
      return;
    }

    lookup.wasEmpty = !payload.total;
    const attemptKey = getOnlineAttemptKey(lookup);
    lookup.attemptKey = attemptKey;
    if (state.onlineAttempts.has(attemptKey)) {
      return;
    }

    abortOnlineLookup();
    rememberOnlineAttempt(attemptKey);
    state.onlineMisses.delete(attemptKey);
    const lookupId = ++state.onlineLookupId;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    state.onlineAbortController = controller;
    updateOnlineState(`${lookup.targetLabel} 조회중`);
    elements.buildState.textContent = "검색중...";

    fetchOnlineWords(lookup, controller && controller.signal)
      .then((words) => expandOnlineWordsForLookup(words, lookup, controller && controller.signal))
      .then((words) => {
        if (lookupId !== state.onlineLookupId) {
          return;
        }
        if (!words.length) {
          if (lookup.wasEmpty) {
            markOnlineLookupMiss(lookup);
            updateOnlineState("미발견");
            elements.buildState.textContent = "검색 완료";
          } else {
            updateOnlineState("추가 없음");
            elements.buildState.textContent = "로컬 결과";
          }
          return;
        }

        appendOnlineCandidates(words, lookup);
      })
      .catch((error) => {
        state.onlineAttempts.delete(attemptKey);
        if (error && error.name === "AbortError") {
          return;
        }
        if (lookupId === state.onlineLookupId) {
          updateOnlineState("조회 실패");
          elements.buildState.textContent = "검색 실패";
        }
      })
      .finally(() => {
        if (state.onlineAbortController === controller) {
          state.onlineAbortController = null;
        }
      });
  }

  function getOnlineSupplementTarget(payload) {
    if (elements.oneShotOnly.checked) {
      return payload.queryInfo && payload.queryInfo.reading ? "oneShot" : "";
    }

    return payload.queryInfo && payload.queryInfo.reading ? "connection" : "";
  }

  function getOnlineLookupInfo(payload, target) {
    const query = String(elements.queryInput.value || "").trim();
    const queryInfo = payload.queryInfo || {};
    const targetLabel = target === "oneShot" ? "한방/대체" : "연결";
    const oneShotOnly = elements.oneShotOnly.checked;
    if (!query || !queryInfo.reading) {
      return {
        mode: state.sourceMode,
        target,
        targetLabel,
        query,
        oneShotOnly,
        label: "",
        prefixes: [],
        exactWord: ""
      };
    }

    if (state.sourceMode === "reply") {
      const starts = uniqueOnlinePrefixes(queryInfo.starts || []);
      return {
        mode: "reply",
        target,
        targetLabel,
        query,
        oneShotOnly,
        label: starts.join(", "),
        prefixes: starts,
        prefixSet: new Set(starts),
        exactWord: normalizeOnlineTitle(query)
      };
    }

    const prefixes = uniqueOnlinePrefixes(queryInfo.prefixes || []);
    return {
      mode: "starts",
      target,
      targetLabel,
      query,
      oneShotOnly,
      label: queryInfo.reading,
      prefixes,
      prefixSet: new Set(prefixes),
      exactWord: normalizeOnlineTitle(query)
    };
  }

  function abortOnlineLookup() {
    if (state.onlineAbortController) {
      state.onlineAbortController.abort();
      state.onlineAbortController = null;
    }
    state.onlinePrefixRequests.clear();
    state.onlineLookupId += 1;
  }

  function getOnlineAttemptKey(lookup) {
    if (!lookup || !lookup.target || !lookup.mode || !Array.isArray(lookup.prefixes)) {
      return "";
    }
    return `${lookup.target}:${lookup.mode}:${lookup.exactWord || ""}:${lookup.prefixes.join("|")}`;
  }

  function rememberOnlineAttempt(attemptKey) {
    if (!attemptKey) {
      return;
    }
    state.onlineAttempts.add(attemptKey);
    while (state.onlineAttempts.size > 256) {
      const oldest = state.onlineAttempts.values().next().value;
      state.onlineAttempts.delete(oldest);
    }
  }

  function markOnlineLookupMiss(lookup) {
    const attemptKey = (lookup && lookup.attemptKey) || getOnlineAttemptKey(lookup);
    if (attemptKey) {
      state.onlineMisses.add(attemptKey);
      while (state.onlineMisses.size > 256) {
        const oldest = state.onlineMisses.values().next().value;
        state.onlineMisses.delete(oldest);
      }
    }
    if (lookup && lookup.wasEmpty && isCurrentOnlineLookup(lookup)) {
      renderWordrowFallback(lookup);
    }
  }

  function isCurrentOnlineLookup(lookup) {
    return (
      lookup &&
      String(elements.queryInput.value || "").trim() === lookup.query &&
      state.sourceMode === lookup.mode &&
      Boolean(elements.oneShotOnly.checked) === Boolean(lookup.oneShotOnly)
    );
  }

  function parseOnlineWords(text) {
    return uniqueOnlineWords(String(text || "").split(/\r?\n/));
  }

  function readLocalStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function removeLocalStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage policy errors; the in-memory state has already been reset.
    }
  }

  function normalizeUsedWordKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function loadUsedWordKeys() {
    try {
      const raw = readLocalStorage(USED_WORDS_STORAGE_KEY, "");
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return new Set();
      }
      return new Set(parsed.map(normalizeUsedWordKey).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  function saveUsedWordKeys() {
    writeLocalStorage(USED_WORDS_STORAGE_KEY, JSON.stringify(Array.from(state.usedWordKeys)));
  }

  function loadBooleanSetting(key, fallback) {
    const raw = readLocalStorage(key, "");
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    return Boolean(fallback);
  }

  function saveBooleanSetting(key, value) {
    writeLocalStorage(key, String(Boolean(value)));
  }

  function setUsedWord(entry, isUsed) {
    const key = normalizeUsedWordKey(entry && entry.key);
    if (!key) {
      return false;
    }
    if (isUsed) {
      state.usedWordKeys.add(key);
    } else {
      state.usedWordKeys.delete(key);
    }
    saveUsedWordKeys();
    return state.usedWordKeys.has(key);
  }

  function normalizeOpendictApiKey(value) {
    return String(value || "").trim().replace(/\s+/g, "");
  }

  function isValidOpendictApiKey(value) {
    return /^[0-9a-f]{32}$/i.test(normalizeOpendictApiKey(value));
  }

  function getOpendictApiKey() {
    const value = elements.opendictApiKey ? elements.opendictApiKey.value : loadOpendictApiKey();
    const key = normalizeOpendictApiKey(value);
    return isValidOpendictApiKey(key) ? key : "";
  }

  function canUseOpendictProxy() {
    return /^https?:$/i.test(window.location.protocol);
  }

  function getOpendictProxyUrl() {
    if (!canUseOpendictProxy() || state.opendictProxyUnavailable) {
      return "";
    }
    return new URL(OPENDICT_PROXY_ENDPOINT, window.location.href).toString();
  }

  function isOpendictLookupEnabled() {
    // The proxy supplies the API key server-side (OPENDICT_API_KEY), so lookups
    // should run whenever a proxy is reachable even if no key is typed in the field.
    return Boolean(getOpendictApiKey()) || Boolean(getOpendictProxyUrl());
  }

  function loadOpendictApiKey() {
    try {
      return normalizeOpendictApiKey(sessionStorage.getItem(OPENDICT_API_KEY_SESSION_STORAGE_KEY) || "");
    } catch {
      return "";
    }
  }

  function saveOpendictApiKey(value) {
    const key = normalizeOpendictApiKey(value);
    try {
      if (key) {
        sessionStorage.setItem(OPENDICT_API_KEY_SESSION_STORAGE_KEY, key);
      } else {
        sessionStorage.removeItem(OPENDICT_API_KEY_SESSION_STORAGE_KEY);
      }
    } catch {
      // Keep the typed key in the password field even if session storage is unavailable.
    }
  }

  function uniqueOnlineWords(words) {
    const result = [];
    const seen = new Set();

    for (const value of words) {
      const word = normalizeOnlineTitle(value);
      const key = word.toLowerCase();
      if (!word || seen.has(key) || core.isCombinedHangulLetterName(word)) {
        continue;
      }
      seen.add(key);
      result.push(word);
    }

    return result;
  }

  function uniqueOnlinePrefixes(prefixes) {
    const result = [];
    const seen = new Set();

    for (const value of prefixes) {
      const prefix = normalizeOnlinePrefix(value);
      if (!prefix || seen.has(prefix)) {
        continue;
      }
      seen.add(prefix);
      result.push(prefix);
    }

    return result;
  }

  function normalizeOnlinePrefixWordLimit(limit) {
    const requested = Math.floor(Number(limit) || ONLINE_NORMAL_PREFIX_WORD_LIMIT);
    return Math.max(1, Math.min(ONLINE_PREFIX_CACHE_WORD_LIMIT, requested));
  }

  function loadOnlinePrefixCache() {
    try {
      const raw = readLocalStorage(ONLINE_PREFIX_CACHE_STORAGE_KEY, "");
      if (!raw) {
        return new Map();
      }

      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
      const cache = new Map();
      for (const item of items) {
        const prefix = normalizeOnlinePrefix(item && item.prefix);
        const words = uniqueOnlineWords(Array.isArray(item && item.words) ? item.words : [])
          .slice(0, ONLINE_PREFIX_CACHE_WORD_LIMIT);
        if (!prefix || !words.length || cache.has(prefix)) {
          continue;
        }
        cache.set(prefix, {
          words,
          usedAt: Number(item.usedAt) || 0,
          opendict: Boolean(item.opendict),
          limit: Math.max(words.length, Number(item.limit) || 0)
        });
      }
      return cache;
    } catch {
      return new Map();
    }
  }

  function storeOnlinePrefixCache(prefix, words, options) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    if (!normalizedPrefix) {
      return;
    }

    const normalizedWords = uniqueOnlineWords(words).slice(0, ONLINE_PREFIX_CACHE_WORD_LIMIT);
    const requestedLimit = normalizeOnlinePrefixWordLimit(options && options.limit);
    if (!normalizedWords.length) {
      state.onlinePrefixCache.delete(normalizedPrefix);
      scheduleOnlinePrefixCacheSave();
      return;
    }

    state.onlinePrefixCache.set(normalizedPrefix, {
      words: normalizedWords,
      usedAt: Date.now(),
      opendict: Boolean(options && options.opendict),
      limit: requestedLimit
    });
    trimOnlinePrefixCache();
    scheduleOnlinePrefixCacheSave();
  }

  function trimOnlinePrefixCache() {
    if (state.onlinePrefixCache.size <= ONLINE_PREFIX_CACHE_MAX) {
      return;
    }

    const keep = Array.from(state.onlinePrefixCache.entries())
      .sort((left, right) => right[1].usedAt - left[1].usedAt)
      .slice(0, ONLINE_PREFIX_CACHE_MAX);
    state.onlinePrefixCache = new Map(keep);
  }

  function scheduleOnlinePrefixCacheSave() {
    window.clearTimeout(state.onlinePrefixSaveTimer);
    state.onlinePrefixSaveTimer = window.setTimeout(saveOnlinePrefixCache, ONLINE_PREFIX_CACHE_SAVE_DELAY);
  }

  function saveOnlinePrefixCache() {
    trimOnlinePrefixCache();
    const items = Array.from(state.onlinePrefixCache.entries())
      .sort((left, right) => right[1].usedAt - left[1].usedAt)
      .map(([prefix, entry]) => ({
        prefix,
        words: entry.words,
        usedAt: entry.usedAt,
        opendict: Boolean(entry.opendict),
        limit: Math.max(entry.words.length, Number(entry.limit) || 0)
      }));

    try {
      writeLocalStorage(ONLINE_PREFIX_CACHE_STORAGE_KEY, JSON.stringify({ items }));
    } catch {
      const compactItems = items.slice(0, Math.max(32, Math.floor(items.length / 2)));
      state.onlinePrefixCache = new Map(
        compactItems.map((item) => [
          item.prefix,
          {
            words: item.words,
            usedAt: item.usedAt,
            opendict: Boolean(item.opendict),
            limit: Math.max(item.words.length, Number(item.limit) || 0)
          }
        ])
      );
      try {
        writeLocalStorage(ONLINE_PREFIX_CACHE_STORAGE_KEY, JSON.stringify({ items: compactItems }));
      } catch {
        removeLocalStorage(ONLINE_PREFIX_CACHE_STORAGE_KEY);
      }
    }
  }

  function loadOnlineOneShotPreloadMeta() {
    try {
      const raw = readLocalStorage(ONLINE_ONESHOT_PRELOAD_STORAGE_KEY, "");
      if (!raw) {
        return { checkedAt: 0, count: 0 };
      }
      const parsed = JSON.parse(raw);
      return {
        checkedAt: Number(parsed && parsed.checkedAt) || 0,
        count: Number(parsed && parsed.count) || 0
      };
    } catch {
      return { checkedAt: 0, count: 0 };
    }
  }

  function saveOnlineOneShotPreloadMeta(count) {
    state.onlineOneShotPreloadMeta = {
      checkedAt: Date.now(),
      count: Math.max(0, Number(count) || 0)
    };
    writeLocalStorage(ONLINE_ONESHOT_PRELOAD_STORAGE_KEY, JSON.stringify(state.onlineOneShotPreloadMeta));
  }

  function isOnlineOneShotPreloadFresh() {
    const meta = state.onlineOneShotPreloadMeta || {};
    const checkedAt = Number(meta.checkedAt) || 0;
    return checkedAt > 0 && Date.now() - checkedAt < ONLINE_ONESHOT_PRELOAD_INTERVAL_MS;
  }

  function maybePreloadOnlineOneShots() {
    if (state.onlineOneShotPreloadStarted || !state.workerReady || !isOnlineLookupEnabled()) {
      return;
    }
    if (isOnlineOneShotPreloadFresh()) {
      return;
    }
    if (typeof fetch !== "function") {
      updateOnlineState("지원 안 됨");
      return;
    }
    if (navigator.onLine === false) {
      updateOnlineState("오프라인");
      return;
    }

    state.onlineOneShotPreloadStarted = true;
    const preloadId = ++state.onlineOneShotPreloadId;
    updateOnlineState("한방 준비중");
    fetchOnlineOneShotPreloadWords()
      .then((words) => {
        if (preloadId !== state.onlineOneShotPreloadId) {
          return;
        }
        saveOnlineOneShotPreloadMeta(words.length);
        if (!words.length) {
          updateOnlineState("한방 미발견");
          return;
        }
        appendOnlineCandidates(words, {
          mode: "preload",
          target: "oneShot",
          query: "",
          oneShotOnly: true,
          label: "한방",
          prefixes: [],
          exactWord: "",
          preload: true,
          candidateCount: words.length
        });
      })
      .catch((error) => {
        if (error && error.name === "AbortError") {
          return;
        }
        if (preloadId !== state.onlineOneShotPreloadId) {
          return;
        }
        updateOnlineState("한방 실패");
      });
  }

  function createAbortError() {
    if (typeof DOMException === "function") {
      return new DOMException("Online lookup aborted", "AbortError");
    }
    const error = new Error("Online lookup aborted");
    error.name = "AbortError";
    return error;
  }

  function createTimeoutError() {
    const error = new Error("online fetch timeout");
    error.name = "TimeoutError";
    return error;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const fetchOptions = { ...(options || {}) };
    const parentSignal = fetchOptions.signal;
    if (!timeoutMs || typeof AbortController !== "function") {
      return fetch(url, fetchOptions);
    }
    if (parentSignal && parentSignal.aborted) {
      throw createAbortError();
    }

    const controller = new AbortController();
    let timedOut = false;
    let parentAbortHandler = null;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    if (parentSignal) {
      parentAbortHandler = () => controller.abort();
      parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
    }

    fetchOptions.signal = controller.signal;
    try {
      return await fetch(url, fetchOptions);
    } catch (error) {
      if (parentSignal && parentSignal.aborted) {
        throw createAbortError();
      }
      if (timedOut) {
        throw createTimeoutError();
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener("abort", parentAbortHandler);
      }
    }
  }

  function getWordrowRequestUrls(targetUrl) {
    const normalizedUrl = String(targetUrl || "").trim();
    if (!normalizedUrl) {
      return [];
    }

    const withoutScheme = normalizedUrl.replace(/^https?:\/\//, "");
    const urls = [];
    for (const endpoint of WORDROW_READER_ENDPOINTS) {
      urls.push(
        `${endpoint}${withoutScheme}`,
        `${endpoint}http://${withoutScheme}`,
        `${endpoint}${normalizedUrl}`
      );
    }
    urls.push(normalizedUrl);
    return Array.from(new Set(urls));
  }

  async function fetchOnlineOneShotPreloadWords(signal) {
    const requests = [
      ...ONLINE_ONESHOT_EXACT_PRELOAD_WORDS.map((word) =>
        fetchWordrowMeaningWord(word, signal).catch((error) => {
          if (error && error.name === "AbortError") {
            throw error;
          }
          return [];
        })
      ),
      fetchWordrowOneShotWords(signal).catch((error) => {
        if (error && error.name === "AbortError") {
          throw error;
        }
        return [];
      })
    ];
    const groups = await Promise.all(requests);
    const words = [];

    for (const group of groups) {
      words.push(...group);
    }

    return uniqueOnlineWords(words).slice(0, ONLINE_ONESHOT_PRELOAD_WORD_LIMIT);
  }

  async function fetchWordrowOneShotWords(signal) {
    const requestUrls = getWordrowRequestUrls(WORDROW_ONESHOT_ENDPOINT);

    for (const url of requestUrls) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      try {
        const response = await fetchWithTimeout(
          url,
          signal ? { signal } : undefined,
          ONLINE_WORDROW_FETCH_TIMEOUT_MS
        );
        if (!response.ok) {
          continue;
        }
        const words = parseWordrowOneShotWords(await response.text());
        if (words.length) {
          return words;
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
      }
    }

    return [];
  }

  function parseWordrowOneShotWords(text) {
    const section = extractWordrowOneShotSection(text);
    const words = [];

    words.push(...parseWordrowInlineBulletWords(section));
    return uniqueOnlineWords(words).slice(0, ONLINE_ONESHOT_PRELOAD_WORD_LIMIT);
  }

  function extractWordrowOneShotSection(text) {
    const source = String(text || "");
    const startMatch = source.search(/끝말\s*잇기\s*(끝내는\s*글자들|한방)/);
    if (startMatch < 0) {
      return source;
    }

    const section = source.slice(startMatch);
    const stopMatch = section.search(/\n##\s+\*\*.*?(시작하는 단어|초성이 같은 단어들|실전 끝말 잇기)/);
    if (stopMatch <= 0) {
      return section;
    }
    return section.slice(0, stopMatch);
  }

  function parseWordrowInlineBulletWords(text) {
    const source = String(text || "").replace(
      /\[[^\]]*?•\s*([가-힣]+)[^\]]*?\]\([^)]+\)/g,
      " •$1 "
    );
    const words = [];

    for (const segment of source.split("•").slice(1)) {
      const word = normalizeWordrowCandidateLabel(segment.split("\n", 1)[0]);
      if (word) {
        words.push(word);
      }
    }

    return words;
  }

  async function fetchOnlineWords(lookup, signal) {
    const exactWord = normalizeOnlineTitle(lookup && lookup.exactWord);
    const exactKey = exactWord.toLowerCase();
    const requests = [];

    if (exactWord && isOpendictLookupEnabled()) {
      requests.push(
        fetchOpendictWords(exactWord, "exact", OPENDICT_EXACT_WORD_LIMIT, signal).catch((error) => {
          if (error && error.name === "AbortError") {
            throw error;
          }
          handleOpendictLookupError(error);
          return [];
        })
      );
    }

    if (exactWord) {
      requests.push(
        fetchWordrowMeaningWord(exactWord, signal).catch((error) => {
          if (error && error.name === "AbortError") {
            throw error;
          }
          return [];
        })
      );
    }
    const prefixWordLimit = getOnlinePrefixWordLimit(lookup);
    requests.push(...lookup.prefixes.map((prefix) => fetchOnlinePrefix(prefix, signal, prefixWordLimit)));

    const groups = [];
    const settled = await Promise.all(
      requests.map((request) =>
        request.then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason })
        )
      )
    );
    let failures = 0;

    for (const result of settled) {
      if (result.status === "fulfilled") {
        groups.push(result.value);
      } else {
        failures += 1;
      }
    }

    if (signal && signal.aborted) {
      throw createAbortError();
    }
    if (failures === settled.length && failures > 0) {
      throw new Error("online lookup failed");
    }

    const candidates = [];
    const seen = new Set();

    for (const words of groups) {
      for (const word of words) {
        const normalizedWord = normalizeOnlineTitle(word);
        const key = normalizedWord.toLowerCase();
        if (
          !normalizedWord ||
          seen.has(key) ||
          (key !== exactKey && !matchesOnlineLookup(normalizedWord, lookup))
        ) {
          continue;
        }
        seen.add(key);
        candidates.push(normalizedWord);
      }
    }

    return candidates.sort((left, right) => {
      const leftReading = core.toReading(left);
      const rightReading = core.toReading(right);
      if (leftReading !== rightReading) {
        return leftReading < rightReading ? -1 : 1;
      }
      return left.localeCompare(right, "ko");
    });
  }

  async function expandOnlineWordsForLookup(words, lookup, signal) {
    const baseWords = uniqueOnlineWords(words);
    if (!baseWords.length) {
      return [];
    }

    if (lookup) {
      lookup.candidateCount = baseWords.length;
    }
    if (!shouldVerifyOnlineOneShotLookup(lookup)) {
      return baseWords;
    }

    const supplementWords = await fetchOnlineOneShotVerificationWords(baseWords, signal);
    if (supplementWords.length) {
      lookup.includeSupplementWords = true;
    }
    return uniqueOnlineWords(baseWords.concat(supplementWords));
  }

  function shouldVerifyOnlineOneShotLookup(lookup) {
    return Boolean(lookup && lookup.target === "oneShot" && !lookup.preload);
  }

  async function fetchOnlineOneShotVerificationWords(candidateWords, signal) {
    const result = [];
    const checkedPrefixes = new Set();
    let frontierWords = uniqueOnlineWords(candidateWords).slice(0, ONLINE_ONESHOT_VERIFY_CANDIDATE_LIMIT);

    for (let depth = 0; depth < ONLINE_ONESHOT_VERIFY_DEPTH; depth += 1) {
      const prefixes = getReplyPrefixesForOnlineWords(frontierWords, checkedPrefixes).slice(
        0,
        ONLINE_ONESHOT_VERIFY_PREFIX_LIMIT
      );
      if (!prefixes.length) {
        break;
      }

      const groups = await fetchOnlineVerificationPrefixGroups(prefixes, signal);
      const nextWords = uniqueOnlineWords(groups.flat());
      if (!nextWords.length) {
        break;
      }

      result.push(...nextWords);
      frontierWords = nextWords.slice(0, ONLINE_ONESHOT_VERIFY_CANDIDATE_LIMIT);
    }

    return uniqueOnlineWords(result);
  }

  function getReplyPrefixesForOnlineWords(words, checkedPrefixes) {
    const prefixes = [];
    for (const word of Array.isArray(words) ? words : []) {
      const reading = core.toReading(word);
      if (reading.length < 2) {
        continue;
      }
      for (const prefix of core.getAllowedStartSyllables(reading[reading.length - 1])) {
        if (checkedPrefixes.has(prefix)) {
          continue;
        }
        checkedPrefixes.add(prefix);
        prefixes.push(prefix);
      }
    }
    return prefixes;
  }

  async function fetchOnlineVerificationPrefixGroups(prefixes, signal) {
    const groups = [];
    for (let index = 0; index < prefixes.length; index += ONLINE_ONESHOT_VERIFY_BATCH_SIZE) {
      const batch = prefixes.slice(index, index + ONLINE_ONESHOT_VERIFY_BATCH_SIZE);
      const results = await Promise.all(
        batch.map((prefix) =>
          fetchOnlineVerificationPrefix(prefix, signal, ONLINE_ONESHOT_VERIFY_WORD_LIMIT).catch((error) => {
            if (error && error.name === "AbortError") {
              throw error;
            }
            return [];
          })
        )
      );
      groups.push(...results);
    }
    return groups;
  }

  async function fetchOnlineVerificationPrefix(prefix, signal, wordLimit) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    if (!normalizedPrefix) {
      return [];
    }

    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);
    const opendictEnabled = isOpendictLookupEnabled();
    const cached = state.onlinePrefixCache.get(normalizedPrefix);
    if (
      cached &&
      (!opendictEnabled || cached.opendict) &&
      Math.max(cached.words.length, Number(cached.limit) || 0) >= requestedLimit
    ) {
      cached.usedAt = Date.now();
      scheduleOnlinePrefixCacheSave();
      return cached.words.slice(0, requestedLimit);
    }

    const opendictRequest = opendictEnabled
      ? fetchOpendictWords(
          normalizedPrefix,
          "start",
          Math.min(OPENDICT_PREFIX_WORD_LIMIT, requestedLimit),
          signal
        ).catch((error) => {
          if (error && error.name === "AbortError") {
            throw error;
          }
          handleOpendictLookupError(error);
          return [];
        })
      : Promise.resolve([]);

    const wordrowRequest = fetchWordrowPrefixWords(normalizedPrefix, signal, requestedLimit).catch((error) => {
      if (error && error.name === "AbortError") {
        throw error;
      }
      return [];
    });

    const [wordrowWords, opendictWords] = await Promise.all([wordrowRequest, opendictRequest]);
    return uniqueOnlineWords(opendictWords.concat(wordrowWords)).slice(0, requestedLimit);
  }

  function getOnlinePrefixWordLimit(lookup) {
    return normalizeOnlinePrefixWordLimit(
      lookup && lookup.oneShotOnly ? ONLINE_ONESHOT_PREFIX_WORD_LIMIT : ONLINE_NORMAL_PREFIX_WORD_LIMIT
    );
  }

  async function fetchOnlinePrefix(prefix, signal, wordLimit) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    if (!normalizedPrefix) {
      return [];
    }

    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);
    const opendictEnabled = isOpendictLookupEnabled();
    const cached = state.onlinePrefixCache.get(normalizedPrefix);
    if (
      cached &&
      (!opendictEnabled || cached.opendict) &&
      Math.max(cached.words.length, Number(cached.limit) || 0) >= requestedLimit
    ) {
      cached.usedAt = Date.now();
      scheduleOnlinePrefixCacheSave();
      return cached.words.slice(0, requestedLimit);
    }

    const requestKey = `${normalizedPrefix}\u0000${requestedLimit}\u0000${opendictEnabled ? "1" : "0"}`;
    const pending = state.onlinePrefixRequests.get(requestKey);
    if (pending) {
      return pending;
    }

    const request = fetchCombinedPrefixWords(normalizedPrefix, signal, requestedLimit)
      .then((words) => {
        storeOnlinePrefixCache(normalizedPrefix, words, { opendict: opendictEnabled, limit: requestedLimit });
        return words.slice(0, requestedLimit);
      })
      .finally(() => {
        if (state.onlinePrefixRequests.get(requestKey) === request) {
          state.onlinePrefixRequests.delete(requestKey);
        }
      });

    state.onlinePrefixRequests.set(requestKey, request);
    return request;
  }

  async function fetchCombinedPrefixWords(prefix, signal, wordLimit) {
    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);
    const opendictLimit =
      requestedLimit > ONLINE_NORMAL_PREFIX_WORD_LIMIT
        ? OPENDICT_ONESHOT_PREFIX_WORD_LIMIT
        : OPENDICT_PREFIX_WORD_LIMIT;
    const opendictRequest = isOpendictLookupEnabled()
      ? fetchOpendictWords(prefix, "start", opendictLimit, signal).catch((error) => {
          if (error && error.name === "AbortError") {
            throw error;
          }
          handleOpendictLookupError(error);
          return [];
        })
      : Promise.resolve([]);

    const wordrowRequest = fetchWordrowPrefixWords(prefix, signal, requestedLimit).catch((error) => {
      if (error && error.name === "AbortError") {
        throw error;
      }
      return [];
    });
    const [wordrowWords, opendictWords] = await Promise.all([wordrowRequest, opendictRequest]);
    const primaryWords = uniqueOnlineWords(opendictWords.concat(wordrowWords)).slice(0, requestedLimit);

    if (
      primaryWords.length >= requestedLimit ||
      (requestedLimit <= ONLINE_NORMAL_PREFIX_WORD_LIMIT && primaryWords.length >= WORDROW_WIKTIONARY_MERGE_THRESHOLD)
    ) {
      return primaryWords;
    }

    return fetchWiktionaryPrefixCandidates(prefix, signal, requestedLimit)
      .then((candidates) => filterWiktionaryKoreanWords(candidates, signal))
      .then((wiktionaryWords) => uniqueOnlineWords(primaryWords.concat(wiktionaryWords)).slice(0, requestedLimit))
      .catch((error) => {
        if (error && error.name === "AbortError") {
          throw error;
        }
        return primaryWords;
      });
  }

  async function fetchOpendictWords(query, method, limit, signal) {
    const apiKey = getOpendictApiKey();
    const normalizedQuery = normalizeOnlineTitle(query);
    if (!normalizedQuery) {
      return [];
    }

    const requestedLimit = Math.max(1, Math.floor(Number(limit) || 10));
    const pageSize = Math.min(100, requestedLimit);
    updateOpendictState("조회중");
    const params = new URLSearchParams({
      q: normalizedQuery,
      req_type: "json",
      part: "word",
      sort: "dict",
      advanced: "y",
      target: "1",
      method,
      type1: "word",
      type3: "all",
      start: "1",
      num: String(pageSize)
    });

    const words = [];
    const seen = new Set();
    for (let start = 1; words.length < requestedLimit; start += pageSize) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      params.set("start", String(start));
      const pageWords = await fetchOpendictWordsPage(params, apiKey, normalizedQuery, method, signal);
      for (const word of pageWords) {
        const normalizedWord = normalizeOnlineTitle(word);
        const key = normalizedWord.toLowerCase();
        if (!normalizedWord || seen.has(key)) {
          continue;
        }
        seen.add(key);
        words.push(normalizedWord);
        if (words.length >= requestedLimit) {
          break;
        }
      }
      if (pageWords.length < pageSize) {
        break;
      }
    }

    return words;
  }

  async function fetchOpendictWordsPage(params, apiKey, normalizedQuery, method, signal) {
    if (apiKey) {
      params.set("key", apiKey);
      try {
        return await fetchOpendictEndpoint(`${OPENDICT_SEARCH_ENDPOINT}?${params.toString()}`, normalizedQuery, method, signal);
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
        const proxyUrl = getOpendictProxyUrl();
        if (!proxyUrl) {
          if (error instanceof TypeError) {
            updateOpendictState("프록시 필요");
          }
          throw error;
        }
        const proxyParams = new URLSearchParams(params);
        try {
          return await fetchOpendictEndpoint(`${proxyUrl}?${proxyParams.toString()}`, normalizedQuery, method, signal);
        } catch (proxyError) {
          if (proxyError && proxyError.name === "AbortError") {
            throw proxyError;
          }
          state.opendictProxyUnavailable = true;
          throw error;
        }
      }
    }

    const proxyUrl = getOpendictProxyUrl();
    if (proxyUrl) {
      try {
        return await fetchOpendictEndpoint(`${proxyUrl}?${params.toString()}`, normalizedQuery, method, signal);
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
        state.opendictProxyUnavailable = true;
        updateOpendictState("키 필요");
        return [];
      }
    }

    if (!apiKey) {
      updateOpendictState("키 없음");
      return [];
    }

    return [];
  }

  async function fetchOpendictEndpoint(url, query, method, signal) {
    const response = await fetchWithTimeout(
      url,
      {
        ...(signal ? { signal } : {}),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json"
        }
      },
      ONLINE_API_FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`opendict status ${response.status}`);
    }

    const data = await parseOpendictResponse(response);
    if (data && data.error) {
      const code = data.error.error_code || data.error.code || "";
      const message = data.error.message || "opendict error";
      throw new Error(`opendict error ${code}: ${message}`);
    }

    const words = parseOpendictSearchWords(data, query, method);
    if (words.length) {
      updateOpendictState("조회됨");
    } else if (state.opendictStatus !== "조회됨") {
      updateOpendictState("결과 없음");
    }
    return words;
  }

  async function parseOpendictResponse(response) {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return {};
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }

    if (trimmed.startsWith("<")) {
      return parseOpendictXml(trimmed);
    }

    throw new Error("opendict response parse failed");
  }

  function parseOpendictXml(text) {
    if (typeof DOMParser !== "function") {
      throw new Error("opendict xml response");
    }

    const document = new DOMParser().parseFromString(text, "application/xml");
    const parserError = document.querySelector("parsererror");
    if (parserError) {
      throw new Error("opendict xml parse failed");
    }

    const error = document.querySelector("error");
    if (error) {
      return {
        error: {
          error_code: getXmlText(error, "error_code"),
          message: getXmlText(error, "message")
        }
      };
    }

    const itemNodes = Array.from(document.querySelectorAll("channel > item"));
    return {
      channel: {
        item: itemNodes.map((item) => ({
          word: getXmlText(item, "word")
        }))
      }
    };
  }

  function getXmlText(parent, selector) {
    const node = parent && parent.querySelector(selector);
    return node ? node.textContent || "" : "";
  }

  function parseOpendictSearchWords(data, query, method) {
    const normalizedQuery = normalizeOnlineTitle(query);
    if (!normalizedQuery) {
      return [];
    }

    const prefix = method === "start" ? normalizeOnlinePrefix(normalizedQuery) : "";
    const exactReading = method === "exact" ? core.toReading(normalizedQuery) : "";
    const items = asArray(data && data.channel && data.channel.item);
    const words = [];

    for (const item of items) {
      const word = normalizeOpendictWord(item && item.word);
      if (!word) {
        continue;
      }
      const reading = core.toReading(word);
      if (method === "start") {
        if (prefix && reading.startsWith(prefix)) {
          words.push(word);
        }
        continue;
      }
      if (word === normalizedQuery || (exactReading && reading === exactReading)) {
        words.push(word);
      }
    }

    return uniqueOnlineWords(words);
  }

  function normalizeOpendictWord(value) {
    const raw = String(value || "").trim();
    if (!raw || /\s/.test(raw)) {
      return "";
    }
    return normalizeOnlineTitle(raw.replace(/\^/g, "").replace(/-/g, ""));
  }

  function asArray(value) {
    if (Array.isArray(value)) {
      return value;
    }
    return value ? [value] : [];
  }

  function handleOpendictLookupError(error) {
    if (!getOpendictApiKey()) {
      return;
    }

    const message = String((error && error.message) || "");
    if (/proxy|cors|blocked|failed to fetch|load failed|프록시/i.test(message)) {
      updateOpendictState("프록시 필요");
      return;
    }

    updateOpendictState(/key|020|unregistered|인증|등록/i.test(message) ? "키 오류" : "조회 실패");
  }

  async function fetchWordrowMeaningWord(word, signal) {
    const normalizedWord = normalizeOnlineTitle(word);
    if (!normalizedWord) {
      return [];
    }

    const targetUrl = `${WORDROW_MEANING_ENDPOINT}${encodeURIComponent(normalizedWord)}/`;
    const requestUrls = getWordrowRequestUrls(targetUrl);

    for (const url of requestUrls) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      try {
        const response = await fetchWithTimeout(
          url,
          signal ? { signal } : undefined,
          ONLINE_WORDROW_FETCH_TIMEOUT_MS
        );
        if (!response.ok) {
          continue;
        }
        const words = parseWordrowMeaningWords(await response.text(), normalizedWord);
        if (words.length) {
          return words;
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
      }
    }

    return [];
  }

  function parseWordrowMeaningWords(text, word) {
    const normalizedWord = normalizeOnlineTitle(word);
    if (!normalizedWord) {
      return [];
    }

    const source = String(text || "");
    if (hasExactHeadwordInText(source, normalizedWord)) {
      return [normalizedWord];
    }

    return [];
  }

  function hasExactHeadwordInText(text, word) {
    const normalizedWord = normalizeOnlineTitle(word);
    if (!normalizedWord) {
      return false;
    }

    const source = String(text || "");
    const compactSource = source.replace(/\s+/g, "");
    const exactMarkers = [
      `${normalizedWord}의의미`,
      `${normalizedWord}의자세한의미`,
      `${normalizedWord}:`,
      `${normalizedWord}：`,
      `**${normalizedWord}**:`,
      `**${normalizedWord}**의`,
      `<word>${normalizedWord}</word>`,
      `"word":"${normalizedWord}"`
    ];
    if (exactMarkers.some((marker) => compactSource.includes(marker))) {
      return true;
    }

    const escapedWord = escapeRegExp(normalizedWord);
    return new RegExp(
      `(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*)?${escapedWord}(?:\\*\\*)?\\s*[:：]`,
      "m"
    ).test(source);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function fetchWordrowPrefixWords(prefix, signal, wordLimit) {
    const targetUrl = `${WORDROW_START_ENDPOINT}${encodeURIComponent(prefix)}/`;
    const requestUrls = getWordrowRequestUrls(targetUrl);
    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);

    for (const url of requestUrls) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      try {
        const response = await fetchWithTimeout(
          url,
          signal ? { signal } : undefined,
          ONLINE_WORDROW_FETCH_TIMEOUT_MS
        );
        if (!response.ok) {
          continue;
        }
        const words = parseWordrowPrefixWords(await response.text(), prefix, requestedLimit);
        if (words.length) {
          return words;
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
      }
    }

    return [];
  }

  function parseWordrowPrefixWords(text, prefix, wordLimit) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    if (!normalizedPrefix) {
      return [];
    }

    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);
    const source = String(text || "");
    const section = extractWordrowPrefixSection(source, normalizedPrefix);
    const words = [];

    words.push(...parseWordrowMarkdownListWords(section, normalizedPrefix));
    words.push(...parseWordrowBulletLabelWords(section, normalizedPrefix));
    words.push(...parseWordrowPrefixTitleWords(source, normalizedPrefix));
    return uniqueOnlineWords(words).slice(0, Math.min(WORDROW_WORD_LIMIT, requestedLimit));
  }

  function parseWordrowMarkdownListWords(text, prefix) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    const source = String(text || "");
    const words = [];
    const markdownItemPattern = /^\s*\*\s+\[(.+?)\]\(/gm;
    let match = markdownItemPattern.exec(source);

    while (match) {
      const word = normalizeWordrowCandidateLabel(match[1]);
      if (word && core.toReading(word).startsWith(normalizedPrefix)) {
        words.push(word);
      }
      match = markdownItemPattern.exec(source);
    }

    return words;
  }

  function parseWordrowBulletLabelWords(text, prefix) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    const source = String(text || "");
    const words = [];
    const bulletPattern = /^\s*(?:\*|-|•|\*\*•\*\*)\s+(.+?)(?=\s+:\s*|$)/gm;
    let match = bulletPattern.exec(source);

    while (match) {
      const word = normalizeWordrowCandidateLabel(match[1]);
      if (word && core.toReading(word).startsWith(normalizedPrefix)) {
        words.push(word);
      }
      match = bulletPattern.exec(source);
    }

    return words;
  }

  function parseWordrowPrefixTitleWords(text, prefix) {
    const normalizedPrefix = normalizeOnlinePrefix(prefix);
    const titleMatch = String(text || "").match(/^Title:\s*(.+)$/m);
    if (!normalizedPrefix || !titleMatch) {
      return [];
    }

    const title = titleMatch[1];
    const markers = [
      `${normalizedPrefix}으로 시작하는 단어:`,
      `${normalizedPrefix}로 시작하는 단어:`
    ];
    const marker = markers.find((candidate) => title.includes(candidate));
    if (!marker) {
      return [];
    }

    return title
      .slice(title.indexOf(marker) + marker.length)
      .split("[", 1)[0]
      .split(",")
      .map(normalizeWordrowCandidateLabel)
      .filter((word) => word && core.toReading(word).startsWith(normalizedPrefix));
  }

  function extractWordrowPrefixSection(text, prefix) {
    const source = String(text || "");
    const headerPatterns = [
      `${prefix}**으로 시작`,
      `${prefix}** 로 시작`,
      `${prefix}으로 시작`,
      `${prefix} 로 시작`
    ];
    let startIndex = -1;

    for (const pattern of headerPatterns) {
      startIndex = source.indexOf(pattern);
      if (startIndex >= 0) {
        break;
      }
    }

    const section = startIndex >= 0 ? source.slice(startIndex) : source;
    const stopMatch = section.match(/\n##\s+\*\*.*?(초성이 같은 단어들|실전 끝말 잇기|끝말 잇기 한방)/);
    if (!stopMatch || typeof stopMatch.index !== "number") {
      return section;
    }
    return section.slice(0, stopMatch.index);
  }

  function cleanWordrowMarkdownLabel(label) {
    return String(label || "")
      .replace(/\\([\\[\]()*_`])/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/^[•*-]+\s*/, "")
      .trim();
  }

  function normalizeWordrowCandidateLabel(label) {
    const cleaned = cleanWordrowMarkdownLabel(label);
    if (/\s/.test(cleaned)) {
      return "";
    }
    return normalizeOnlineTitle(cleaned);
  }

  async function fetchWiktionaryPrefixCandidates(prefix, signal, wordLimit) {
    const candidates = [];
    let continuation = null;
    const requestedLimit = normalizeOnlinePrefixWordLimit(wordLimit);

    for (let requestCount = 0; requestCount < ONLINE_LOOKUP_MAX_REQUESTS; requestCount += 1) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      const params = new URLSearchParams({
        origin: "*",
        action: "query",
        format: "json",
        formatversion: "2",
        list: "allpages",
        apprefix: prefix,
        apnamespace: "0",
        apfilterredir: "nonredirects",
        aplimit: String(ONLINE_LOOKUP_LIMIT),
        "continue": ""
      });
      if (continuation) {
        for (const [key, value] of Object.entries(continuation)) {
          params.set(key, value);
        }
      }

      const response = await fetchWithTimeout(
        `${ONLINE_LOOKUP_ENDPOINT}?${params.toString()}`,
        signal ? { signal } : undefined,
        ONLINE_API_FETCH_TIMEOUT_MS
      );
      if (!response.ok) {
        throw new Error(`online lookup failed: ${response.status}`);
      }

      const data = await response.json();
      candidates.push(
        ...((data.query && data.query.allpages) || []).map((page) => normalizeOnlineTitle(page.title))
      );
      if (uniqueOnlineWords(candidates).length >= requestedLimit) {
        break;
      }

      continuation = data.continue || null;
      if (!continuation || !continuation.apcontinue) {
        break;
      }
    }

    return uniqueOnlineWords(candidates).slice(0, requestedLimit);
  }

  async function filterWiktionaryKoreanWords(words, signal) {
    const valid = [];
    for (let index = 0; index < words.length; index += ONLINE_VERIFY_BATCH_SIZE) {
      if (signal && signal.aborted) {
        throw createAbortError();
      }

      const batch = words.slice(index, index + ONLINE_VERIFY_BATCH_SIZE);
      const pages = await fetchWiktionaryPages(batch, signal);
      for (const page of pages) {
        const word = normalizeOnlineTitle(page && page.title);
        if (!word || !batch.includes(word)) {
          continue;
        }
        if (isKoreanWiktionaryEntry(getWiktionaryPageContent(page))) {
          valid.push(word);
        }
      }
    }

    return uniqueOnlineWords(valid);
  }

  async function fetchWiktionaryPages(words, signal) {
    if (!words.length) {
      return [];
    }

    const params = new URLSearchParams({
      origin: "*",
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: words.join("|")
    });
    const response = await fetchWithTimeout(
      `${ONLINE_LOOKUP_ENDPOINT}?${params.toString()}`,
      signal ? { signal } : undefined,
      ONLINE_API_FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`online verification failed: ${response.status}`);
    }
    const data = await response.json();
    return (data.query && data.query.pages) || [];
  }

  function getWiktionaryPageContent(page) {
    const revision = page && page.revisions && page.revisions[0];
    if (!revision) {
      return "";
    }
    if (revision.slots && revision.slots.main) {
      return revision.slots.main.content || revision.slots.main["*"] || "";
    }
    return revision.content || revision["*"] || "";
  }

  function isKoreanWiktionaryEntry(content) {
    const text = String(content || "");
    if (!text) {
      return false;
    }

    return (
      /(^|\n)={2,}\s*(한국어|\{\{언어\|ko\}\}|\{\{ko\}\}|\{\{=ko=\}\})\s*={2,}/m.test(text) ||
      /\{\{ko[-|}]/.test(text) ||
      /\{\{(명사|대명사|수사|동사|형용사|관형사|부사|감탄사|조사|어미|접사|접두사|접미사|어근)\|ko\b/.test(text) ||
      /\{\{발음 듣기\|ko\b/.test(text) ||
      /\[\[분류:한국어/.test(text)
    );
  }

  function normalizeOnlineTitle(title) {
    const word = String(title || "").trim().replace(/\s+/g, "");
    return /^[가-힣]+$/.test(word) ? word : "";
  }

  function normalizeOnlinePrefix(prefix) {
    const word = String(prefix || "").trim().replace(/\s+/g, "");
    return /^[가-힣]+$/.test(word) ? word : "";
  }

  function matchesOnlineLookup(word, lookup) {
    const reading = core.toReading(word);
    if (!reading) {
      return false;
    }

    if (lookup.mode === "reply") {
      return lookup.prefixSet ? lookup.prefixSet.has(reading[0]) : lookup.prefixes.includes(reading[0]);
    }

    return lookup.prefixes.some((prefix) => reading.startsWith(prefix));
  }

  function addOnlineWords(words) {
    const additions = [];

    for (const word of words) {
      const normalized = normalizeOnlineTitle(word);
      const key = normalized.toLowerCase();
      if (!normalized || state.onlineWordSet.has(key)) {
        continue;
      }
      state.onlineWordSet.add(key);
      additions.push(normalized);
    }

    if (!additions.length) {
      return { additions: [], evictedCount: 0 };
    }

    const merged = state.onlineWords.concat(additions);
    const evictedCount = Math.max(0, merged.length - ONLINE_CACHE_MAX_WORDS);
    state.onlineWords = merged.slice(-ONLINE_CACHE_MAX_WORDS);
    state.onlineWordSet = new Set(state.onlineWords.map((word) => word.toLowerCase()));
    state.onlineText = state.onlineWords.join("\n");
    writeLocalStorage(ONLINE_STORAGE_KEY, state.onlineText);
    return { additions, evictedCount };
  }

  function updateOnlineState(status) {
    if (typeof status === "string") {
      state.onlineStatus = status;
    } else if (!state.onlineStatus) {
      state.onlineStatus = isOnlineLookupEnabled() ? "대기" : "꺼짐";
    }

    return state.onlineStatus;
  }

  function updateOpendictState(status) {
    if (typeof status === "string") {
      state.opendictStatus = status;
    }

    if (!elements.opendictState) {
      return;
    }

    const key = elements.opendictApiKey ? normalizeOpendictApiKey(elements.opendictApiKey.value) : getOpendictApiKey();
    if (!key) {
      if (getOpendictProxyUrl()) {
        // Proxy mode: no field key needed. Reflect the live lookup status when
        // one is set, falling back to the idle "프록시 대기" label.
        elements.opendictState.textContent = state.opendictStatus || "프록시 대기";
      } else {
        state.opendictStatus = "";
        elements.opendictState.textContent = "키 없음";
      }
      return;
    }
    if (!isValidOpendictApiKey(key)) {
      state.opendictStatus = "";
      elements.opendictState.textContent = "키 형식 확인";
      return;
    }

    elements.opendictState.textContent = state.opendictStatus || "키 준비됨";
  }

  function isOnlineLookupEnabled() {
    return typeof fetch === "function";
  }

  function renderStartScreen() {
    state.page = 1;
    elements.readingPreview.textContent = "-";
    elements.allowedPreview.textContent = "-";
    elements.resultMeta.textContent = "준비됨";
    elements.resultPager.hidden = true;
    updateBackToTop();
    elements.resultList.textContent = "";

    const row = document.createElement("div");
    row.className = "empty-message start-message";
    const avatar = document.createElement("div");
    avatar.className = "word-avatar";
    avatar.textContent = "#";
    const body = document.createElement("div");
    body.className = "message-body start-empty";

    const title = document.createElement("strong");
    title.textContent = "빠른 검색";
    const chips = document.createElement("div");
    chips.className = "start-chips";
    for (const value of ["값", "킷", "릇", "늠", "즘", "튬"]) {
      const button = document.createElement("button");
      button.className = "start-chip";
      button.type = "button";
      button.textContent = value;
      button.addEventListener("click", () => {
        elements.queryInput.value = value;
        state.observedQuery = value;
        elements.queryInput.focus();
        scheduleSearch(0, true);
      });
      chips.appendChild(button);
    }

    const meta = document.createElement("div");
    meta.className = "start-meta";
    meta.textContent = "자주 막히는 시작 글자";
    body.append(title, chips, meta);
    row.append(avatar, body);
    elements.resultList.appendChild(row);
  }

  function renderPendingSearch(query) {
    const queryInfo = core.getQueryInfo(query, state.sourceMode);
    elements.readingPreview.textContent = queryInfo.reading || "-";
    elements.allowedPreview.textContent =
      state.sourceMode === "reply"
        ? queryInfo.starts.join(", ") || "-"
        : queryInfo.display || "-";
    elements.resultMeta.textContent = "검색중";
    elements.buildState.textContent = "검색중...";
    elements.resultPager.hidden = true;
    updateBackToTop();
    elements.resultList.textContent = "";
    const row = document.createElement("div");
    row.className = "empty-message pending-message";
    const avatar = document.createElement("div");
    avatar.className = "word-avatar";
    avatar.textContent = "#";
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = "검색중...";
    row.append(avatar, body);
    elements.resultList.appendChild(row);
  }

  function renderSearch(payload) {
    state.page = Number(payload.page || 1);
    elements.readingPreview.textContent = payload.queryInfo.reading || "-";
    elements.allowedPreview.textContent =
      state.sourceMode === "reply"
        ? payload.queryInfo.starts.join(", ") || "-"
        : payload.queryInfo.display || "-";
    const firstResult = payload.total ? (payload.page - 1) * payload.pageSize + 1 : 0;
    const lastResult = Math.min(payload.total, payload.page * payload.pageSize);
    elements.resultMeta.textContent = payload.total
      ? `${formatNumber(firstResult)}-${formatNumber(lastResult)} / ${formatNumber(payload.total)}개 · ${formatNumber(payload.page)}/${formatNumber(payload.pageCount)}쪽`
      : "0개";
    elements.buildState.textContent = `검색 ${formatMs(payload.elapsedMs)}`;
    elements.resultList.textContent = "";
    renderPager(payload);
    updateBackToTop();

    if (!payload.results.length) {
      renderEmpty("조건에 맞는 단어가 없습니다");
      maybeRunOnlineLookup(payload);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of payload.results) {
      fragment.appendChild(createResultNode(entry));
    }
    elements.resultList.appendChild(fragment);
    maybeRunOnlineLookup(payload);
  }

  function renderPager(payload) {
    const pageCount = Number(payload.pageCount || 1);
    const page = Number(payload.page || 1);
    elements.resultPager.textContent = "";

    if (!payload.total) {
      elements.resultPager.hidden = true;
      return;
    }

    elements.resultPager.hidden = false;
    elements.resultPager.appendChild(createPagerButton("‹", page - 1, page <= 1, "이전 페이지"));

    let previousPage = 0;
    for (const pageNumber of getVisiblePages(page, pageCount)) {
      if (previousPage && pageNumber - previousPage > 1) {
        const gap = document.createElement("span");
        gap.className = "pager-gap";
        gap.textContent = "…";
        elements.resultPager.appendChild(gap);
      }
      elements.resultPager.appendChild(
        createPagerButton(String(pageNumber), pageNumber, false, `${pageNumber}쪽`, pageNumber === page)
      );
      previousPage = pageNumber;
    }

    elements.resultPager.appendChild(createPagerButton("›", page + 1, page >= pageCount, "다음 페이지"));
  }

  function getVisiblePages(page, pageCount) {
    const pages = new Set([1, pageCount]);
    const start = Math.max(1, page - 2);
    const end = Math.min(pageCount, page + 2);

    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      pages.add(pageNumber);
    }

    if (page <= 4) {
      for (let pageNumber = 2; pageNumber <= Math.min(5, pageCount); pageNumber += 1) {
        pages.add(pageNumber);
      }
    }

    if (page >= pageCount - 3) {
      for (let pageNumber = Math.max(1, pageCount - 4); pageNumber < pageCount; pageNumber += 1) {
        pages.add(pageNumber);
      }
    }

    return Array.from(pages).sort((left, right) => left - right);
  }

  function createPagerButton(label, page, disabled, ariaLabel, isCurrent) {
    const button = document.createElement("button");
    button.className = "pager-button";
    button.type = "button";
    button.textContent = label;
    button.dataset.page = String(page);
    button.disabled = Boolean(disabled);
    button.setAttribute("aria-label", ariaLabel);
    if (isCurrent) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    return button;
  }

  function getMissedOnlineLookup(payload) {
    const target = getOnlineSupplementTarget(payload);
    if (!target) {
      return null;
    }
    const lookup = getOnlineLookupInfo(payload, target);
    if (!lookup.prefixes.length) {
      return null;
    }
    const attemptKey = getOnlineAttemptKey(lookup);
    if (!state.onlineMisses.has(attemptKey)) {
      return null;
    }
    lookup.wasEmpty = true;
    lookup.attemptKey = attemptKey;
    return lookup;
  }

  function renderWordrowFallback(lookup) {
    const query = getWordrowFallbackQuery((lookup && lookup.query) || elements.queryInput.value);
    renderEmpty("", {
      renderBody(body) {
        const link = document.createElement("a");
        link.href = getWordrowStartSearchUrl(query);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "WORDROW";
        link.setAttribute("aria-label", `${query || "Wordrow"}로 시작하는 단어를 Wordrow에서 검색`);

        body.classList.add("wordrow-fallback");
        body.append(
          document.createTextNode("검색결과가 없습니다. "),
          link,
          document.createTextNode(" 이곳에서 검색해보세요.")
        );
      }
    });
  }

  function getWordrowFallbackQuery(query) {
    return String(query || "").trim().replace(/\s+/g, "");
  }

  function getWordrowStartSearchUrl(query) {
    const normalizedQuery = getWordrowFallbackQuery(query);
    return normalizedQuery
      ? `${WORDROW_START_ENDPOINT}${encodeURIComponent(normalizedQuery)}/`
      : WORDROW_START_ENDPOINT;
  }

  function createResultNode(entry) {
    const row = document.createElement("article");
    row.className = "result-message";
    row.classList.toggle("used-word", state.usedWordKeys.has(normalizeUsedWordKey(entry.key)));

    const avatar = document.createElement("div");
    const avatarType = entry.oneShot
      ? "one-shot"
      : entry.alternativeOneShot
        ? "alternative-one-shot"
        : entry.blunder
          ? "blunder"
          : "general-word";
    avatar.className = `word-avatar ${avatarType}`;
    const profile = document.createElement("img");
    profile.src = entry.oneShot
      ? "./assets/one-shot-profile.png?v=oneshot-20260613"
      : entry.alternativeOneShot
        ? "./assets/alternative-one-shot-profile.png?v=alt-oneshot-20260613"
        : entry.blunder
          ? "./assets/blunder-profile.png?v=blunder-20260613"
          : "./assets/general-word-profile.png?v=general-word-20260613";
    profile.alt = "";
    profile.loading = "lazy";
    avatar.title = entry.oneShot
      ? "한방단어"
      : entry.alternativeOneShot
        ? "대체 한방단어"
        : entry.blunder
          ? "블런더"
          : "일반 단어";
    avatar.appendChild(profile);

    const body = document.createElement("div");
    body.className = "message-body";

    const head = document.createElement("div");
    head.className = "message-head";
    const word = document.createElement("a");
    word.className = "word-link";
    word.href = `https://www.google.com/search?q=${encodeURIComponent(entry.word)}`;
    word.target = "_blank";
    word.rel = "noopener";
    word.textContent = entry.word;
    const oneShotBadge = document.createElement("span");
    oneShotBadge.className = `badge ${getBadgeClass(entry)}`;
    oneShotBadge.textContent = getTierLabel(entry);
    head.append(word, oneShotBadge);

    const reading = document.createElement("div");
    reading.className = "message-reading";
    reading.textContent = entry.reading;

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.append(
      createMeta("시작", entry.start),
      createMeta("끝", entry.end),
      createMeta("상대", entry.allowedAfter.join(", ")),
      createMeta("후속", formatNumber(entry.followerCount)),
      createMeta("한방반격", formatNumber(entry.oneShotReplyCount)),
      createMeta("대체반격", formatNumber(entry.alternativeOneShotReplyCount))
    );

    body.append(head, reading, meta);
    if (entry.blunder) {
      body.appendChild(createCounterNode(entry));
    }

    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.type = "button";
    copy.textContent = "복사";
    copy.addEventListener("click", () => {
      copyText(entry.word).then(() => {
        copy.textContent = "완료";
        window.setTimeout(() => {
          copy.textContent = "복사";
        }, 850);
      });
    });

    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.appendChild(createUsedWordControl(entry, row));
    actions.appendChild(copy);

    row.append(avatar, body, actions);
    return row;
  }

  function createUsedWordControl(entry, row) {
    const label = document.createElement("label");
    label.className = "used-word-check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.usedWordKeys.has(normalizeUsedWordKey(entry.key));
    input.setAttribute("aria-label", `${entry.word} 사용됨`);
    input.addEventListener("change", () => {
      const isUsed = setUsedWord(entry, input.checked);
      input.checked = isUsed;
      row.classList.toggle("used-word", isUsed);
      scheduleSearch(0);
    });

    const text = document.createElement("span");
    text.textContent = "사용됨";
    label.append(input, text);
    return label;
  }

  function createMeta(label, value) {
    const node = document.createElement("span");
    const labelNode = document.createTextNode(`${label} `);
    const valueNode = document.createElement("strong");
    valueNode.textContent = value || "-";
    node.append(labelNode, valueNode);
    return node;
  }

  function createCounterNode(entry) {
    const node = document.createElement("div");
    node.className = "message-counter";
    const oneShotWords = entry.oneShotReplyWords || [];
    const alternativeWords = entry.alternativeOneShotReplyWords || [];
    appendCounterReply(node, "한방 반격 ", oneShotWords);
    appendCounterReply(node, "대체 반격 ", alternativeWords);
    return node;
  }

  function appendCounterReply(node, labelText, replyWords) {
    if (!replyWords.length) {
      return;
    }
    if (node.childNodes.length) {
      node.appendChild(document.createElement("br"));
    }
    const label = document.createElement("span");
    label.textContent = labelText;
    const words = document.createElement("strong");
    words.textContent = replyWords.join(", ");
    node.append(label, words);
  }

  function getTierLabel(entry) {
    if (entry.oneShot) {
      return "한방";
    }
    if (entry.alternativeOneShot) {
      return "대체";
    }
    if (entry.blunder) {
      return "블런더";
    }
    return "연결";
  }

  function getBadgeClass(entry) {
    if (entry.oneShot) {
      return "red";
    }
    if (entry.alternativeOneShot) {
      return "yellow";
    }
    if (entry.blunder) {
      return "blunder";
    }
    return "gray";
  }

  function renderEmpty(text, options) {
    if (!(options && options.keepPager)) {
      elements.resultPager.hidden = true;
    }
    updateBackToTop();
    elements.resultList.textContent = "";
    const row = document.createElement("div");
    row.className = "empty-message";
    const avatar = document.createElement("div");
    avatar.className = "word-avatar";
    avatar.textContent = "#";
    const body = document.createElement("div");
    body.className = "message-body";
    if (options && typeof options.renderBody === "function") {
      options.renderBody(body);
    } else {
      body.textContent = text;
    }
    row.append(avatar, body);
    elements.resultList.appendChild(row);
  }

  function setBusy(isBusy, label) {
    elements.buildState.textContent = label;
    elements.searchButton.disabled = isBusy;
    elements.applyDictionary.disabled = isBusy;
  }
}

function createSearchWorker(core, dictionaryAssets) {
  if (typeof Worker === "undefined") {
    return createInlineWorkerFallback(core, dictionaryAssets);
  }
  try {
    return new Worker(
      new URL("./search-worker.js?v=modern-search-custom-parse-20260618-used-dynamic-icons", window.location.href)
    );
  } catch {
    return createInlineWorkerFallback(core, dictionaryAssets);
  }
}

function createInlineWorkerFallback(core, dictionaryAssets) {
  const assets =
    dictionaryAssets && typeof dictionaryAssets === "object"
      ? dictionaryAssets
      : { fallbackText: dictionaryAssets };
  const fallbackDefaultText = assets.fallbackText || core.FALLBACK_DICTIONARY;
  let listener = null;
  let dictionary = null;
  return {
    __isInlineFallback: true,
    set onmessage(next) {
      listener = next;
    },
    postMessage(message) {
      window.setTimeout(async () => {
        try {
          if (message.type === "buildDefault") {
            const extraText = message.extraText || "";
            const baseText = fallbackDefaultText || core.FALLBACK_DICTIONARY;
            dictionary = core.createDictionary(extraText ? `${baseText}\n${extraText}` : baseText);
            listener({
              data: {
                type: "built",
                id: message.id,
                stats: dictionary.stats
              }
            });
            return;
          }
          if (message.type === "build") {
            dictionary = core.createDictionary(message.text || "");
            listener({
              data: {
                type: "built",
                id: message.id,
                stats: dictionary.stats
              }
            });
            return;
          }
          if (message.type === "append") {
            if (!dictionary) {
              dictionary = core.createDictionary(fallbackDefaultText || core.FALLBACK_DICTIONARY);
            }
            dictionary = core.extendDictionary(dictionary, message.text || "");
            listener({
              data: {
                type: "built",
                id: message.id,
                stats: dictionary.stats
              }
            });
            return;
          }
          if (message.type === "appendOnlineCandidates") {
            if (!dictionary) {
              dictionary = core.createDictionary(fallbackDefaultText || core.FALLBACK_DICTIONARY);
            }
            const selected = core.selectOnlineWords(
              dictionary,
              message.words || [],
              message.target,
              message.lookup || {}
            );
            if (selected.length) {
              dictionary = core.extendDictionary(dictionary, selected.join("\n"));
            }
            listener({
              data: {
                type: "onlineAppendResult",
                id: message.id,
                stats: dictionary.stats,
                words: selected,
                lookup: message.lookup || {}
              }
            });
            return;
          }
          if (message.type === "search") {
            if (!dictionary) {
              dictionary = core.createDictionary(fallbackDefaultText || core.FALLBACK_DICTIONARY);
            }
            const payload = core.searchDictionary(dictionary, message.options || {});
            listener({ data: { type: "searchResult", id: message.id, payload } });
          }
        } catch (error) {
          listener({ data: { type: "error", id: message.id, message: error.message } });
        }
      }, 0);
    }
  };
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
  return Promise.resolve();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ko-KR");
}

function formatMs(value) {
  return `${formatNumber(Math.round(value || 0))}ms`;
}

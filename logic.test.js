const assert = require("assert");
const logic = require("./app.js");

assert.strictEqual(logic.englishToHangul("Secret"), "시크릿");
assert.deepStrictEqual(logic.getAllowedStartSyllables("란"), ["란", "난"]);
assert.ok(!logic.getAllowedStartSyllables("란").includes("안"));
assert.deepStrictEqual(logic.getAllowedStartSyllables("린"), ["린", "인"]);
assert.deepStrictEqual(logic.getSearchPrefixes("름"), ["름", "늠"]);
assert.deepStrictEqual(logic.getSearchPrefixes("리"), ["리", "이"]);
assert.deepStrictEqual(logic.getSearchPrefixes("이"), ["이"]);

const dictionary = logic.createDictionary(["계란", "난로", "안색", "Secret", "기동돓", "늠름하다"].join("\n"));

const reply = logic.searchDictionary(dictionary, {
  query: "계란",
  sourceMode: "reply",
  oneShotOnly: false
});

assert.ok(reply.results.some((entry) => entry.word === "난로"));
assert.ok(!reply.results.some((entry) => entry.word === "안색"));

const oneShots = logic.searchDictionary(dictionary, {
  query: "기",
  sourceMode: "starts",
  oneShotOnly: true
});

assert.ok(oneShots.results.some((entry) => entry.word === "기동돓"));

const initialLaw = logic.searchDictionary(dictionary, {
  query: "름",
  sourceMode: "starts",
  oneShotOnly: false
});

assert.ok(initialLaw.results.some((entry) => entry.word === "늠름하다"));

const secret = dictionary.entries.find((entry) => entry.word === "Secret");
assert.ok(secret.oneShot);

const trapDictionary = logic.createDictionary(["가나", "나라", "라끝"].join("\n"));
const trap = trapDictionary.entries.find((entry) => entry.word === "가나");
assert.ok(trap.alternativeOneShot);
assert.strictEqual(trap.oneShotReplyCount, 0);

const riskyDictionary = logic.createDictionary(["가나", "나끝"].join("\n"));
const risky = riskyDictionary.entries.find((entry) => entry.word === "가나");
assert.ok(!risky.alternativeOneShot);
assert.strictEqual(risky.oneShotReplyCount, 1);

const riskyFiltered = logic.searchDictionary(riskyDictionary, {
  query: "가",
  sourceMode: "starts",
  oneShotOnly: true
});

assert.strictEqual(riskyFiltered.results[0].word, "가나");
assert.ok(riskyFiltered.results[0].blunder);

const alternativeCounterDictionary = logic.createDictionary(["가나", "나마", "마라", "라끝"].join("\n"));
const alternativeCounter = alternativeCounterDictionary.entries.find((entry) => entry.word === "가나");
assert.ok(!alternativeCounter.alternativeOneShot);
assert.strictEqual(alternativeCounter.oneShotReplyCount, 0);
assert.strictEqual(alternativeCounter.alternativeOneShotReplyCount, 1);
assert.ok(alternativeCounter.blunder);

const alternativeCounterResult = logic.searchDictionary(alternativeCounterDictionary, {
  query: "가",
  sourceMode: "starts",
  oneShotOnly: false
});

assert.strictEqual(alternativeCounterResult.categoryCounts.connection, 0);
assert.strictEqual(alternativeCounterResult.categoryCounts.blunder, 1);
assert.deepStrictEqual(alternativeCounterResult.results[0].alternativeOneShotReplyWords, ["나마"]);

const allBlunderFollowerDictionary = logic.createDictionary(
  ["그릇", "릇가", "가끝", "릇나", "나끝"].join("\n")
);
const bowl = allBlunderFollowerDictionary.entries.find((entry) => entry.word === "그릇");
assert.ok(allBlunderFollowerDictionary.entries.find((entry) => entry.word === "릇가").blunder);
assert.ok(allBlunderFollowerDictionary.entries.find((entry) => entry.word === "릇나").blunder);
assert.ok(bowl.alternativeOneShot);
assert.ok(!bowl.blunder);
assert.strictEqual(bowl.followerCount, 2);
assert.strictEqual(bowl.killableFollowerCount, 2);

const allBlunderFollowerResult = logic.searchDictionary(allBlunderFollowerDictionary, {
  query: "그",
  sourceMode: "starts",
  oneShotOnly: false
});

assert.strictEqual(allBlunderFollowerResult.categoryCounts.alternativeOneShot, 1);
assert.strictEqual(allBlunderFollowerResult.results[0].word, "그릇");

const priorityDictionary = logic.createDictionary(
  ["가끝", "가나", "나라", "라끝", "가다", "다다", "다다다", "가바", "바끝"].join("\n")
);
const oneShotPriority = logic.searchDictionary(priorityDictionary, {
  query: "가",
  sourceMode: "starts",
  oneShotOnly: true,
  pageSize: 20
});
assert.strictEqual(oneShotPriority.results[0].word, "가끝");
assert.ok(oneShotPriority.results[0].oneShot);

const normalPriority = logic.searchDictionary(priorityDictionary, {
  query: "가",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 20
});
assert.strictEqual(normalPriority.results[0].word, "가다");
assert.ok(!normalPriority.results[0].oneShot);
assert.ok(!normalPriority.results[0].alternativeOneShot);
assert.ok(!normalPriority.results[0].blunder);
assert.ok(normalPriority.results[normalPriority.results.length - 1].blunder);
assert.strictEqual(
  normalPriority.results.findIndex((entry) => entry.oneShot),
  normalPriority.categoryCounts.connection + normalPriority.categoryCounts.alternativeOneShot
);

const connectionFollowerPriorityDictionary = logic.createDictionary(
  ["가나", "나가", "나다", "다가", "가하", "하가"].join("\n")
);
const connectionFollowerPriority = logic.searchDictionary(connectionFollowerPriorityDictionary, {
  query: "가",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 10
});
assert.strictEqual(connectionFollowerPriority.results[0].word, "가하");
assert.strictEqual(connectionFollowerPriority.results[0].followerCount, 1);
assert.strictEqual(connectionFollowerPriority.results[1].word, "가나");
assert.strictEqual(connectionFollowerPriority.results[1].followerCount, 2);

const connectionExactFollowerPriority = logic.searchDictionary(connectionFollowerPriorityDictionary, {
  query: "가나",
  sourceMode: "reply",
  oneShotOnly: false,
  pageSize: 10
});
assert.strictEqual(connectionExactFollowerPriority.results[0].word, "나다");
assert.strictEqual(connectionExactFollowerPriority.results[0].followerCount, 1);
assert.strictEqual(
  connectionExactFollowerPriority.results.findIndex((entry) => entry.word === "가나"),
  1
);

const paged = logic.searchDictionary(riskyDictionary, {
  query: "",
  sourceMode: "starts",
  oneShotOnly: false,
  page: 2,
  pageSize: 1
});

assert.strictEqual(paged.page, 2);
assert.strictEqual(paged.pageSize, 1);
assert.strictEqual(paged.results.length, 1);
assert.ok(paged.pageCount >= 2);

const clampedPage = logic.searchDictionary(riskyDictionary, {
  query: "",
  sourceMode: "starts",
  oneShotOnly: false,
  page: 999,
  pageSize: 1
});

assert.strictEqual(clampedPage.page, clampedPage.pageCount);

const initialLawDictionary = logic.createDictionary(["리본", "이불", "니은"].join("\n"));
const reverseInitialLaw = logic.searchDictionary(initialLawDictionary, {
  query: "이",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 10
});

assert.ok(reverseInitialLaw.results.some((entry) => entry.word === "이불"));
assert.ok(!reverseInitialLaw.results.some((entry) => entry.word === "리본"));
assert.ok(!reverseInitialLaw.results.some((entry) => entry.word === "니은"));

const exactDictionary = logic.createDictionary(["가나", "가나끝", "나무"].join("\n"));
const exactResult = logic.searchDictionary(exactDictionary, {
  query: "가나",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 1
});

assert.strictEqual(exactResult.results[0].word, "가나");

const oldWordExactDictionary = logic.createDictionary(["곰븨님븨", "븨나무", "나무"].join("\n"));
const oldWordReplyExact = logic.searchDictionary(oldWordExactDictionary, {
  query: "곰븨님븨",
  sourceMode: "reply",
  oneShotOnly: false,
  pageSize: 10
});

assert.strictEqual(oldWordReplyExact.results[0].word, "곰븨님븨");
assert.ok(oldWordReplyExact.results.some((entry) => entry.word === "븨나무"));

const archaicExactDictionary = logic.createDictionary(["븨피", "피리", "리본"].join("\n"));
const archaicStartsExact = logic.searchDictionary(archaicExactDictionary, {
  query: "븨피",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 1
});
const archaicReplyExact = logic.searchDictionary(archaicExactDictionary, {
  query: "븨피",
  sourceMode: "reply",
  oneShotOnly: false,
  pageSize: 10
});

assert.strictEqual(archaicStartsExact.results[0].word, "븨피");
assert.strictEqual(archaicReplyExact.results[0].word, "븨피");
assert.ok(archaicReplyExact.results.some((entry) => entry.word === "피리"));

const appendedDictionary = logic.createDictionary(["가나", "다라"].join("\n"));
assert.ok(appendedDictionary.entries.find((entry) => entry.word === "가나").oneShot);
logic.extendDictionary(appendedDictionary, "나무");
assert.ok(!appendedDictionary.entries.find((entry) => entry.word === "가나").oneShot);
assert.ok(appendedDictionary.entries.some((entry) => entry.word === "나무"));

const extendedSurfaceDictionary = logic.createDictionary(["자유롭다", "자빠지다"].join("\n"));
logic.extendDictionary(extendedSurfaceDictionary, ["자유롭", "자빠져"].join("\n"));
assert.ok(extendedSurfaceDictionary.entries.some((entry) => entry.word === "자유롭다"));
assert.ok(extendedSurfaceDictionary.entries.some((entry) => entry.word === "자빠지다"));
assert.ok(!extendedSurfaceDictionary.entries.some((entry) => entry.word === "자유롭"));
assert.ok(!extendedSurfaceDictionary.entries.some((entry) => entry.word === "자빠져"));

const oneCharDictionary = logic.createDictionary(["가", "가나", "나가"].join("\n"));
assert.strictEqual(oneCharDictionary.stats.total, 2);
assert.ok(!oneCharDictionary.entries.some((entry) => entry.word === "가"));

const blockedWordDictionary = logic.createDictionary(
  ["다름스타튬", "늠손가락", "는저가락", "늣저가락", "늦저가락", "늠밤통", "가나", "나무"].join("\n")
);
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "다름스타튬"));
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "늠손가락"));
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "는저가락"));
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "늣저가락"));
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "늦저가락"));
assert.ok(!blockedWordDictionary.entries.some((entry) => entry.word === "늠밤통"));
assert.ok(!logic.selectOnlineWords(blockedWordDictionary, ["다름스타튬"], "oneShot", {}).length);
assert.ok(
  !logic.selectOnlineWords(
    blockedWordDictionary,
    ["늠손가락", "는저가락", "늣저가락", "늦저가락", "늠밤통"],
    "oneShot",
    {}
  ).length
);

assert.ok(logic.isCombinedHangulLetterName("리을피읖"));
assert.ok(logic.isCombinedHangulLetterName("리을티읕"));
assert.ok(logic.isCombinedHangulLetterName("기역니은"));
assert.ok(!logic.isCombinedHangulLetterName("리을"));
assert.ok(!logic.isCombinedHangulLetterName("가벼운피읖"));
const letterNameDictionary = logic.createDictionary(
  ["리을", "피읖", "리을피읖", "기역니은", "가벼운피읖"].join("\n")
);
assert.ok(letterNameDictionary.entries.some((entry) => entry.word === "리을"));
assert.ok(letterNameDictionary.entries.some((entry) => entry.word === "피읖"));
assert.ok(letterNameDictionary.entries.some((entry) => entry.word === "가벼운피읖"));
assert.ok(!letterNameDictionary.entries.some((entry) => entry.word === "리을피읖"));
assert.ok(!letterNameDictionary.entries.some((entry) => entry.word === "기역니은"));
assert.deepStrictEqual(
  logic.selectOnlineWords(
    logic.createDictionary("가나"),
    ["리을티읕", "리을피읖", "리을히읗", "리본"],
    "connection",
    { mode: "starts", prefixes: ["리"] }
  ),
  ["리본"]
);

const surfaceFormDictionary = logic.createDictionary(
  [
    "가지다",
    "가져",
    "주름",
    "주름지다",
    "주름져",
    "자빠지다",
    "자빠져",
    "자유롭다",
    "자유롭",
    "자유로워",
    "윰차",
    "낏거리",
    "낏게가다",
    "낏기다",
    "낏내",
    "자갈왓",
    "가감하다",
    "가감해",
    "피하다",
    "피해",
    "내디디다",
    "내디뎌",
    "몽따다",
    "몽따쥬",
    "몽띠쥬",
    "이쁘다",
    "이쁘쥬",
    "그렇다",
    "그렇쥬",
    "그렇죠",
    "가다",
    "가지요",
    "공부하다",
    "공부해요",
    "하다",
    "해요",
    "되다",
    "돼요",
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
    "지긴지요",
    "들다",
    "들어",
    "걷다",
    "걸어",
    "다니다",
    "다녀",
    "보이다",
    "보여",
    "맞추다",
    "맞춰",
    "따라오다",
    "따라와",
    "돌보다",
    "돌봐",
    "쓰다",
    "써",
    "고르다",
    "골라",
    "아프다",
    "아파"
  ].join("\n")
);
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "가지다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "주름지다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "자빠지다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "자유롭다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "윰차"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "낏거리"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "낏게가다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "낏기다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "낏내"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "자갈왓"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "가감하다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "피해"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "내디디다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "몽따다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "이쁘다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "그렇다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "가다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "공부하다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "하다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "되다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "들다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "걷다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "다니다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "보이다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "맞추다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "따라오다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "돌보다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "쓰다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "고르다"));
assert.ok(surfaceFormDictionary.entries.some((entry) => entry.word === "아프다"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "가져"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "주름져"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "자빠져"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "자유롭"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "자유로워"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "가감해"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "내디뎌"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "몽따쥬"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "몽띠쥬"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "이쁘쥬"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "그렇쥬"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "그렇죠"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "가지요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "공부해요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "해요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "돼요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "지요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "군요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "구나"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "는구나"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "로구나"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "습니다"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "옜습니다"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "올습니다"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "읍니다"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "아요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "어요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "시어요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "으시어요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "습죠"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "읍죠"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "습지요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "읍지요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "지긴지요"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "들어"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "걸어"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "다녀"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "보여"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "맞춰"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "따라와"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "돌봐"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "써"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "골라"));
assert.ok(!surfaceFormDictionary.entries.some((entry) => entry.word === "아파"));

const onlineConnectionBase = logic.createDictionary(["나무", "무나"].join("\n"));
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineConnectionBase,
    ["가나", "가끝", "가"],
    "connection",
    { mode: "starts", prefixes: ["가"] }
  ),
  ["가나", "가끝"]
);
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineConnectionBase,
    ["가끝", "가가", "가"],
    "oneShot",
    { mode: "starts", prefixes: ["가"] }
  ),
  ["가끝", "가가"]
);
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineConnectionBase,
    ["가끝", "끝말"],
    "oneShot",
    { mode: "starts", prefixes: ["가"] }
  ),
  ["가끝"]
);
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineConnectionBase,
    ["가끝", "끝말"],
    "oneShot",
    { mode: "starts", prefixes: ["가"], includeSupplementWords: true }
  ),
  ["가끝", "끝말"]
);

const verifiedOnlineDictionary = logic.createDictionary(["가끝", "끝말"].join("\n"));
assert.ok(!verifiedOnlineDictionary.entries.find((entry) => entry.word === "가끝").oneShot);

const onlineExactBase = logic.createDictionary(["왓슨"].join("\n"));
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineExactBase,
    ["자갈왓"],
    "oneShot",
    { mode: "starts", prefixes: ["자갈왓"], exactWord: "자갈왓" }
  ),
  ["자갈왓"]
);
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineExactBase,
    ["자갈왓"],
    "connection",
    { mode: "starts", prefixes: ["자갈왓"], exactWord: "자갈왓" }
  ),
  ["자갈왓"]
);
assert.deepStrictEqual(
  logic.selectOnlineWords(
    onlineExactBase,
    ["자갈왓"],
    "connection",
    { mode: "reply", prefixes: ["왓"], exactWord: "자갈왓" }
  ),
  ["자갈왓"]
);

const usedWordBlunderDictionary = logic.createDictionary(["값표", "빵값", "빵빵"].join("\n"));
const breadBeforeUsed = logic.searchDictionary(usedWordBlunderDictionary, {
  query: "빵",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 10
});
assert.ok(!breadBeforeUsed.results.find((entry) => entry.word === "빵빵").blunder);

const breadAfterUsed = logic.searchDictionary(usedWordBlunderDictionary, {
  query: "빵",
  sourceMode: "starts",
  oneShotOnly: false,
  pageSize: 10,
  usedKeys: ["값표"]
});
const usedWordBlunder = breadAfterUsed.results.find((entry) => entry.word === "빵빵");
assert.ok(usedWordBlunder.blunder);
assert.deepStrictEqual(usedWordBlunder.oneShotReplyWords, ["빵값"]);

console.log("logic tests passed");

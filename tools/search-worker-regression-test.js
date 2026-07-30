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

function searchOptions(query, usedKeys, usedVersion, endQuery) {
  return {
    query,
    endQuery: endQuery || "",
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

    const forcedNeuiWords = ["\ubb34\ub2ac", "\uc78e\uc810\ubb34\ub2ac"];
    for (const word of forcedNeuiWords) {
      const forcedNeuiSearch = await request("search", {
        options: searchOptions(word, [], 0)
      });
      const forcedNeuiEntry = forcedNeuiSearch.payload.results.find((entry) => entry.word === word);
      assert.ok(forcedNeuiEntry, `${word} must be returned from the static dictionary pack`);
      assert.strictEqual(forcedNeuiEntry.alternativeOneShot, true);
      assert.strictEqual(forcedNeuiEntry.oneShot, false);
    }

    const usedUnaffectedBlunder = await request("search", {
      options: searchOptions("\ubfcd\uc950", ["뿍뿍", "뿍덕"], 3)
    });
    const usedUnaffectedBlunderEntry = usedUnaffectedBlunder.payload.results.find(
      (entry) => entry.word === "\ubfcd\uc950"
    );
    assert.ok(usedUnaffectedBlunderEntry, "뿍쥐 must remain visible when other words are used");
    assert.strictEqual(
      usedUnaffectedBlunderEntry.blunder,
      true,
      "an unaffected static blunder must not be downgraded to a connection"
    );
    assert.strictEqual(usedUnaffectedBlunderEntry.oneShotReplyCount, 0);
    assert.strictEqual(usedUnaffectedBlunderEntry.alternativeOneShotReplyCount, 8);

    const usedAffectedBlunder = await request("search", {
      options: searchOptions("\ubfcd\uc950", ["뿍뿍", "뿍덕", "쥐꼬리톱"], 4)
    });
    const usedAffectedBlunderEntry = usedAffectedBlunder.payload.results.find(
      (entry) => entry.word === "\ubfcd\uc950"
    );
    assert.ok(usedAffectedBlunderEntry, "뿍쥐 must remain visible after a follower is used");
    assert.strictEqual(
      usedAffectedBlunderEntry.blunder,
      true,
      "a static blunder must not be downgraded when used words affect its followers"
    );

    const duireSearch = await request("search", {
      options: searchOptions("\ub4f8\ub808", [], 0)
    });
    const duire = duireSearch.payload.results.find((entry) => entry.word === "\ub4f8\ub808");
    assert.ok(duire, "듸레 must be returned from the static dictionary pack");
    assert.strictEqual(duire.oneShot, false, "듸레 must not be classified as a one-shot word");

    const kitWord = "\uac00\uc2a4\ud0b7";
    const kitValue = "\ud0b7\uac12";
    const kitBefore = await request("search", {
      options: searchOptions(kitWord, [], 0)
    });
    const kitBeforeEntry = kitBefore.payload.results.find((entry) => entry.word === kitWord);
    assert.ok(kitBeforeEntry, "가스킷 must be returned before 킷값 is used");
    assert.strictEqual(kitBeforeEntry.followerCount, 1);
    assert.strictEqual(kitBeforeEntry.oneShot, false);

    const kitAfter = await request("search", {
      options: searchOptions(kitWord, [kitValue], 1)
    });
    const kitAfterEntry = kitAfter.payload.results.find((entry) => entry.word === kitWord);
    assert.ok(kitAfterEntry, "가스킷 must remain visible after 킷값 is used");
    assert.strictEqual(kitAfterEntry.followerCount, 0, "using 킷값 must remove the only 킷 follower");
    assert.strictEqual(kitAfterEntry.oneShot, true, "가스킷 must become a one-shot after 킷값 is used");

    const altAfterUsed = await request("search", {
      options: searchOptions("안줸", ["줸으른", "줸댁"], 2)
    });
    const altAfterUsedEntry = altAfterUsed.payload.results.find((entry) => entry.word === "안줸");
    assert.ok(altAfterUsedEntry, "안줸 must remain visible after its safe and alternative followers are used");
    assert.strictEqual(altAfterUsedEntry.followerCount, 3);
    assert.strictEqual(
      altAfterUsedEntry.alternativeOneShot,
      true,
      "a word whose remaining followers are blunders must become an alternative one-shot"
    );

    const valueSearch = await request("search", { options: searchOptions("\uac12", [], 0) });
    const standardValueSearch = await request("search", { options: searchOptions("\ud45c\uc900\uac12", [], 0) });
    const valueTable = valueSearch.payload.results.find((entry) => entry.word === "\uac12\ud45c");
    const standardValue = standardValueSearch.payload.results.find((entry) => entry.word === "\ud45c\uc900\uac12");
    assert.ok(valueTable, "값표 must be returned for 값");
    assert.strictEqual(valueTable.blunder, true);
    assert.ok(valueTable.alternativeOneShotReplyCount >= 1);
    assert.ok(standardValue && standardValue.alternativeOneShot, "표준값 must be an alternative one-shot");

    const firstCounterSearch = await request("search", {
      options: searchOptions("\uc2a8\uc7a0", [], 0)
    });
    const firstCounter = firstCounterSearch.payload.results.find(
      (entry) => entry.word === "\uc2a8\uc7a0"
    );
    assert.ok(firstCounter && firstCounter.blunder, "슨잠 must be a blunder");
    assert.ok(
      firstCounter.oneShotReplyWords.includes("\uc7a0\uaf4c"),
      "first search must include 잠꽌 as the one-shot counter"
    );
    assert.ok(
      firstCounter.alternativeOneShotReplyWords.includes("\uc7a0\ubc84\ub987"),
      "first search must include 잠버릇 as an alternative counter"
    );

    const largeCounterSearch = await request("search", {
      options: searchOptions("\uc2a8\uac70", [], 0)
    });
    const largeCounter = largeCounterSearch.payload.results.find(
      (entry) => entry.word === "\uc2a8\uac70"
    );
    assert.ok(largeCounter && largeCounter.blunder, "슨거 must be a blunder");
    assert.ok(
      largeCounter.oneShotReplyWords.includes("\uac70\uba15"),
      "large reply buckets must still include 거먕 as the one-shot counter"
    );
    assert.ok(
      largeCounter.alternativeOneShotReplyWords.length > 0,
      "large reply buckets must include alternative counter words"
    );

    const orderedBlunderSearch = await request("search", {
      options: searchOptions("\uac07", [], 0)
    });
    const orderedBlunders = orderedBlunderSearch.payload.results.filter((entry) => entry.blunder);
    for (let index = 1; index < orderedBlunders.length; index += 1) {
      const previous = orderedBlunders[index - 1];
      const current = orderedBlunders[index];
      assert.ok(
        previous.alternativeOneShotReplyCount < current.alternativeOneShotReplyCount ||
          (previous.alternativeOneShotReplyCount === current.alternativeOneShotReplyCount &&
            previous.oneShotReplyCount <= current.oneShotReplyCount),
        "blunders must sort by fewer alternative counters, then fewer one-shot counters"
      );
    }

    const broadUsedSearch = await request("search", {
      options: searchOptions("\ud504", ["\uac12\ud45c"], 1)
    });
    assert.strictEqual(broadUsedSearch.type, "searchResult");
    assert.strictEqual(broadUsedSearch.payload.timing.followerMs, 0);
    assert.ok(
      broadUsedSearch.payload.timing.searchMs < 100,
      `used-word search CPU must stay responsive (${broadUsedSearch.payload.timing.searchMs}ms)`
    );

    const customBuilt = await request("buildDefault", {
      extraText: "\ub05d\ud7a3\n\ub05d\uc00d\n\ub05d\ub9c8\ub098\n\ud7a3\uc00d"
    });
    assert.strictEqual(customBuilt.type, "built");

    const endHihSearch = await request("search", {
      options: searchOptions("\ub05d", [], 0, "\ud7a3")
    });
    assert.ok(endHihSearch.payload.results.some((entry) => entry.word === "\ub05d\ud7a3"));
    assert.ok(endHihSearch.payload.results.every((entry) => entry.reading.endsWith("\ud7a3")));
    assert.strictEqual(endHihSearch.payload.queryInfo.endReading, "\ud7a3");

    const endPpengSearch = await request("search", {
      options: searchOptions("\ub05d", [], 0, "\uc00d")
    });
    assert.ok(endPpengSearch.payload.results.some((entry) => entry.word === "\ub05d\uc00d"));
    assert.ok(endPpengSearch.payload.results.every((entry) => entry.reading.endsWith("\uc00d")));

    const multiEndSearch = await request("search", {
      options: searchOptions("\ub05d", [], 0, "\ub9c8\ub098")
    });
    assert.ok(multiEndSearch.payload.results.some((entry) => entry.word === "\ub05d\ub9c8\ub098"));
    assert.ok(multiEndSearch.payload.results.every((entry) => entry.reading.endsWith("\ub9c8\ub098")));

    const exactEndMismatchSearch = await request("search", {
      options: searchOptions("\ub05d\ud7a3", [], 0, "\uc00d")
    });
    assert.ok(!exactEndMismatchSearch.payload.results.some((entry) => entry.word === "\ub05d\ud7a3"));

    const cachedEndHihSearch = await request("search", {
      options: searchOptions("\ub05d", [], 0, "\ud7a3")
    });
    assert.strictEqual(cachedEndHihSearch.payload.timing.cacheHit, true);
    assert.ok(cachedEndHihSearch.payload.results.every((entry) => entry.reading.endsWith("\ud7a3")));

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

    const clampedPage = await request("search", {
      options: {
        ...searchOptions("\ub05d", [], 0),
        page: Number.MAX_SAFE_INTEGER,
        pageSize: Number.MAX_SAFE_INTEGER
      }
    });
    assert.ok(clampedPage.payload.pageSize <= 200, "worker page size must be capped");
    assert.ok(clampedPage.payload.results.length <= 200, "worker result payload must be capped");

    console.log("search worker regression tests passed");
  } finally {
    await worker.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

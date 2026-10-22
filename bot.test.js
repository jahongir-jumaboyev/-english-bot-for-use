const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendSentenceLines,
  countSentenceLines,
  createWebhookServer,
  createSerialQueue,
  dueQueue,
  dueReminders,
  escapeText,
  formatGrade,
  formatSentenceReview,
  findAnswerKey,
  gradeAnswers,
  helpMessage,
  getTransportMode,
  loadVocabulary,
  localDate,
  mainMenuKeyboard,
  makeProgress,
  motivationForProgress,
  migrateVocabulary,
  normalizeAnswer,
  parseAnswers,
  parseSentenceReview,
  recordTaskSubmission,
  reviewMessage,
  reviewSchedule,
  splitMessage,
  statsMessage,
  vocabularySourceKeyboard,
  vocabularyUnitKeyboard,
} = require("./bot");

test("review schedule uses the requested six intervals", () => {
  const start = Date.UTC(2026, 0, 1);
  assert.deepEqual(reviewSchedule(start), [
    start + 25 * 60 * 1000,
    start + 10 * 60 * 60 * 1000,
    start + 24 * 60 * 60 * 1000,
    start + 4 * 24 * 60 * 60 * 1000,
    start + 14 * 24 * 60 * 60 * 1000,
    start + 30 * 24 * 60 * 60 * 1000,
  ]);
});

test("sentence submission counts non-empty lines", () => {
  assert.equal(countSentenceLines("I study.\n\nShe reads.\n They listen. "), 3);
});

test("sentence submission rejects extra lines instead of silently discarding them", () => {
  const user = { days: {} };
  user.pendingInput = { type: "sentences" };
  const initial = appendSentenceLines(user, "2026-01-01", Array.from({ length: 28 }, (_, index) => `Sentence ${index + 1}`), 101);
  assert.equal(initial.accepted, true);
  const duplicate = appendSentenceLines(user, "2026-01-01", ["Sentence 28"], 101);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.count, 28);
  const extra = appendSentenceLines(user, "2026-01-01", ["Sentence 29", "Sentence 30", "Sentence 31"], 102);
  assert.deepEqual(extra, { accepted: false, count: 28, remaining: 2 });
  assert.equal(user.days["2026-01-01"].submissions.sentences.length, 28);
  const finish = appendSentenceLines(user, "2026-01-01", ["Sentence 29", "Sentence 30"], 103);
  assert.equal(finish.completed, true);
  assert.equal(user.days["2026-01-01"].tasks.sentences, true);
});

test("grammar, reading, and listening submissions are stored with their completion status", () => {
  const user = { days: {} };
  recordTaskSubmission(user, "grammar", "Murphy Unit 1", "2026-01-01");
  recordTaskSubmission(user, "reading", "1A, 2C, 3B", "2026-01-01");
  recordTaskSubmission(user, "listening", "1D, 2A", "2026-01-01");
  const daily = user.days["2026-01-01"];
  assert.deepEqual(daily.submissions, {
    grammar: "Murphy Unit 1",
    reading: "1A, 2C, 3B",
    listening: "1D, 2A",
  });
  assert.deepEqual(daily.tasks, { grammar: true, reading: true, listening: true });
});

test("answer normalization ignores case, whitespace, and basic punctuation", () => {
  assert.equal(normalizeAnswer("  I'M  READY! "), "i'm ready");
});

test("Telegram message sanitization preserves line breaks", () => {
  assert.equal(escapeText("first\r\nsecond\u0000third"), "first\nsecond third");
});

test("help lists commands in sections with executable examples", () => {
  const help = helpMessage();
  assert.match(help, /LUG‘AT[\s\S]*\/vocab A 1[\s\S]*\/vocab B 1/u);
  assert.match(help, /KUNLIK VAZIFALAR[\s\S]*\/tasks[\s\S]*\/progress/u);
  assert.match(help, /VAZIFA TOPSHIRISH[\s\S]*\/submit listening[\s\S]*\/submit reading/u);
  assert.match(help, /\/done grammar[\s\S]*\/done listening[\s\S]*\/done reading[\s\S]*\/done sentences/u);
  assert.match(help, /\/sentences[\s\S]*\/help/u);
});

test("start menu offers inline buttons for every study action", () => {
  const keyboard = mainMenuKeyboard().inline_keyboard;
  const callbackData = keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbackData, [
    "menu:vocab",
    "menu:review",
    "menu:tasks",
    "menu:progress",
    "menu:grammar",
    "menu:listening",
    "menu:reading",
    "menu:sentences",
    "menu:stats",
  ]);
});

test("vocabulary inline menus cover both books and all 30 units", () => {
  assert.deepEqual(vocabularySourceKeyboard().inline_keyboard[0].map((button) => button.callback_data), [
    "vocab:source:A",
    "vocab:source:B",
  ]);
  const units = vocabularyUnitKeyboard("B").inline_keyboard.flat()
    .filter((button) => button.callback_data.startsWith("vocab:B:"));
  assert.deepEqual(units.map((button) => button.callback_data), Array.from(
    { length: 30 },
    (_, index) => `vocab:B:${index + 1}`,
  ));
});

test("scheduled work and webhook updates run in a single ordered queue", async () => {
  const events = [];
  const enqueue = createSerialQueue((error) => { throw error; });
  const first = enqueue(async () => {
    events.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("first-end");
  });
  const second = enqueue(async () => events.push("second"));
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("transport defaults to polling locally and webhook on Render", () => {
  assert.equal(getTransportMode({}), "polling");
  assert.equal(
    getTransportMode({ BOT_MODE: "polling", RENDER_EXTERNAL_HOSTNAME: "example.onrender.com" }),
    "polling",
  );
  assert.equal(getTransportMode({ RENDER_EXTERNAL_HOSTNAME: "example.onrender.com" }), "webhook");
  assert.equal(getTransportMode({ WEBHOOK_URL: "https://bot.example.com/telegram" }), "webhook");
  assert.throws(() => getTransportMode({ BOT_MODE: "invalid" }), /BOT_MODE/u);
});

test("due reviews are limited to overdue unchecked stages", () => {
  const user = {
    vocabulary: [{
      id: "A-1",
      reviewAt: [10, 20, 30],
      reviewed: [true, false, false],
    }],
  };
  assert.deepEqual(dueQueue(user, 25), [{ itemId: "A-1", stage: 1 }]);
});

test("daily progress includes the four fixed study tasks and required vocabulary", () => {
  const user = {
    days: { "2026-01-01": { tasks: { grammar: true }, newUnits: ["A-1"] } },
    vocabulary: [],
  };
  const progress = makeProgress(user, "2026-01-01", Date.UTC(2026, 0, 1));
  assert.equal(progress.total, 5);
  assert.equal(progress.completed, 2);
  assert.equal(progress.percent, 40);
});

test("local day applies the configured Uzbekistan offset by default", () => {
  assert.equal(localDate(new Date("2026-01-01T20:30:00.000Z")), "2026-01-02");
});

test("both supplied vocabulary files load all 30 units and preserve their word counts", async () => {
  const books = await loadVocabulary();
  assert.deepEqual([...books.A.keys()], Array.from({ length: 30 }, (_, index) => index + 1));
  assert.deepEqual([...books.B.keys()], Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal([...books.A.values()].reduce((total, words) => total + words.length, 0), 599);
  assert.equal(books.A.get(26).length, 19);
  assert.ok([...books.A.entries()].filter(([unit]) => unit !== 26).every(([, words]) => words.length === 20));
  assert.equal([...books.B.values()].reduce((total, words) => total + words.length, 0), 600);
  assert.ok([...books.B.values()].every((words) => words.length === 20));
});

test("completed vocabulary reviews remain in the daily progress denominator", () => {
  const now = Date.UTC(2026, 0, 1);
  const user = {
    days: { "2026-01-01": { tasks: {}, newUnits: [] } },
    vocabulary: [{
      reviewAt: [now - 1],
      reviewed: [true],
    }],
  };
  const progress = makeProgress(user, "2026-01-01", now);
  assert.equal(progress.rows[0].key, "vocabulary");
  assert.equal(progress.rows[0].done, true);
});

test("motivation responds positively to different levels of daily progress", () => {
  assert.match(motivationForProgress(0), /kichik bir qadamdan boshlang/u);
  assert.match(motivationForProgress(40), /yana bir qadam/u);
  assert.match(motivationForProgress(80), /Qolgan vazifalar/u);
  assert.match(motivationForProgress(100), /faxrlaning/u);
});

test("webhook exposes health check, rejects untrusted requests, and accepts Telegram updates", async (context) => {
  const received = [];
  const server = createWebhookServer("test-secret", async (update) => received.push(update));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");

  const unauthorized = await fetch(`${baseUrl}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 1 }),
  });
  assert.equal(unauthorized.status, 403);
  assert.deepEqual(received, []);

  const update = { update_id: 2, message: { text: "/start" } };
  const accepted = await fetch(`${baseUrl}/telegram`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret",
    },
    body: JSON.stringify(update),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(received, [update]);
});

test("answers are parsed from one line, many lines, and numbered formats", () => {
  assert.deepEqual([...parseAnswers("1A 2C 3B")], [[1, "A"], [2, "C"], [3, "B"]]);
  assert.deepEqual([...parseAnswers("1. A\n2. C\n3) b")], [[1, "A"], [2, "C"], [3, "b"]]);
  assert.deepEqual([...parseAnswers("1D, 2A")], [[1, "D"], [2, "A"]]);
  assert.deepEqual(
    [...parseAnswers("1 true 2 not given 3-false")],
    [[1, "true"], [2, "not given"], [3, "false"]],
  );
});

test("grading finds wrong and missing answers and accepts alternatives", () => {
  const key = { 1: "A", 2: "C", 3: "color|colour", 4: "B" };
  const grade = gradeAnswers(key, parseAnswers("1a 2B 3 Colour"));
  assert.equal(grade.correct, 2);
  assert.equal(grade.total, 4);
  assert.equal(grade.percent, 50);
  assert.deepEqual(grade.wrong, [
    { n: 2, given: "B", expected: "C" },
    { n: 4, given: null, expected: "B" },
  ]);
  const text = formatGrade("listening", "Unit 3", grade);
  assert.match(text, /2\/4 \(50%\)/u);
  assert.match(text, /2\) siz: B → to‘g‘ri: C/u);
  assert.match(text, /4\) siz: javob yo‘q/u);
});

test("answer keys are found regardless of case and spacing in the test name", () => {
  const sources = [{ listening: {}, reading: {} }, { listening: { "Unit  3": { 1: "A" } } }];
  assert.deepEqual(findAnswerKey(sources, "listening", " unit 3 "), { 1: "A" });
  assert.equal(findAnswerKey(sources, "reading", "unit 3"), null);
});

test("sentence review is parsed from model output and unreviewed sentences count as wrong", () => {
  const raw = 'Here you go: {"results":[{"n":1,"ok":true},{"n":2,"ok":false,"correction":"I went.","note":"Past simple"}]}';
  const review = parseSentenceReview(raw, 3);
  assert.equal(review.correct, 1);
  assert.equal(review.total, 3);
  assert.equal(review.percent, 33);
  assert.equal(parseSentenceReview("not json", 3), null);
  const text = formatSentenceReview(review, ["I study.", "I go yesterday.", "She reads."]);
  assert.match(text, /1\/3 to‘g‘ri/u);
  assert.match(text, /2\) I go yesterday\. → I went\./u);
});

test("vocabulary review message hides meanings in spoilers and escapes HTML", () => {
  const text = reviewMessage({ source: "A", unit: 2, words: [{ word: "a<b", meaning: "x & y" }] }, 1);
  assert.match(text, /Takrorlash 2\/6/u);
  assert.match(text, /a&lt;b — <tg-spoiler>x &amp; y<\/tg-spoiler>/u);
});

test("old word-level vocabulary state migrates to one entry per unit", () => {
  const reviewAt = reviewSchedule(1000);
  const migrated = migrateVocabulary([
    { id: "A-1-1000-0", source: "A", unit: 1, word: "one", meaning: "bir", reviewAt, reviewed: [true, false, false, false, false, false] },
    { id: "A-1-1000-1", source: "A", unit: 1, word: "two", meaning: "ikki", reviewAt, reviewed: [true, false, false, false, false, false] },
  ]);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].id, "A-1");
  assert.equal(migrated[0].words.length, 2);
  assert.equal(migrated[0].reviewed[0], true);
});

test("reminders fire by local hour, skip finished tasks and stop at report time", () => {
  const at = (hourUtc) => new Date(Date.UTC(2026, 0, 1, hourUtc, 0)); // UTC+5 by default
  const tasks = (user, now) => dueReminders(user, now).map((slot) => slot.task);
  assert.deepEqual(tasks({ days: {} }, at(4)), []); // 09:00
  assert.deepEqual(tasks({ days: {} }, at(5)), ["grammar"]); // 10:00
  const grammarDone = { days: { "2026-01-01": { tasks: { grammar: true } } } };
  assert.deepEqual(tasks(grammarDone, at(12)), ["listening", "reading"]); // 17:00
  const alreadySent = { days: {}, reminded: { day: "2026-01-01", keys: ["grammar", "listening"] } };
  assert.deepEqual(tasks(alreadySent, at(12)), ["reading"]);
  assert.deepEqual(tasks({ days: {} }, at(16)), []); // 21:00 is the evening report, not a reminder
});

test("long messages are split on line boundaries", () => {
  const text = Array.from({ length: 50 }, (_, index) => `line ${index} ${"x".repeat(80)}`).join("\n");
  const chunks = splitMessage(text, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.equal(chunks.join("\n"), text);
  assert.deepEqual(splitMessage("short"), ["short"]);
});

test("statistics summarise vocabulary, graded tests and sentences", () => {
  const user = {
    vocabulary: [{ words: [{}, {}], reviewed: [true, true, true, true, true, true], reviewAt: [] }],
    days: {
      "2026-01-01": {
        tasks: { grammar: true, sentences: true },
        newUnits: ["A-1"],
        results: {
          listening: [{ checked: true, percent: 80 }],
          reading: [{ checked: true, percent: 60 }, { checked: false }],
          sentences: { correct: 24, total: 30 },
        },
      },
    },
  };
  const text = statsMessage(user);
  assert.match(text, /1 unit \(2 so‘z\), 6\/6 takrorlash/u);
  assert.match(text, /Listening: 1 ta topshirildi, o‘rtacha 80%/u);
  assert.match(text, /Reading: 2 ta topshirildi, o‘rtacha 60%/u);
  assert.match(text, /24\/30 to‘g‘ri \(80%\)/u);
});

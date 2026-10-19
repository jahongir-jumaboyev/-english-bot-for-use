const test = require("node:test");
const assert = require("node:assert/strict");
const {
  countSentenceLines,
  createWebhookServer,
  dueQueue,
  loadVocabulary,
  localDate,
  makeProgress,
  motivationForProgress,
  normalizeAnswer,
  reviewSchedule,
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

test("answer normalization ignores case, whitespace, and basic punctuation", () => {
  assert.equal(normalizeAnswer("  I'M  READY! "), "i'm ready");
});

test("due reviews are limited to overdue unchecked stages", () => {
  const user = {
    vocabulary: [{
      id: "A-1-1-0",
      reviewAt: [10, 20, 30],
      reviewed: [true, false, false],
    }],
  };
  assert.deepEqual(dueQueue(user, 25), [{ itemId: "A-1-1-0", stage: 1 }]);
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

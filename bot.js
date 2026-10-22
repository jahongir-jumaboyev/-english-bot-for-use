const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const TOKEN = process.env.BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ROOT = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "state.json");
const MATERIALS_DIR = process.env.MATERIALS_DIR || ROOT;
const TZ_OFFSET_VALUE = process.env.TZ_OFFSET_MINUTES || "300";
const TZ_OFFSET_MINUTES = Number(TZ_OFFSET_VALUE);
const REPORT_HOUR = Number(process.env.DAILY_REPORT_HOUR || "21");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const AUTO_BACKUP = process.env.AUTO_BACKUP !== "0";
const DAY_MS = 24 * 60 * 60 * 1000;
// 25 daqiqa, 10 soat (8–12), 24 soat, 4 kun (3–5), 14 kun, 30 kun
const REVIEW_DELAYS = [
  25 * 60 * 1000,
  10 * 60 * 60 * 1000,
  DAY_MS,
  4 * DAY_MS,
  14 * DAY_MS,
  30 * DAY_MS,
];
const WEBHOOK_PATH = "/telegram";
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_REVIEWS_PER_TICK = 8;
const TASKS = ["grammar", "listening", "reading", "sentences"];
const TASK_LABELS = {
  vocabulary: "Lug‘at takrorlash",
  grammar: "Grammatika",
  listening: "Listening",
  reading: "Reading",
  sentences: "Murphy bo‘yicha 30 ta gap",
};
const BOOKS = {
  A: { file: "word_list.json", name: "word_list.json" },
  B: { file: "words2.json", name: "words2.json" },
};
// Kun davomida eslatmalar (mahalliy vaqt bo‘yicha). Vazifa bajarilgan bo‘lsa, yuborilmaydi.
const REMINDER_SLOTS = [
  { hour: 10, task: "grammar", text: "☀️ Murphy’dan bugungi grammatika mavzusini o‘qidingizmi?", action: "✍️ Mavzuni yozaman" },
  { hour: 15, task: "listening", text: "🎧 Listening vaqti! Bugungi listening javoblaringizni yuboring.", action: "📤 Javob yuboraman" },
  { hour: 17, task: "reading", text: "📖 Reading vaqti! Bugungi reading javoblaringizni yuboring.", action: "📤 Javob yuboraman" },
  { hour: 19, task: "sentences", text: "📝 Murphy mavzusi bo‘yicha 30 ta gap yozish vaqti keldi.", action: "📝 Gap yuboraman" },
];

function localDate(now = new Date()) {
  return new Date(now.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

function localHour(now = new Date()) {
  return new Date(now.getTime() + TZ_OFFSET_MINUTES * 60_000).getUTCHours();
}

function localDateTime(timestamp) {
  return new Date(timestamp + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function reviewSchedule(learnedAt) {
  return REVIEW_DELAYS.map((delay) => learnedAt + delay);
}

function countSentenceLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function appendSentenceLines(user, day, lines, messageId) {
  const daily = getDay(user, day);
  const savedLines = daily.submissions.sentences;
  const currentLines = Array.isArray(savedLines) ? savedLines : [];
  const remaining = 30 - currentLines.length;
  if (Number.isInteger(messageId) && user.pendingInput?.lastMessageId === messageId) {
    return { accepted: false, duplicate: true, count: currentLines.length, remaining };
  }
  if (lines.length === 0 || lines.length > remaining) {
    return { accepted: false, count: currentLines.length, remaining };
  }
  if (Number.isInteger(messageId) && user.pendingInput) {
    user.pendingInput.lastMessageId = messageId;
  }
  daily.submissions.sentences = [...currentLines, ...lines];
  const count = daily.submissions.sentences.length;
  if (count === 30) daily.tasks.sentences = true;
  return { accepted: true, count, remaining: 30 - count, completed: count === 30 };
}

function recordTaskSubmission(user, task, content, day) {
  const daily = getDay(user, day);
  daily.tasks[task] = true;
  daily.submissions[task] = content;
}

function emptyDay() {
  return { tasks: {}, newUnits: [], submissions: {}, results: {} };
}

function getDay(user, day) {
  user.days ||= {};
  if (!user.days[day]) user.days[day] = emptyDay();
  const daily = user.days[day];
  daily.tasks ||= {};
  daily.newUnits ||= [];
  daily.submissions ||= {};
  daily.results ||= {};
  return daily;
}

/* ---------- Javoblarni tekshirish (listening / reading) ---------- */

function normalizeTestId(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/gu, " ");
}

// "1A 2C 3B", "1. A\n2. C", "1-true, 2-false", "1 not given" kabi formatlarni o‘qiydi.
function parseAnswers(text) {
  const answers = new Map();
  const pattern = /(\d{1,3})\s*[.):\-–=]?\s*([^\d\s][^\n,;]*?)(?=\s+\d{1,3}\s*[.):\-–=]?\s*[^\d\s]|\s*[\n,;]|$)/gu;
  for (const match of String(text).replace(/\r/gu, "").matchAll(pattern)) {
    answers.set(Number(match[1]), match[2].trim());
  }
  return answers;
}

function answersToKey(answers) {
  return Object.fromEntries([...answers.entries()].sort(([a], [b]) => a - b).map(([n, v]) => [String(n), v]));
}

// Kalitda muqobil javoblar "|" bilan yoziladi: "color|colour".
function gradeAnswers(key, given) {
  const entries = Object.entries(key)
    .map(([n, value]) => [Number(n), String(value)])
    .sort(([a], [b]) => a - b);
  const wrong = [];
  let correct = 0;
  for (const [n, expected] of entries) {
    const answer = given.get(n);
    const accepted = expected.split("|").map(normalizeAnswer);
    if (answer !== undefined && accepted.includes(normalizeAnswer(answer))) {
      correct += 1;
    } else {
      wrong.push({ n, given: answer ?? null, expected: expected.split("|")[0] });
    }
  }
  const total = entries.length;
  return { correct, total, percent: total ? Math.round((correct / total) * 100) : 0, wrong };
}

function findAnswerKey(sources, type, testId) {
  const id = normalizeTestId(testId);
  for (const source of sources) {
    const tests = source?.[type];
    if (!tests) continue;
    for (const [name, key] of Object.entries(tests)) {
      if (normalizeTestId(name) === id) return key;
    }
  }
  return null;
}

function formatGrade(type, testId, grade) {
  const lines = [`${TASK_LABELS[type]} — ${testId}: ${grade.correct}/${grade.total} (${grade.percent}%)`];
  if (grade.wrong.length === 0) {
    lines.push("", "🎉 Xato yo‘q!");
  } else {
    lines.push("", `❌ Xatolar (${grade.wrong.length} ta):`);
    for (const item of grade.wrong.slice(0, 40)) {
      lines.push(`${item.n}) siz: ${item.given ?? "javob yo‘q"} → to‘g‘ri: ${item.expected}`);
    }
  }
  return lines.join("\n");
}

function storeResult(daily, type, entry) {
  const list = Array.isArray(daily.results[type]) ? daily.results[type] : [];
  const id = normalizeTestId(entry.testId);
  const index = list.findIndex((item) => normalizeTestId(item.testId) === id);
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  daily.results[type] = list;
}

/* ---------- Gaplarni tekshirish (ixtiyoriy AI) ---------- */

function parseSentenceReview(text, count) {
  const match = String(text).match(/\{[\s\S]*\}/u);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.results)) return null;
  const byNumber = new Map(parsed.results.map((item) => [Number(item.n), item]));
  const items = [];
  for (let n = 1; n <= count; n += 1) {
    const item = byNumber.get(n);
    items.push({
      n,
      ok: item ? item.ok === true : false,
      correction: item?.correction ? String(item.correction) : "",
      note: item?.note ? String(item.note) : "",
    });
  }
  const correct = items.filter((item) => item.ok).length;
  return { correct, total: count, percent: count ? Math.round((correct / count) * 100) : 0, items };
}

function formatSentenceReview(review, sentences = []) {
  const lines = [`📝 Gaplar natijasi: ${review.correct}/${review.total} to‘g‘ri (${review.percent}%)`];
  const wrong = review.items.filter((item) => !item.ok);
  if (wrong.length === 0) {
    lines.push("", "🎉 Barcha gaplar to‘g‘ri!");
  } else {
    lines.push("", "❌ Tuzatish kerak bo‘lganlar:");
    for (const item of wrong) {
      const original = sentences[item.n - 1];
      lines.push(`${item.n}) ${original ? `${original} → ` : ""}${item.correction || "tekshiring"}`);
      if (item.note) lines.push(`   💡 ${item.note}`);
    }
  }
  return lines.join("\n");
}

async function callClaude(system, userText) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userText }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic API failed: ${data.error?.message || response.statusText}`);
  return (data.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function checkSentences(sentences, topic) {
  if (!ANTHROPIC_API_KEY) return null;
  const system = [
    "You are a strict but kind English teacher checking a learner's sentences.",
    topic ? `The grammar topic is: ${topic}. A sentence that is grammatically correct but ignores the topic is still ok, mention it in the note.` : "",
    "For every numbered sentence decide if it is grammatically correct and natural.",
    "Reply with JSON only, no markdown: {\"results\":[{\"n\":1,\"ok\":true,\"correction\":\"\",\"note\":\"\"}]}.",
    "If ok is false, put the corrected sentence in correction and a short explanation in Uzbek (Latin script) in note.",
    "Minor style preferences are not errors.",
  ].filter(Boolean).join(" ");
  const numbered = sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n");
  try {
    const text = await callClaude(system, numbered);
    return parseSentenceReview(text, sentences.length);
  } catch (error) {
    console.error("Sentence check failed:", error);
    return null;
  }
}

/* ---------- Progress ---------- */

function makeProgress(user, day, now = Date.now()) {
  const daily = getDay(user, day);
  const reviewItems = (user.vocabulary || []).filter((item) =>
    item.reviewAt.some((time) => time <= now),
  );
  const vocabularyRequired = reviewItems.length > 0 || daily.newUnits.length > 0;
  const vocabularyDone =
    (daily.newUnits.length > 0 || reviewItems.length > 0) &&
    reviewItems.every((item) =>
      item.reviewAt.every((time, index) => time > now || item.reviewed[index]),
    );
  const rows = [];
  if (vocabularyRequired) {
    rows.push({
      key: "vocabulary",
      label: TASK_LABELS.vocabulary,
      done: vocabularyDone,
      required: true,
    });
  }
  for (const key of TASKS) {
    rows.push({
      key,
      label: TASK_LABELS[key],
      done: daily.tasks[key] === true,
      required: true,
    });
  }
  const completed = rows.filter((row) => row.done).length;
  return { completed, total: rows.length, percent: rows.length ? Math.round((completed / rows.length) * 100) : 0, rows };
}

function motivationForProgress(percent) {
  if (percent >= 100) return "Ajoyib! Bugungi barcha vazifalarni bajardingiz — izchilligingiz bilan faxrlaning.";
  if (percent >= 60) return "Juda yaxshi ketyapsiz! Qolgan vazifalar ham qo‘lingizdan keladi.";
  if (percent > 0) return "Har bir bajarilgan vazifa — maqsadingizga yaqinlashgan yana bir qadam.";
  return "Bugun kichik bir qadamdan boshlang. Muhimi — davom etish.";
}

function resultDetail(daily, key) {
  const results = daily.results?.[key];
  if (key === "sentences" && results && !Array.isArray(results)) {
    return ` — ${results.correct}/${results.total} to‘g‘ri`;
  }
  if (Array.isArray(results)) {
    const checked = results.filter((item) => item.checked);
    if (checked.length) return ` — ${checked.map((item) => `${item.correct}/${item.total}`).join(", ")}`;
    if (results.length) return " — kalit yo‘q, tekshirilmadi";
  }
  return "";
}

function averagePercent(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function statsMessage(user) {
  const days = Object.values(user.days || {});
  const grammarDays = days.filter((daily) => daily.tasks?.grammar).length;
  const collect = (type) => days.flatMap((daily) => (Array.isArray(daily.results?.[type]) ? daily.results[type] : []));
  const listening = collect("listening");
  const reading = collect("reading");
  const listeningChecked = listening.filter((item) => item.checked);
  const readingChecked = reading.filter((item) => item.checked);
  const sentenceDays = days.filter((daily) => daily.tasks?.sentences).length;
  const sentenceResults = days.map((daily) => daily.results?.sentences).filter((item) => item && !Array.isArray(item));
  const sentenceCorrect = sentenceResults.reduce((sum, item) => sum + item.correct, 0);
  const sentenceTotal = sentenceResults.reduce((sum, item) => sum + item.total, 0);
  const vocabulary = user.vocabulary || [];
  const wordCount = vocabulary.reduce((sum, item) => sum + (item.words?.length || 0), 0);
  const reviewsDone = vocabulary.reduce((sum, item) => sum + item.reviewed.filter(Boolean).length, 0);
  const mastered = vocabulary.filter((item) => item.reviewed.every(Boolean)).length;
  const activeDays = days.filter((daily) => Object.values(daily.tasks || {}).some(Boolean) || (daily.newUnits || []).length).length;
  const listeningAverage = averagePercent(listeningChecked.map((item) => item.percent));
  const readingAverage = averagePercent(readingChecked.map((item) => item.percent));
  const lines = [
    "📈 Umumiy statistika",
    "",
    `Faol kunlar: ${activeDays}`,
    "",
    `📚 Lug‘at: ${vocabulary.length} unit (${wordCount} so‘z), ${reviewsDone}/${vocabulary.length * 6} takrorlash bajarilgan, ${mastered} unit 6 bosqichdan ham o‘tgan`,
    `✍️ Grammatika: ${grammarDays} kun`,
    `🎧 Listening: ${listening.length} ta topshirildi${listeningAverage === null ? "" : `, o‘rtacha ${listeningAverage}%`}`,
    `📖 Reading: ${reading.length} ta topshirildi${readingAverage === null ? "" : `, o‘rtacha ${readingAverage}%`}`,
    `📝 Gaplar: ${sentenceDays} kun 30 tadan yozilgan${sentenceTotal ? `, jami ${sentenceCorrect}/${sentenceTotal} to‘g‘ri (${Math.round((sentenceCorrect / sentenceTotal) * 100)}%)` : ""}`,
  ];
  return lines.join("\n");
}

function helpMessage() {
  return [
    "Salom! Men ingliz tili mustaqil o‘qishingizni kuzataman.",
    "",
    "LUG‘AT",
    "/vocab A 1 — A kitobidan 1-unitni qo‘shish.",
    "/vocab B 1 — B kitobidan 1-unitni qo‘shish.",
    "A — word_list.json, B — words2.json; har birida 30 unit bor.",
    "Takrorlash 25 daqiqa, 10 soat, 24 soat, 4, 14 va 30 kundan keyin o‘zi so‘raladi.",
    "",
    "TAKRORLASH",
    "/review — vaqti kelgan lug‘atlarni takrorlash.",
    "",
    "KUNLIK VAZIFALAR",
    "/tasks — bugungi vazifalar ro‘yxatini ochish.",
    "/progress — bugungi bajarilgan ishlar natijasi.",
    "/stats — umumiy statistika.",
    "/done grammar — grammatikani bajarilgan deb belgilash.",
    "/done listening — listening vazifasini bajarilgan deb belgilash.",
    "/done reading — reading vazifasini bajarilgan deb belgilash.",
    "/done sentences — gap yozish vazifasini bajarilgan deb belgilash.",
    "",
    "VAZIFA TOPSHIRISH",
    "/grammar — Murphy’dan o‘qigan unit yoki mavzuni yuborish.",
    "/submit listening 3 — 3-test javoblarini yuborish (masalan: 1A 2C 3B).",
    "/submit reading 3 — 3-test javoblarini yuborish.",
    "/sentences — 30 ta gapni, har birini alohida qatorda yuborish.",
    "/checksentences — bugungi gaplarni qayta tekshirish.",
    "",
    "JAVOB KALITLARI",
    "/setkey listening 3 — keyingi qatorlarda kalit: 1A, 2C, 3B ...",
    "",
    "ZAXIRA",
    "/backup — ma’lumotlaringizni fayl qilib yuborish. Faylni botga qaytarsangiz, tiklanadi.",
    "",
    "YORDAM",
    "/help — buyruqlar ro‘yxatini ko‘rsatish.",
  ].join("\n");
}

function newUser() {
  return { days: {}, vocabulary: [], pendingInput: null, lastDailySent: null, reminded: null };
}

// Eski (so‘z-darajadagi) yozuvlarni unit-darajaga o‘tkazadi.
function migrateVocabulary(list) {
  if (!Array.isArray(list)) return [];
  if (list.every((item) => Array.isArray(item.words))) return list;
  const groups = new Map();
  for (const item of list) {
    if (Array.isArray(item.words)) {
      groups.set(item.id, item);
      continue;
    }
    const key = `${item.source}-${item.unit}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        source: item.source,
        unit: item.unit,
        learnedAt: item.reviewAt[0] - REVIEW_DELAYS[0],
        words: [],
        reviewAt: item.reviewAt,
        reviewed: [...item.reviewed],
        notified: Array.isArray(item.notified) ? [...item.notified] : item.reviewAt.map(() => false),
      });
    }
    groups.get(key).words.push({ word: item.word, meaning: item.meaning });
  }
  return [...groups.values()];
}

function migrateUser(user) {
  const migrated = { ...newUser(), ...user };
  migrated.vocabulary = migrateVocabulary(migrated.vocabulary);
  for (const item of migrated.vocabulary) {
    item.notified ||= item.reviewAt.map(() => false);
  }
  delete migrated.reviewQueue;
  delete migrated.sentenceLines;
  return migrated;
}

function normalizeAnswer(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’‘`]/gu, "'")
    .replace(/[.,!?;:()[\]{}"“”]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeText(value) {
  return String(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
}

function escapeHtml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (current && current.length + piece.length + 1 > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function createSerialQueue(onError) {
  let pending = Promise.resolve();
  return (work) => {
    const current = pending.then(work);
    pending = current.catch(onError);
    return current;
  };
}

function getTransportMode(env = process.env) {
  const configuredMode = env.BOT_MODE;
  if (configuredMode && configuredMode !== "polling" && configuredMode !== "webhook") {
    throw new Error("BOT_MODE must be either 'polling' or 'webhook'.");
  }
  if (configuredMode) return configuredMode;
  return env.WEBHOOK_URL || env.RENDER_EXTERNAL_HOSTNAME ? "webhook" : "polling";
}

async function loadVocabulary() {
  const result = {};
  for (const [key, book] of Object.entries(BOOKS)) {
    const filePath = path.join(MATERIALS_DIR, book.file);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed.units;
    if (!Array.isArray(entries)) throw new Error(`${filePath} has no unit list`);
    const units = new Map();
    for (const entry of entries) {
      const words = Array.isArray(entry.words) ? entry.words : [entry];
      if (!Number.isInteger(entry.unit) || words.some((word) => !word.word || !word.meaning)) {
        throw new Error(`Invalid vocabulary data in ${filePath}`);
      }
      if (!units.has(entry.unit)) units.set(entry.unit, []);
      units.get(entry.unit).push(...words.map((word) => ({ word: word.word, meaning: word.meaning })));
    }
    result[key] = units;
  }
  return result;
}

// answer_keys.json: { "listening": { "Unit 1": { "1": "A", "2": "C" } }, "reading": { ... } }
async function loadAnswerKeys() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(MATERIALS_DIR, "answer_keys.json"), "utf8"));
    return { listening: parsed.listening || {}, reading: parsed.reading || {} };
  } catch (error) {
    if (error.code === "ENOENT") return { listening: {}, reading: {} };
    throw error;
  }
}

async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!state.users || typeof state.users !== "object" || Array.isArray(state.users)) {
      throw new Error("Invalid bot state file");
    }
    const users = Object.fromEntries(Object.entries(state.users).map(([id, user]) => [id, migrateUser(user)]));
    return {
      ...state,
      users,
      answerKeys: state.answerKeys || { listening: {}, reading: {} },
      lastUpdateId: Number.isInteger(state.lastUpdateId)
        ? state.lastUpdateId
        : Number.isInteger(state.offset)
          ? state.offset - 1
          : -1,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { lastUpdateId: -1, users: {}, answerKeys: { listening: {}, reading: {} } };
    throw error;
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const temporaryPath = `${DATA_FILE}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state), "utf8");
  await fs.rename(temporaryPath, DATA_FILE);
}

async function telegram(method, body, timeoutMs = 15_000) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.statusText}`);
  }
  return result.result;
}

function createWebhookServer(secret, onUpdate) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
      return;
    }
    if (request.method !== "POST" || request.url !== WEBHOOK_PATH) {
      response.writeHead(404).end();
      return;
    }

    const suppliedSecret = Buffer.from(request.headers["x-telegram-bot-api-secret-token"] || "");
    const expectedSecret = Buffer.from(secret);
    if (
      suppliedSecret.length !== expectedSecret.length ||
      !timingSafeEqual(suppliedSecret, expectedSecret)
    ) {
      response.writeHead(403).end();
      return;
    }

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_WEBHOOK_BODY_BYTES) {
          response.writeHead(413).end("Request body too large");
          return;
        }
        chunks.push(chunk);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await onUpdate(update);
      response.writeHead(200).end("ok");
    } catch (error) {
      console.error("Failed to process Telegram webhook:", error);
      if (!response.headersSent) response.writeHead(500).end("Update processing failed");
    }
  });
}

async function sendMessage(chatId, text, replyMarkup, { html = false } = {}) {
  const chunks = splitMessage(escapeText(text));
  let sent;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    sent = await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...(html ? { parse_mode: "HTML" } : {}),
      ...(replyMarkup && isLast ? { reply_markup: replyMarkup } : {}),
    });
  }
  return sent;
}

async function editMessage(chatId, messageId, text, replyMarkup) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: escapeText(text).slice(0, MAX_MESSAGE_LENGTH),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (error) {
    // Matn o‘zgarmagan bo‘lsa Telegram xato qaytaradi — bu zararsiz.
    if (/message is not modified/iu.test(error.message)) return null;
    throw error;
  }
}

async function answerCallback(callbackId, text) {
  try {
    return await telegram("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  } catch (error) {
    // Eskirgan tugma bosilganda Telegram xato beradi; bu butun yangilanishni buzmasligi kerak.
    console.error("answerCallbackQuery failed:", error.message);
    return null;
  }
}

async function sendDocument(chatId, filename, content, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "application/json" }), filename);
  const response = await fetch(`${API}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendDocument failed: ${result.description || response.statusText}`);
  return result.result;
}

function getUser(chatId) {
  const id = String(chatId);
  if (!state.users[id]) state.users[id] = newUser();
  return state.users[id];
}

/* ---------- Klaviaturalar ---------- */

function reviewKeyboard(itemId, stage) {
  return { inline_keyboard: [[{ text: "✅ Takrorladim", callback_data: `rv:${itemId}:${stage}` }]] };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📚 Lug‘at", callback_data: "menu:vocab" },
        { text: "🔁 Takrorlash", callback_data: "menu:review" },
      ],
      [
        { text: "📋 Vazifalar", callback_data: "menu:tasks" },
        { text: "📊 Natija", callback_data: "menu:progress" },
      ],
      [
        { text: "✍️ Grammatika", callback_data: "menu:grammar" },
        { text: "🎧 Listening", callback_data: "menu:listening" },
      ],
      [
        { text: "📖 Reading", callback_data: "menu:reading" },
        { text: "📝 30 ta gap", callback_data: "menu:sentences" },
      ],
      [{ text: "📈 Statistika", callback_data: "menu:stats" }],
    ],
  };
}

function vocabularySourceKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "A — word_list.json", callback_data: "vocab:source:A" },
        { text: "B — words2.json", callback_data: "vocab:source:B" },
      ],
      [{ text: "⬅️ Bosh menyu", callback_data: "menu:home" }],
    ],
  };
}

function vocabularyUnitKeyboard(source, user) {
  const added = new Set((user?.vocabulary || []).filter((item) => item.source === source).map((item) => item.unit));
  const rows = [];
  for (let unit = 1; unit <= 30; unit += 3) {
    rows.push(Array.from({ length: Math.min(3, 31 - unit) }, (_, index) => ({
      text: `${added.has(unit + index) ? "✅ " : ""}Unit ${unit + index}`,
      callback_data: `vocab:${source}:${unit + index}`,
    })));
  }
  rows.push([{ text: "⬅️ Bosh menyu", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

function taskKeyboard(user, day) {
  return {
    inline_keyboard: [
      ...TASKS.map((task) => [{
        text: `${getDay(user, day).tasks[task] ? "✅" : "☐"} ${TASK_LABELS[task]}`,
        callback_data: `task:${task}`,
      }]),
      [{ text: "⬅️ Bosh menyu", callback_data: "menu:home" }],
    ],
  };
}

/* ---------- Lug‘at takrorlash ---------- */

function dueQueue(user, now = Date.now()) {
  const queue = [];
  for (const item of user.vocabulary) {
    item.reviewAt.forEach((time, stage) => {
      if (time <= now && !item.reviewed[stage]) queue.push({ itemId: item.id, time, stage });
    });
  }
  return queue
    .sort((a, b) => a.time - b.time)
    .map(({ itemId, stage }) => ({ itemId, stage }));
}

function reviewMessage(item, stage) {
  const lines = item.words.map(
    (entry, index) => `${index + 1}. ${escapeHtml(entry.word)} — <tg-spoiler>${escapeHtml(entry.meaning)}</tg-spoiler>`,
  );
  return [
    `🔁 Takrorlash ${stage + 1}/6 · ${item.source} kitob, Unit ${item.unit}`,
    "",
    "Avval ma’noni o‘zingiz eslab ko‘ring, keyin yashirin qismni bosib tekshiring. Tayyor bo‘lgach ✅ tugmasini bosing.",
    "",
    ...lines,
  ].join("\n");
}

async function sendReview(chatId, item, stage) {
  await sendMessage(chatId, reviewMessage(item, stage), reviewKeyboard(item.id, stage), { html: true });
  item.notified[stage] = true;
}

function nextReviewText(user) {
  const upcoming = user.vocabulary
    .flatMap((item) => item.reviewAt.filter((time, stage) => !item.reviewed[stage]))
    .sort((a, b) => a - b)[0];
  return upcoming ? `Keyingi takrorlash: ${localDateTime(upcoming)}.` : "Rejalashtirilgan takrorlash qolmadi.";
}

async function beginReview(chatId, user) {
  const queue = dueQueue(user);
  if (!queue.length) {
    await sendMessage(chatId, `Hozircha takrorlash vaqti kelgan lug‘at yo‘q. ${nextReviewText(user)}`);
    return;
  }
  for (const entry of queue.slice(0, MAX_REVIEWS_PER_TICK)) {
    const item = user.vocabulary.find((candidate) => candidate.id === entry.itemId);
    await sendReview(chatId, item, entry.stage);
  }
  await saveState();
  if (queue.length > MAX_REVIEWS_PER_TICK) {
    await sendMessage(chatId, `Yana ${queue.length - MAX_REVIEWS_PER_TICK} ta takrorlash bor. Bularni tugatgach /review yozing.`);
  }
}

/* ---------- Kunlik ko‘rinishlar ---------- */

function progressMessage(user, day = localDate()) {
  const progress = makeProgress(user, day);
  const daily = getDay(user, day);
  const summary = progress.rows
    .map((row) => `${row.done ? "✅" : "⬜"} ${row.label}${resultDetail(daily, row.key)}`)
    .join("\n");
  return `Bugungi natija (${day}): ${progress.completed}/${progress.total} — ${progress.percent}%\n\n${summary}\n\n${motivationForProgress(progress.percent)}`;
}

function tasksView(user, day, heading = "Bajarilganini belgilang:") {
  return { text: `${progressMessage(user, day)}\n\n${heading}`, markup: taskKeyboard(user, day) };
}

async function sendProgress(chatId, user, day = localDate()) {
  await sendMessage(chatId, progressMessage(user, day), mainMenuKeyboard());
}

function dueReminders(user, now = new Date()) {
  const day = localDate(now);
  const hour = localHour(now);
  if (hour >= REPORT_HOUR) return [];
  const sent = user.reminded?.day === day ? user.reminded.keys : [];
  const tasks = user.days?.[day]?.tasks || {};
  return REMINDER_SLOTS.filter((slot) => hour >= slot.hour && !sent.includes(slot.task) && !tasks[slot.task]);
}

/* ---------- Topshiriqlar ---------- */

function describeKeyStatus(type, testId) {
  return lookupKey(type, testId)
    ? "Bu test uchun javob kaliti bor — xatolaringizni topib beraman."
    : "Bu test uchun javob kaliti yo‘q. Javoblar saqlanadi; kalitni /setkey bilan qo‘shsangiz, tekshirib beraman.";
}

function lookupKey(type, testId) {
  return findAnswerKey([state?.answerKeys, answerKeys], type, testId);
}

async function beginSubmission(chatId, user, type, testId) {
  if (!testId) {
    user.pendingInput = { type, stage: "test" };
    await saveState();
    await sendMessage(chatId, `${TASK_LABELS[type]}: avval test nomi yoki raqamini yozing (masalan: 3 yoki Unit 3).`);
    return;
  }
  user.pendingInput = { type, stage: "answers", testId };
  await saveState();
  await sendMessage(chatId, `${TASK_LABELS[type]} — ${testId}. Javoblarni yuboring, masalan: 1A 2C 3B yoki har birini alohida qatorda.\n\n${describeKeyStatus(type, testId)}`);
}

async function submitAnswers(chatId, user, type, testId, content, day) {
  recordTaskSubmission(user, type, content, day);
  const daily = getDay(user, day);
  const key = lookupKey(type, testId);
  const given = parseAnswers(content);
  const entry = { testId, content, at: Date.now(), checked: false };
  let report;
  if (key && given.size > 0) {
    const grade = gradeAnswers(key, given);
    Object.assign(entry, { checked: true, correct: grade.correct, total: grade.total, percent: grade.percent, wrong: grade.wrong });
    report = formatGrade(type, testId, grade);
  } else if (key) {
    report = "Javoblarni o‘qiy olmadim. Format: 1A 2C 3B (raqam va javob). Qayta yuboring.";
    daily.tasks[type] = false;
    delete daily.submissions[type];
    user.pendingInput = { type, stage: "answers", testId };
    await saveState();
    await sendMessage(chatId, report);
    return;
  } else {
    report = `${TASK_LABELS[type]} — ${testId}: javoblar saqlandi va vazifa bajarildi deb belgilandi.\nJavob kaliti yo‘qligi uchun xatolar tekshirilmadi. Kalit qo‘shish: /setkey ${type} ${testId}`;
  }
  storeResult(daily, type, entry);
  user.pendingInput = null;
  await saveState();
  await sendMessage(chatId, `${report}\n\n${motivationForProgress(makeProgress(user, day).percent)}`);
}

async function setKey(chatId, user, type, testId, body) {
  const answers = parseAnswers(body);
  if (answers.size === 0) {
    await sendMessage(chatId, `Kalit o‘qilmadi. Format:\n/setkey ${type} ${testId || "3"}\n1A\n2C\n3B`);
    return;
  }
  state.answerKeys[type] ||= {};
  state.answerKeys[type][testId] = answersToKey(answers);
  await saveState();
  const regraded = [];
  for (const [day, daily] of Object.entries(user.days)) {
    const list = Array.isArray(daily.results?.[type]) ? daily.results[type] : [];
    for (const entry of list) {
      if (!entry.checked && normalizeTestId(entry.testId) === normalizeTestId(testId) && entry.content) {
        const grade = gradeAnswers(state.answerKeys[type][testId], parseAnswers(entry.content));
        Object.assign(entry, { checked: true, correct: grade.correct, total: grade.total, percent: grade.percent, wrong: grade.wrong });
        regraded.push(`${day}\n${formatGrade(type, testId, grade)}`);
      }
    }
  }
  await saveState();
  const saved = `${TASK_LABELS[type]} — ${testId} uchun kalit saqlandi (${answers.size} ta savol).`;
  await sendMessage(chatId, regraded.length ? `${saved}\n\nOldin yuborgan javoblaringiz tekshirildi:\n\n${regraded.join("\n\n")}` : saved);
}

async function finalizeSentences(chatId, user, day) {
  const daily = getDay(user, day);
  const sentences = daily.submissions.sentences || [];
  if (!ANTHROPIC_API_KEY) {
    await sendMessage(chatId, "30 ta gap qabul qilindi va vazifa bajarildi deb hisoblandi.\nAvtomatik tekshiruv yoqilmagan (ANTHROPIC_API_KEY sozlanmagan).");
    return;
  }
  await sendMessage(chatId, "⏳ Gaplaringizni tekshiryapman, bir daqiqa...");
  const review = await checkSentences(sentences, daily.sentenceTopic || daily.submissions.grammar || "");
  if (!review) {
    await sendMessage(chatId, "Tekshiruv hozir ishlamadi, lekin gaplar saqlandi va vazifa bajarildi. Keyinroq /checksentences yozing.");
    return;
  }
  daily.results.sentences = review;
  await saveState();
  await sendMessage(chatId, formatSentenceReview(review, sentences));
}

/* ---------- Buyruqlar ---------- */

async function handleCommand(message, user) {
  const chatId = message.chat.id;
  const text = message.text || "";
  const lines = text.trim().split(/\r?\n/u);
  const [rawCommand, ...args] = lines[0].trim().split(/\s+/u);
  const body = lines.slice(1).join("\n").trim();
  const command = rawCommand.split("@")[0].toLowerCase();
  const day = localDate();
  user.pendingInput = null;

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, helpMessage(), mainMenuKeyboard());
    return;
  }

  if (command === "/vocab") {
    const source = (args[0] || "").toUpperCase();
    const unit = Number.parseInt(args[1], 10);
    if (!BOOKS[source] || !Number.isInteger(unit) || unit < 1 || unit > 30) {
      await sendMessage(chatId, "Format: /vocab A 1 (yoki /vocab B 1). Unit raqami 1–30 bo‘lishi kerak.");
      return;
    }
    const words = vocabulary[source].get(unit);
    if (!words) {
      await sendMessage(chatId, `Unit ${unit} uchun lug‘at topilmadi.`);
      return;
    }
    const existing = user.vocabulary.some((item) => item.source === source && item.unit === unit);
    if (existing) {
      await sendMessage(chatId, `Unit ${unit} (${source}) avval qo‘shilgan. Takrorlashni /review orqali ko‘ring.`);
      return;
    }
    const learnedAt = Date.now();
    user.vocabulary.push({
      id: `${source}-${unit}`,
      source,
      unit,
      learnedAt,
      words: words.map((word) => ({ word: word.word, meaning: word.meaning })),
      reviewAt: reviewSchedule(learnedAt),
      reviewed: [false, false, false, false, false, false],
      notified: [false, false, false, false, false, false],
    });
    getDay(user, day).newUnits.push(`${source}-${unit}`);
    await saveState();
    const wordList = words.map((word) => `• ${word.word} — ${word.meaning}`).join("\n");
    await sendMessage(
      chatId,
      `Unit ${unit} (${source}: ${BOOKS[source].name}) — ${words.length} ta yangi so‘z:\n\n${wordList}\n\nBirinchi takrorlash 25 daqiqadan keyin. Keyingilari: 10 soat, 24 soat, 4, 14 va 30 kundan keyin. Vaqti kelganda o‘zim so‘rayman, siz ✅ bilan belgilaysiz.\n\nYangi so‘zlarni o‘rganayotganingizning o‘zi katta qadam. Davom eting!`,
    );
    return;
  }

  if (command === "/review") {
    await beginReview(chatId, user);
    return;
  }

  if (command === "/tasks") {
    const view = tasksView(user, day);
    await sendMessage(chatId, view.text, view.markup);
    return;
  }

  if (command === "/progress") {
    await sendProgress(chatId, user);
    return;
  }

  if (command === "/stats") {
    await sendMessage(chatId, statsMessage(user), mainMenuKeyboard());
    return;
  }

  if (command === "/done") {
    const task = (args[0] || "").toLowerCase();
    if (!TASKS.includes(task)) {
      await sendMessage(chatId, "Vazifa nomi: grammar, listening, reading yoki sentences.");
      return;
    }
    getDay(user, day).tasks[task] = true;
    await saveState();
    const progress = makeProgress(user, day);
    await sendMessage(chatId, `${TASK_LABELS[task]} bajarildi deb belgilandi (${progress.percent}%).\n\n${motivationForProgress(progress.percent)}`);
    return;
  }

  if (command === "/grammar") {
    user.pendingInput = { type: "grammar" };
    await saveState();
    await sendMessage(chatId, "Bugun Murphy’dan o‘qigan unit/mavzuni yozing. Yuborganingizda grammatika vazifasi bajarildi deb belgilanadi.");
    return;
  }

  if (command === "/submit" || command === "/listening" || command === "/reading") {
    const task = command === "/submit" ? (args[0] || "").toLowerCase() : command.slice(1);
    const idTokens = command === "/submit" ? args.slice(1) : args;
    if (task !== "listening" && task !== "reading") {
      await sendMessage(chatId, "Format: /submit listening 3 yoki /submit reading 3 (3 — test raqami).");
      return;
    }
    const testId = idTokens.join(" ").trim();
    if (testId && body) {
      await submitAnswers(chatId, user, task, testId, body, day);
      return;
    }
    await beginSubmission(chatId, user, task, testId);
    return;
  }

  if (command === "/setkey") {
    const type = (args[0] || "").toLowerCase();
    if (type !== "listening" && type !== "reading") {
      await sendMessage(chatId, "Format:\n/setkey listening 3\n1A\n2C\n3B\n\n(yoki bir qatorda: /setkey reading 3 1A 2C 3B)");
      return;
    }
    // Test nomi — birinchi "1A" ko‘rinishidagi javobgacha bo‘lgan so‘zlar.
    const rest = args.slice(1);
    const firstAnswer = rest.findIndex((token) => /^\d+[^\d\s]/u.test(token));
    const idTokens = firstAnswer === -1 ? rest : rest.slice(0, firstAnswer);
    const inline = firstAnswer === -1 ? "" : rest.slice(firstAnswer).join(" ");
    const testId = idTokens.join(" ").trim();
    if (!testId) {
      await sendMessage(chatId, "Test nomi yoki raqamini yozing: /setkey listening 3");
      return;
    }
    await setKey(chatId, user, type, testId, `${inline}\n${body}`);
    return;
  }

  if (command === "/sentences") {
    const topic = args.join(" ").trim();
    const daily = getDay(user, day);
    if (topic) daily.sentenceTopic = topic;
    user.pendingInput = { type: "sentences" };
    const savedCount = daily.submissions.sentences?.length || 0;
    await saveState();
    await sendMessage(chatId, `Murphy mavzusidagi 30 ta gapingizni yuboring — har bir gapni alohida qatorda yozing. ${savedCount}/30 ta gap saqlangan; ${30 - savedCount} ta qoldi.${ANTHROPIC_API_KEY ? "" : " Avtomatik tekshiruv hozircha yoqilmagan."}\n\nMavzuni ko‘rsatish uchun: /sentences Present perfect`);
    return;
  }

  if (command === "/checksentences") {
    const daily = getDay(user, day);
    const sentences = daily.submissions.sentences;
    if (!Array.isArray(sentences) || sentences.length === 0) {
      await sendMessage(chatId, "Bugun hali gap yuborilmagan.");
      return;
    }
    if (!ANTHROPIC_API_KEY) {
      await sendMessage(chatId, "Avtomatik tekshiruv yoqilmagan (ANTHROPIC_API_KEY sozlanmagan).");
      return;
    }
    await finalizeSentences(chatId, user, day);
    return;
  }

  if (command === "/backup") {
    await sendDocument(chatId, `study-backup-${day}.json`, JSON.stringify(user), "Zaxira nusxa. Tiklash uchun shu faylni botga yuboring.");
    return;
  }

  await sendMessage(chatId, "Buyruq topilmadi. Mavjud buyruqlar uchun /help deb yozing.");
}

async function handleDocument(message, user) {
  const chatId = message.chat.id;
  const document = message.document;
  if (!/^study-backup-.*\.json$/iu.test(document.file_name || "")) {
    await sendMessage(chatId, "Faqat /backup orqali olingan study-backup-....json faylini tiklash mumkin.");
    return;
  }
  if (document.file_size > MAX_WEBHOOK_BODY_BYTES * 4) {
    await sendMessage(chatId, "Fayl juda katta.");
    return;
  }
  const file = await telegram("getFile", { file_id: document.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  const restored = await response.json();
  if (!restored || typeof restored.days !== "object" || !Array.isArray(restored.vocabulary)) {
    await sendMessage(chatId, "Bu fayl zaxira nusxaga o‘xshamaydi.");
    return;
  }
  state.users[String(chatId)] = migrateUser({ ...restored, pendingInput: null });
  await saveState();
  await sendMessage(chatId, `Ma’lumotlar tiklandi: ${Object.keys(restored.days).length} kun, ${restored.vocabulary.length} unit.`, mainMenuKeyboard());
}

async function handleMessage(message) {
  if (!message.chat || !message.from) return;
  const user = getUser(message.chat.id);
  if (message.document) {
    await handleDocument(message, user);
    return;
  }
  if (message.text?.startsWith("/")) {
    await handleCommand(message, user);
    return;
  }
  if (!user.pendingInput) {
    await sendMessage(message.chat.id, "Buyruqlar uchun /help yozing.");
    return;
  }

  const type = user.pendingInput.type;
  const content = (message.text || "").trim();
  if (!content) {
    await sendMessage(message.chat.id, "Iltimos, matn ko‘rinishidagi javob yuboring.");
    return;
  }

  if (type === "sentences") {
    const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const day = localDate();
    const result = appendSentenceLines(user, day, lines, message.message_id);
    if (result.duplicate) {
      await sendMessage(message.chat.id, `${result.count}/30 ta gap saqlangan. ${result.remaining} ta gap qoldi.`);
      return;
    }
    if (!result.accepted) {
      const prompt = lines.length === 0
        ? "Kamida bitta gap yuboring."
        : `Faqat ${result.remaining} ta gap qoldi, lekin siz ${lines.length} ta yubordingiz. Iltimos, ${result.remaining} ta gapdan ko‘p bo‘lmagan xabar yuboring.`;
      await sendMessage(message.chat.id, `${prompt} Hozircha ${result.count}/30 ta gap saqlandi.`);
      return;
    }
    if (!result.completed) {
      await saveState();
      await sendMessage(message.chat.id, `${result.count}/30 ta gap qabul qilindi. Qolgan ${result.remaining} tasini yuboring.`);
      return;
    }
    user.pendingInput = null;
    await saveState();
    await finalizeSentences(message.chat.id, user, day);
    await sendMessage(message.chat.id, motivationForProgress(makeProgress(user, day).percent));
    return;
  }

  if (type === "listening" || type === "reading") {
    if (user.pendingInput.stage === "test") {
      await beginSubmission(message.chat.id, user, type, content.split("\n")[0].trim());
      return;
    }
    await submitAnswers(message.chat.id, user, type, user.pendingInput.testId || "umumiy", content, localDate());
    return;
  }

  user.pendingInput = null;
  const day = localDate();
  recordTaskSubmission(user, type, content, day);
  await saveState();
  const progress = makeProgress(user, day);
  await sendMessage(message.chat.id, `${TASK_LABELS[type]} saqlandi va vazifa bajarildi deb belgilandi.\n\n${motivationForProgress(progress.percent)}`);
}

async function handleCallback(callback) {
  if (!callback.message) {
    await answerCallback(callback.id);
    return;
  }
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const user = getUser(chatId);
  const data = callback.data || "";

  if (data === "menu:home") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, helpMessage(), mainMenuKeyboard());
    return;
  }
  if (data === "menu:vocab") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, "Qaysi lug‘at kitobidan unit tanlaysiz?", vocabularySourceKeyboard());
    return;
  }
  if (data.startsWith("vocab:source:")) {
    const source = data.slice("vocab:source:".length);
    if (!BOOKS[source]) {
      await answerCallback(callback.id, "Noma’lum lug‘at kitobi");
      return;
    }
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, `${source} kitobi: unit raqamini tanlang (✅ — qo‘shilgan).`, vocabularyUnitKeyboard(source, user));
    return;
  }
  if (data.startsWith("vocab:")) {
    const [, source, rawUnit] = data.split(":");
    const unit = Number(rawUnit);
    if (!BOOKS[source] || !Number.isInteger(unit) || unit < 1 || unit > 30) {
      await answerCallback(callback.id, "Noto‘g‘ri unit tanlandi");
      return;
    }
    await answerCallback(callback.id, `Unit ${unit} tanlandi`);
    await handleCommand({ chat: { id: chatId }, text: `/vocab ${source} ${unit}` }, user);
    await editMessage(chatId, messageId, `${source} kitobi: unit raqamini tanlang (✅ — qo‘shilgan).`, vocabularyUnitKeyboard(source, user));
    return;
  }
  if (data.startsWith("menu:")) {
    const action = data.slice("menu:".length);
    const supported = ["review", "tasks", "progress", "stats", "grammar", "listening", "reading", "sentences"];
    if (!supported.includes(action)) {
      await answerCallback(callback.id, "Bu tugma endi faol emas");
      return;
    }
    await answerCallback(callback.id);
    if (action === "review") {
      await beginReview(chatId, user);
      return;
    }
    if (action === "tasks") {
      const view = tasksView(user, localDate());
      await editMessage(chatId, messageId, view.text, view.markup);
      return;
    }
    if (action === "progress") {
      await editMessage(chatId, messageId, progressMessage(user), mainMenuKeyboard());
      return;
    }
    if (action === "stats") {
      await editMessage(chatId, messageId, statsMessage(user), mainMenuKeyboard());
      return;
    }
    const day = localDate();
    const backButton = { inline_keyboard: [[{ text: "⬅️ Bosh menyu", callback_data: "menu:home" }]] };
    if (action === "listening" || action === "reading") {
      user.pendingInput = { type: action, stage: "test" };
      await saveState();
      await editMessage(chatId, messageId, `${TASK_LABELS[action]}: avval test nomi yoki raqamini yozing (masalan: 3 yoki Unit 3).`, backButton);
      return;
    }
    user.pendingInput = { type: action };
    let prompt;
    if (action === "grammar") {
      prompt = "Bugun Murphy’dan o‘qigan unit/mavzuni yozing. Yuborganingizda grammatika vazifasi bajarildi deb belgilanadi.";
    } else {
      const savedCount = getDay(user, day).submissions.sentences?.length || 0;
      prompt = `Murphy mavzusidagi 30 ta gapingizni yuboring — har bir gapni alohida qatorda yozing. ${savedCount}/30 ta gap saqlangan; ${30 - savedCount} ta qoldi.`;
    }
    await saveState();
    await editMessage(chatId, messageId, prompt, backButton);
    return;
  }
  if (data === "review:begin") {
    await answerCallback(callback.id, "Takrorlash boshlanmoqda");
    await beginReview(chatId, user);
    return;
  }
  if (data.startsWith("rv:")) {
    const [, itemId, rawStage] = data.split(":");
    const stage = Number(rawStage);
    const item = user.vocabulary.find((candidate) => candidate.id === itemId);
    if (!item || !Number.isInteger(stage) || stage < 0 || stage > 5) {
      await answerCallback(callback.id, "Bu takrorlash topilmadi");
      return;
    }
    if (item.reviewed[stage]) {
      await answerCallback(callback.id, "Allaqachon belgilangan");
      return;
    }
    item.reviewed[stage] = true;
    await saveState();
    await answerCallback(callback.id, "✅ Belgilandi");
    const left = dueQueue(user).length;
    await editMessage(
      chatId,
      messageId,
      `✅ Takrorlash ${stage + 1}/6 · ${item.source} kitob, Unit ${item.unit} — bajarildi.${left ? ` Hali ${left} ta kutmoqda.` : ""}`,
    );
    return;
  }
  if (data.startsWith("done:")) {
    const task = data.slice("done:".length);
    if (!TASKS.includes(task)) {
      await answerCallback(callback.id, "Noma’lum vazifa");
      return;
    }
    const day = localDate();
    getDay(user, day).tasks[task] = true;
    await saveState();
    await answerCallback(callback.id, "Bajarildi");
    const progress = makeProgress(user, day);
    await editMessage(chatId, messageId, `✅ ${TASK_LABELS[task]} bajarildi (${progress.percent}%).\n\n${motivationForProgress(progress.percent)}`);
    return;
  }
  if (data.startsWith("task:")) {
    const task = data.slice("task:".length);
    if (!TASKS.includes(task)) {
      await answerCallback(callback.id, "Noma’lum vazifa");
      return;
    }
    const day = localDate();
    const daily = getDay(user, day);
    daily.tasks[task] = !daily.tasks[task];
    await answerCallback(callback.id, daily.tasks[task] ? "Bajarildi" : "Belgisi olib tashlandi");
    await saveState();
    const view = tasksView(user, day);
    await editMessage(chatId, messageId, view.text, view.markup);
    return;
  }
  await answerCallback(callback.id, "Bu tugma endi faol emas");
}

/* ---------- Jadval bo‘yicha xabarlar ---------- */

async function sendDueNotifications(now = new Date()) {
  const timestamp = now.getTime();
  const day = localDate(now);
  for (const [chatId, user] of Object.entries(state.users)) {
    try {
      // 1) Vaqti kelgan lug‘at takrorlashlari
      const unnotified = dueQueue(user, timestamp)
        .filter(({ itemId, stage }) => !user.vocabulary.find((item) => item.id === itemId).notified[stage]);
      for (const entry of unnotified.slice(0, MAX_REVIEWS_PER_TICK)) {
        const item = user.vocabulary.find((candidate) => candidate.id === entry.itemId);
        await sendReview(Number(chatId), item, entry.stage);
        await saveState();
      }
      if (unnotified.length > MAX_REVIEWS_PER_TICK) {
        await sendMessage(Number(chatId), `Yana ${unnotified.length - MAX_REVIEWS_PER_TICK} ta takrorlash kutmoqda. Bularni tugatgach /review yozing.`);
      }

      // 2) Kun davomidagi eslatmalar (faqat eng so‘nggisi)
      const reminders = dueReminders(user, now);
      if (reminders.length) {
        const slot = reminders[reminders.length - 1];
        const already = user.reminded?.day === day ? user.reminded.keys : [];
        await sendMessage(Number(chatId), slot.text, {
          inline_keyboard: [[
            { text: slot.action, callback_data: `menu:${slot.task}` },
            { text: "✅ Bajardim", callback_data: `done:${slot.task}` },
          ]],
        });
        user.reminded = { day, keys: [...already, ...reminders.map((item) => item.task)] };
        await saveState();
      }

      // 3) Kechqurun hisobot: nimalar bajarildi?
      if (localHour(now) >= REPORT_HOUR && user.lastDailySent !== day) {
        const view = tasksView(user, day, `🌙 Soat ${REPORT_HOUR}:00 — bugun qaysilarini bajardingiz? Qolganlarini belgilab qo‘ying:`);
        await sendMessage(Number(chatId), view.text, view.markup);
        user.lastDailySent = day;
        await saveState();
        if (AUTO_BACKUP) {
          await sendDocument(Number(chatId), `study-backup-${day}.json`, JSON.stringify(user), "Kunlik zaxira nusxa (tiklash uchun shu faylni botga yuboring).")
            .catch((error) => console.error("Backup failed:", error.message));
        }
      }
    } catch (error) {
      console.error(`Failed to send scheduled notification to chat ${chatId}:`, error);
    }
  }
}

let state;
let vocabulary;
let answerKeys = { listening: {}, reading: {} };

function updateChatId(update) {
  return update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
}

async function processTelegramUpdate(update) {
  if (Number.isInteger(update.update_id) && update.update_id <= (state.lastUpdateId ?? -1)) return;
  const chatId = updateChatId(update);
  try {
    await sendDueNotifications();
    const allowed = ALLOWED_CHAT_IDS.length === 0 || ALLOWED_CHAT_IDS.includes(String(chatId));
    if (allowed) {
      if (update.message) await handleMessage(update.message);
      if (update.callback_query) await handleCallback(update.callback_query);
    }
  } catch (error) {
    // Xato bo‘lsa ham yangilanish "o‘qilgan" deb belgilanadi, aks holda Telegram uni cheksiz qayta yuboradi.
    console.error(`Failed to process update ${update.update_id}:`, error);
    if (chatId) await sendMessage(chatId, "Kechirasiz, xatolik yuz berdi. Qayta urinib ko‘ring.").catch(() => {});
  }
  if (Number.isInteger(update.update_id)) state.lastUpdateId = update.update_id;
  await saveState();
}

async function pollTelegramUpdates(enqueueWork) {
  while (true) {
    try {
      const updates = await telegram(
        "getUpdates",
        {
          offset: state.lastUpdateId + 1,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        },
        35_000,
      );
      for (const update of updates) {
        await enqueueWork(() => processTelegramUpdate(update));
      }
    } catch (error) {
      console.error("Telegram polling failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  if (!TOKEN) throw new Error("BOT_TOKEN is required. Create a Telegram bot and set its token in the environment.");
  if (!Number.isInteger(TZ_OFFSET_MINUTES) || TZ_OFFSET_MINUTES < -720 || TZ_OFFSET_MINUTES > 840) {
    throw new Error("TZ_OFFSET_MINUTES must be an integer from -720 to 840.");
  }
  if (!Number.isInteger(REPORT_HOUR) || REPORT_HOUR < 0 || REPORT_HOUR > 23) {
    throw new Error("DAILY_REPORT_HOUR must be an integer from 0 to 23.");
  }
  state = await readState();
  vocabulary = await loadVocabulary();
  answerKeys = await loadAnswerKeys();
  const transportMode = getTransportMode();
  const enqueueWork = createSerialQueue((error) => console.error("Queued bot work failed:", error));
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Botni boshlash" },
      { command: "vocab", description: "Lug‘at unitini qo‘shish" },
      { command: "review", description: "Vaqti kelgan so‘zlarni takrorlash" },
      { command: "tasks", description: "Kunlik vazifalar" },
      { command: "progress", description: "Kunlik natija" },
      { command: "stats", description: "Umumiy statistika" },
      { command: "done", description: "Vazifani bajarilgan deb belgilash" },
      { command: "grammar", description: "Murphy mavzusini yuborish" },
      { command: "listening", description: "Listening javoblarini yuborish" },
      { command: "reading", description: "Reading javoblarini yuborish" },
      { command: "sentences", description: "30 ta gapni yuborish" },
      { command: "setkey", description: "Javob kalitini qo‘shish" },
      { command: "backup", description: "Ma’lumotlar zaxirasi" },
      { command: "help", description: "Yordam" },
    ],
  });

  const startScheduler = () => {
    setInterval(() => {
      enqueueWork(() => sendDueNotifications()).catch((error) => {
        console.error("Scheduled notification failed:", error);
      });
    }, 60_000);
  };

  if (transportMode === "polling") {
    await telegram("deleteWebhook", { drop_pending_updates: false });
    startScheduler();
    await enqueueWork(() => sendDueNotifications());
    console.log("English study Telegram bot started in polling mode.");
    await pollTelegramUpdates(enqueueWork);
    return;
  }

  const webhookUrl = process.env.WEBHOOK_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`
      : null);
  if (!webhookUrl || !webhookUrl.startsWith("https://")) {
    throw new Error("Webhook mode requires WEBHOOK_URL or Render's public HTTPS hostname.");
  }
  const port = Number(process.env.PORT || "10000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  const webhookSecret = randomBytes(32).toString("hex");
  const server = createWebhookServer(webhookSecret, (update) =>
    enqueueWork(() => processTelegramUpdate(update)),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  startScheduler();
  // Render bepul tarifi 15 daqiqa trafiksiz qolsa uxlaydi; eslatmalar kelishi uchun o‘zimizni uyg‘oq tutamiz.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && process.env.SELF_PING !== "0") {
    setInterval(() => {
      fetch(`${selfUrl}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }, 10 * 60_000);
  }
  await enqueueWork(() => sendDueNotifications());
  console.log(`English study Telegram bot webhook listening on port ${port}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Bot startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  appendSentenceLines,
  countSentenceLines,
  createSerialQueue,
  createWebhookServer,
  dueQueue,
  dueReminders,
  escapeText,
  findAnswerKey,
  formatGrade,
  formatSentenceReview,
  getTransportMode,
  gradeAnswers,
  helpMessage,
  loadAnswerKeys,
  loadVocabulary,
  localDate,
  mainMenuKeyboard,
  makeProgress,
  migrateVocabulary,
  motivationForProgress,
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
};

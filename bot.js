const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const TOKEN = process.env.BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ROOT = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "state.json");
const MATERIALS_DIR = process.env.MATERIALS_DIR || path.join(ROOT, "Essential books");
const TZ_OFFSET_MINUTES = Number.parseInt(process.env.TZ_OFFSET_MINUTES || "300", 10);
const DAY_MS = 24 * 60 * 60 * 1000;
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

function localDate(now = new Date()) {
  return new Date(now.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
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

function emptyDay() {
  return { tasks: {}, newUnits: [] };
}

function getDay(user, day) {
  if (!user.days[day]) user.days[day] = emptyDay();
  return user.days[day];
}

function makeProgress(user, day, now = Date.now()) {
  const daily = getDay(user, day);
  const reviewItems = (user.vocabulary || []).filter((item) =>
    item.reviewAt.some((time, index) => time <= now),
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

function newUser() {
  return { days: {}, vocabulary: [], reviewQueue: null, pendingInput: null, sentenceLines: [], lastDailySent: null };
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
  return String(value).replace(/[\u0000-\u001f]/gu, " ");
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

async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!state.users || typeof state.users !== "object") throw new Error("Invalid bot state file");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { offset: 0, users: {} };
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

async function sendMessage(chatId, text, replyMarkup) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: escapeText(text),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessage(chatId, messageId, text, replyMarkup) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: escapeText(text),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(callbackId, text) {
  return telegram("answerCallbackQuery", { callback_query_id: callbackId, text });
}

function getUser(chatId) {
  const id = String(chatId);
  if (!state.users[id]) state.users[id] = newUser();
  return state.users[id];
}

function reviewKeyboard() {
  return {
    inline_keyboard: [[
      { text: "✅ Esimda", callback_data: "review:yes" },
      { text: "🔁 Qayta ko‘raman", callback_data: "review:no" },
    ]],
  };
}

function dueQueue(user, now = Date.now()) {
  const queue = [];
  for (const item of user.vocabulary) {
    item.reviewAt.forEach((time, stage) => {
      if (time <= now && !item.reviewed[stage]) queue.push({ itemId: item.id, stage });
    });
  }
  return queue.sort((a, b) => {
    const first = user.vocabulary.find((item) => item.id === a.itemId);
    const second = user.vocabulary.find((item) => item.id === b.itemId);
    return first.reviewAt[a.stage] - second.reviewAt[b.stage];
  });
}

async function showNextReview(chatId, user) {
  const entry = user.reviewQueue?.items[user.reviewQueue.index];
  if (!entry) {
    user.reviewQueue = null;
    await saveState();
    await sendMessage(chatId, `Ayni paytda bajarilmagan takrorlash yo‘q. Barakalla! ${motivationForProgress(makeProgress(user, localDate()).percent)}`);
    return;
  }
  const item = user.vocabulary.find((candidate) => candidate.id === entry.itemId);
  if (!item) throw new Error(`Review word ${entry.itemId} is missing`);
  const sent = await sendMessage(
    chatId,
    `Takrorlash ${entry.stage + 1}/6 · ${item.source} kitob, Unit ${item.unit}\n\n${item.word}\n\nSo‘zni eslay oldingizmi?`,
    reviewKeyboard(),
  );
  user.reviewQueue.messageId = sent.message_id;
  await saveState();
}

async function beginReview(chatId, user) {
  const queue = dueQueue(user);
  if (!queue.length) {
    await sendMessage(chatId, "Hozircha takrorlash vaqti kelgan so‘z yo‘q.");
    return;
  }
  for (const entry of queue) {
    const item = user.vocabulary.find((candidate) => candidate.id === entry.itemId);
    if (Array.isArray(item.notified)) item.notified[entry.stage] = true;
  }
  user.reviewQueue = { items: queue, index: 0 };
  await saveState();
  await showNextReview(chatId, user);
}

async function showDailyChecklist(chatId, day, user) {
  const rows = TASKS.map((task) => [{
    text: `${getDay(user, day).tasks[task] ? "✅" : "☐"} ${TASK_LABELS[task]}`,
    callback_data: `task:${task}`,
  }]);
  await sendMessage(chatId, "Bugungi vazifani tanlang. Bajarilgach tugmani bosing:", { inline_keyboard: rows });
}

async function sendProgress(chatId, user, day = localDate()) {
  const progress = makeProgress(user, day);
  const summary = progress.rows.map((row) => `${row.done ? "✅" : "⬜"} ${row.label}`).join("\n");
  await sendMessage(
    chatId,
    `Bugungi natija (${day}): ${progress.completed}/${progress.total} — ${progress.percent}%\n\n${summary}\n\n${motivationForProgress(progress.percent)}\n\nVazifani belgilash: /done grammar, /done listening, /done reading yoki /done sentences`,
  );
}

async function handleCommand(message, user) {
  const chatId = message.chat.id;
  const text = message.text || "";
  const [rawCommand, ...args] = text.trim().split(/\s+/u);
  const command = rawCommand.split("@")[0].toLowerCase();
  const day = localDate();

  if (command === "/start" || command === "/help") {
    await sendMessage(
      chatId,
      [
        "Salom! Men ingliz tili mustaqil o‘qishingizni kuzataman.",
        "",
        "Lug‘at: /vocab A 1 yoki /vocab B 1",
        "A — word_list.json, B — words2.json. Har birida 30 unit bor.",
        "Takrorlash: /review",
        "Kunlik vazifalar: /tasks",
        "Natija: /progress",
        "Vazifani belgilash: /done grammar|listening|reading|sentences",
        "30 ta gap yuborish: /sentences, keyin har bir gapni alohida qatorda yuboring.",
        "Listening/reading javoblarini yuborish: /submit listening yoki /submit reading.",
      ].join("\n"),
    );
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
    for (const [index, word] of words.entries()) {
      user.vocabulary.push({
        id: `${source}-${unit}-${learnedAt}-${index}`,
        source,
        unit,
        word: word.word,
        meaning: word.meaning,
        reviewAt: reviewSchedule(learnedAt),
        reviewed: [false, false, false, false, false, false],
        remembered: [],
        notified: [false, false, false, false, false, false],
      });
    }
    getDay(user, day).newUnits.push(`${source}-${unit}`);
    await saveState();
    const wordList = words.map((word) => `• ${word.word} — ${word.meaning}`).join("\n");
    await sendMessage(
      chatId,
      `Unit ${unit} (${source}: ${BOOKS[source].name}) — ${words.length} ta yangi so‘z:\n\n${wordList}\n\nBirinchi takrorlash 25 daqiqadan keyin. Keyingilari 10 soat, 24 soat, 4, 14, 30 kun. Vaqti kelganda bot xabar yuboradi; qo‘lda boshlash uchun /review yozing.\n\nYangi so‘zlarni o‘rganayotganingizning o‘zi katta qadam. Davom eting!`,
    );
    return;
  }

  if (command === "/review") {
    await beginReview(chatId, user);
    return;
  }

  if (command === "/tasks") {
    await showDailyChecklist(chatId, day, user);
    return;
  }

  if (command === "/progress") {
    await sendProgress(chatId, user);
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
    await sendMessage(chatId, `${TASK_LABELS[task]} bajarildi deb belgilandi.\n\n${motivationForProgress(progress.percent)}`);
    return;
  }

  if (command === "/grammar") {
    user.pendingInput = { type: "grammar" };
    await saveState();
    await sendMessage(chatId, "Bugun Murphy’dan o‘qigan unit/mavzuni yozing. Yuborganingizda grammatika vazifasi bajarildi deb belgilanadi.");
    return;
  }

  if (command === "/submit") {
    const task = (args[0] || "").toLowerCase();
    if (task !== "listening" && task !== "reading") {
      await sendMessage(chatId, "Format: /submit listening yoki /submit reading.");
      return;
    }
    user.pendingInput = { type: task };
    await saveState();
    await sendMessage(chatId, `${TASK_LABELS[task]} javoblaringizni keyingi xabarda yuboring. Hozircha javoblar saqlanadi va vazifa bajarildi deb hisoblanadi; avtomatik xato tekshirish uchun javob kalitlari ulanmagan.`);
    return;
  }

  if (command === "/sentences") {
    user.pendingInput = { type: "sentences" };
    user.sentenceLines = [];
    await saveState();
    await sendMessage(chatId, "Murphy mavzusidagi 30 ta gapingizni yuboring — har bir gapni alohida qatorda yozing. Hozircha xatolar avtomatik tuzatilmaydi.");
    return;
  }

  await sendMessage(chatId, "Buyruq topilmadi. Mavjud buyruqlar uchun /help deb yozing.");
}

async function handleMessage(message) {
  if (!message.chat || !message.from) return;
  const user = getUser(message.chat.id);
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
    user.sentenceLines.push(...lines);
    const count = user.sentenceLines.length;
    if (count < 30) {
      await saveState();
      await sendMessage(message.chat.id, `${count}/30 ta gap qabul qilindi. Qolgan ${30 - count} tasini yuboring.`);
      return;
    }
    user.sentenceLines = user.sentenceLines.slice(0, 30);
    user.pendingInput = null;
    getDay(user, localDate()).tasks.sentences = true;
    await saveState();
    const progress = makeProgress(user, localDate());
    await sendMessage(message.chat.id, `30 ta gap qabul qilindi. Vazifa bajarildi deb hisoblandi; grammatik xatolar hozircha tekshirilmaydi.\n\n${motivationForProgress(progress.percent)}`);
    return;
  }

  user.pendingInput = null;
  const day = localDate();
  getDay(user, day).tasks[type] = true;
  await saveState();
  const progress = makeProgress(user, day);
  await sendMessage(message.chat.id, `${TASK_LABELS[type]} javoblari saqlandi va vazifa bajarildi deb belgilandi. Avtomatik xato tekshiruvi hozircha yoqilmagan.\n\n${motivationForProgress(progress.percent)}`);
}

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const user = getUser(chatId);
  const data = callback.data || "";

  if (data === "review:begin") {
    await answerCallback(callback.id, "Takrorlash boshlanmoqda");
    await beginReview(chatId, user);
    return;
  }
  if (data === "review:yes" || data === "review:no") {
    const current = user.reviewQueue?.items[user.reviewQueue.index];
    if (!current || user.reviewQueue.messageId !== callback.message.message_id) {
      await answerCallback(callback.id, "Bu takrorlash allaqachon belgilangan yoki faol emas");
      return;
    }
    const item = user.vocabulary.find((candidate) => candidate.id === current.itemId);
    if (!item) throw new Error(`Review word ${current.itemId} is missing`);
    item.reviewed[current.stage] = true;
    item.remembered[current.stage] = data === "review:yes";
    user.reviewQueue.index += 1;
    await answerCallback(callback.id, data === "review:yes" ? "Belgilandi: esingizda" : "Belgilandi: qayta ko‘rildi");
    await saveState();
    await sendMessage(chatId, `Ma’nosi: ${item.meaning}`);
    await showNextReview(chatId, user);
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
    await editMessage(
      chatId,
      callback.message.message_id,
      "Bugungi vazifani tanlang. Bajarilgach tugmani bosing:",
      {
        inline_keyboard: TASKS.map((entry) => [{
          text: `${daily.tasks[entry] ? "✅" : "☐"} ${TASK_LABELS[entry]}`,
          callback_data: `task:${entry}`,
        }]),
      },
    );
    return;
  }
  await answerCallback(callback.id, "Bu tugma endi faol emas");
}

async function sendDueNotifications(now = new Date()) {
  const timestamp = now.getTime();
  for (const [chatId, user] of Object.entries(state.users)) {
    const due = dueQueue(user, timestamp);
    const day = localDate(now);
    const unnotified = due.filter(({ itemId, stage }) => {
      const item = user.vocabulary.find((candidate) => candidate.id === itemId);
      if (!Array.isArray(item.notified)) item.notified = [false, false, false, false, false, false];
      return !item.notified[stage];
    });
    if (unnotified.length) {
      await sendMessage(
        chatId,
        `Lug‘at takrorlash vaqti keldi: ${unnotified.length} ta takrorlash kutmoqda. Boshlash uchun tugmani bosing.`,
        { inline_keyboard: [[{ text: "Takrorlashni boshlash", callback_data: "review:begin" }]] },
      );
      for (const entry of unnotified) {
        const item = user.vocabulary.find((candidate) => candidate.id === entry.itemId);
        item.notified[entry.stage] = true;
      }
      await saveState();
    }

    const shifted = new Date(timestamp + TZ_OFFSET_MINUTES * 60_000);
    const localHour = shifted.getUTCHours();
    if (localHour >= 21 && user.lastDailySent !== day) {
      await sendProgress(Number(chatId), user, day);
      user.lastDailySent = day;
      await saveState();
    }
  }
}

let state;
let vocabulary;

async function processTelegramUpdate(update) {
  if (Number.isInteger(update.update_id) && update.update_id <= (state.lastUpdateId ?? -1)) return;
  await sendDueNotifications();
  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
  if (Number.isInteger(update.update_id)) state.lastUpdateId = update.update_id;
  await saveState();
}

async function main() {
  if (!TOKEN) throw new Error("BOT_TOKEN is required. Create a Telegram bot and set its token in the environment.");
  if (!Number.isInteger(TZ_OFFSET_MINUTES) || TZ_OFFSET_MINUTES < -720 || TZ_OFFSET_MINUTES > 840) {
    throw new Error("TZ_OFFSET_MINUTES must be an integer from -720 to 840.");
  }
  state = await readState();
  vocabulary = await loadVocabulary();
  const webhookUrl = process.env.WEBHOOK_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`
      : null);
  if (!webhookUrl || !webhookUrl.startsWith("https://")) {
    throw new Error("Set WEBHOOK_URL to a public HTTPS URL, or deploy this service to Render.");
  }
  const port = Number.parseInt(process.env.PORT || "10000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  const webhookSecret = randomBytes(32).toString("hex");
  let pendingUpdates = Promise.resolve();
  const server = createWebhookServer(webhookSecret, (update) => {
    const currentUpdate = pendingUpdates.then(() => processTelegramUpdate(update));
    pendingUpdates = currentUpdate.catch((error) => {
      console.error("Telegram update failed:", error);
    });
    return currentUpdate;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Botni boshlash" },
      { command: "vocab", description: "Lug‘at unitini qo‘shish" },
      { command: "review", description: "Vaqti kelgan so‘zlarni takrorlash" },
      { command: "tasks", description: "Bugungi vazifalar" },
      { command: "progress", description: "Kunlik natija" },
      { command: "help", description: "Yordam" },
    ],
  });
  await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  setInterval(() => {
    sendDueNotifications().catch((error) => console.error("Scheduled notification failed:", error));
  }, 60_000);
  await sendDueNotifications();
  console.log(`English study Telegram bot webhook listening on port ${port}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Bot startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  countSentenceLines,
  createWebhookServer,
  dueQueue,
  loadVocabulary,
  localDate,
  makeProgress,
  motivationForProgress,
  normalizeAnswer,
  reviewSchedule,
};

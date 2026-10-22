# Ingliz tili self-study Telegram bot

Bot lug‘at takrorlash jadvalini, kunlik vazifalarni va bajarilgan ishlar foizini kuzatadi. Node.js 20+ va Docker bilan ishlaydi; Telegram bilan webhook orqali bog‘lanadi, gaplarni tekshirish uchun ixtiyoriy ravishda AI xizmatidan foydalanadi.

## Imkoniyatlar

- `word_list.json` (A) va `words2.json` (B) dagi 30 tadan unitni yuklaydi.
- **Lug‘at:** unit qo‘shilgach, uni 25 daqiqa, 10 soat, 24 soat, 4 kun, 14 kun va 30 kundan keyin o‘zi so‘raydi. Har bir takrorlashda unitning so‘zlari chiqadi (ma’nolari yashirin, bosib ko‘rasiz) va siz ✅ tugmasi bilan belgilaysiz.
- **Grammatika (Murphy):** kuniga bir marta yumshoq eslatadi; ✅ bosasiz yoki mavzuni yozasiz. Nechta kun qilganingiz hisoblanadi.
- **Listening va Reading:** `/submit listening 3` deb test raqamini, keyin javoblarni (`1A 2C 3B`) yuborasiz. Bot javob kaliti bilan solishtirib xatolarni topadi va natijani (masalan 17/20, 85%) hisoblab qo‘yadi.
- **30 ta gap:** gaplarni yuborasiz; 30 ta to‘lgach bot tekshirib, xatolarni tuzatib beradi va to‘g‘rilar sonini hisoblaydi (buning uchun `ANTHROPIC_API_KEY` kerak, pastga qarang).
- **Eslatmalar** (Toshkent vaqti): 10:00 grammatika, 15:00 listening, 17:00 reading, 19:00 gaplar. Bajarilgan vazifa uchun eslatma yuborilmaydi.
- **Soat 21:00:** “bugun nimalarni qildingiz?” deb so‘raydi, vazifalar ro‘yxatini tugmalar bilan beradi va bajarilgan ishlar foizini ko‘rsatadi. Vazifa topshirilganda ham foiz ko‘rsatiladi.
- `/stats` — umumiy statistika: lug‘at, o‘rtacha listening/reading, gaplar natijasi.

## Javob kalitlari (listening va reading)

Bot xatolarni topishi uchun har bir test uchun to‘g‘ri javoblar kerak. Ikki usul bor:

1. **Telegram orqali:** 
   ```
   /setkey listening 3
   1A
   2C
   3B
   ```
   Bir qatorda ham bo‘ladi: `/setkey reading 3 1A 2C 3B`. Kalitdan oldin yuborilgan javoblar ham avtomatik tekshiriladi.
2. **Fayl orqali:** `answer_keys.json` ga yozing, masalan `{"listening": {"Unit 1": {"1": "A", "2": "C"}}, "reading": {}}`. Bir nechta to‘g‘ri javob bo‘lsa `|` bilan ajrating: `"color|colour"`. Faylni o‘zgartirgach qayta deploy qiling.

Kalit yo‘q bo‘lsa, javoblar baribir saqlanadi va vazifa bajarilgan hisoblanadi, lekin xatolar tekshirilmaydi.

## Gaplarni tekshirish (AI)

Gaplarni tekshirish uchun Anthropic API kaliti kerak: `ANTHROPIC_API_KEY` ni Render’da maxfiy environment variable sifatida kiriting (model: `ANTHROPIC_MODEL`, standart `claude-haiku-5-5`). Kalit bo‘lmasa, 30 ta gap saqlanadi va vazifa bajarilgan hisoblanadi, lekin tuzatilmaydi. Tekshiruv ishlamay qolsa, `/checksentences` bilan qayta urinasiz. Kalitni hech qachon GitHub’ga qo‘ymang.

## Ma’lumotlarni saqlash va zaxira

Render bepul xizmatida `/tmp/state.json` doimiy emas: qayta deploy yoki restartda yo‘qoladi. Shu sabab bot har kuni 21:00 da sizga **zaxira fayl** (`study-backup-....json`) yuboradi; `/backup` bilan istalgan payt olasiz. Yo‘qolgan ma’lumotlarni tiklash uchun shu faylni botga yuboring. Doimiy saqlash kerak bo‘lsa, pullik Render diski yoki o‘z serveringizda Docker (`docker-compose.yml`) ishlating.

**Bepul tarif:** Render xizmati 15 daqiqa trafiksiz qolsa uxlaydi. Bot o‘ziga har 10 daqiqada so‘rov yuborib uyg‘oq turadi (`SELF_PING=0` bilan o‘chiriladi). Ishonchliroq bo‘lishi uchun qo‘shimcha ravishda UptimeRobot kabi xizmatda `https://<xizmat>.onrender.com/healthz` manzilini har 5 daqiqada tekshirishni qo‘shing.

**Xavfsizlik:** botni faqat o‘zingiz ishlatishi uchun `ALLOWED_CHAT_IDS` ga o‘z chat ID’ingizni yozing (ID’ni `@userinfobot` dan bilib olasiz). Aks holda bot topgan har kim undan foydalana oladi va AI kalitingiz sarflanadi.

## Render’da bepul Web Service yaratish

1. Telegram’da `@BotFather` orqali bot yarating va token oling. Tokenni chatga yubormang.
2. Loyiha fayllarini o‘zingizning GitHub repozitoriyingizga joylang. Telegram tokenini repozitoriyga qo‘shmang.
3. Render’da **New → Blueprint** orqali GitHub omboringizni ulang. `render.yaml` bepul Web Service, webhook va sog‘liq tekshiruvini sozlaydi. `word_list.json` va `words2.json` GitHub omborining bosh papkasida bo‘lishi kerak; Dockerfile ularni shu yerdan olib, konteyner ichidagi `materials` papkasiga joylaydi.
4. Blueprint yaratilayotganda `BOT_TOKEN` maydoniga BotFather tokenini kiriting. Tokenni faqat Render’dagi maxfiy environment variable sifatida saqlang.
5. Render deploy tugagach Telegram’da botga `/start` yuboring.

Blueprint yaratilayotganda `ANTHROPIC_API_KEY` va `ALLOWED_CHAT_IDS` maydonlarini ham to‘ldiring. `render.yaml` da `DATA_FILE=/tmp/state.json`, `MATERIALS_DIR=/app/materials`, `PORT=10000` va Toshkent vaqti uchun `TZ_OFFSET_MINUTES=300` belgilangan. Bepul Web Service’da doimiy disk bo‘lmaydi; yuqoridagi cheklovlarni inobatga oling.

## Windows’da vaqtincha ishga tushirish

1. Node.js 20 yoki yangiroq versiyasini o‘rnating.
2. PowerShell oynasida loyiha papkasiga o‘ting:

   ```powershell
   Set-Location 'D:\Bot\Engilish for me'
   ```

3. BotFather tokenini PowerShell’ga kiriting:

   ```powershell
   $env:BOT_TOKEN = 'BOTFATHER_BERGAN_TOKEN'
   $env:BOT_MODE = 'polling'
   npm start
   ```

4. Telegram’da botga `/start` yuboring. Ishlashi uchun kompyuter, internet va PowerShell oynasi yoqilgan bo‘lishi kerak. To‘xtatish uchun `Ctrl+C` bosing.

Polling ishga tushganda Telegram webhook’i o‘chiriladi. Shu vaqt ichida Render’dagi ayni bot xabar olmaydi. Mahalliy botni to‘xtatgach, Render’dagi servisini qayta ishga tushiring yoki qayta deploy qiling; u webhook’ni qayta sozlaydi. Mahalliy ma’lumotlar `data\state.json` faylida, Render ma’lumotlari esa `/tmp/state.json` faylida alohida saqlanadi.

### Docker’da mahalliy tekshirish

```powershell
docker compose build
```

Konteynerni Render’dan tashqarida ishga tushirish uchun `BOT_TOKEN` bilan birga Telegram kira oladigan ochiq HTTPS `WEBHOOK_URL` ham kerak. Mahalliy `localhost` webhook sifatida ishlamaydi. Render’ga deploy qilinganda webhook manzili avtomatik aniqlanadi.

## Buyruqlar

`/start` yoki `/help` yuborsangiz, tugmali menyu chiqadi. Buyruqlarni qo‘lda yuborish ham ishlaydi.

- `/vocab A 1`, `/vocab B 1` — unitni qo‘shish. `/review` — vaqti kelgan takrorlashlar.
- `/tasks` — bugungi vazifalar va foiz (tugmalar bilan belgilash). `/progress` — bugungi natija. `/stats` — umumiy statistika.
- `/grammar` — Murphy mavzusini yuborish. `/done grammar|listening|reading|sentences` — qo‘lda belgilash.
- `/submit listening 3`, `/submit reading 3` (yoki `/listening 3`, `/reading 3`) — javoblarni yuborish.
- `/setkey listening 3` — javob kalitini qo‘shish.
- `/sentences [mavzu]` — 30 ta gap yuborish. `/checksentences` — qayta tekshirish.
- `/backup` — zaxira fayl. Faylni botga yuborsangiz, ma’lumotlar tiklanadi.

## Mahalliy tekshiruv

```powershell
npm test
```

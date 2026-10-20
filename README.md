# Ingliz tili self-study Telegram bot

Bot lug‘at takrorlash jadvalini, kunlik vazifalarni va bajarilgan ishlar foizini kuzatadi. Node.js 20+ va Docker bilan ishlaydi; Telegram bilan webhook orqali bog‘lanadi, tashqi AI xizmati talab qilinmaydi.

## Hozirgi imkoniyatlar

- `word_list.json` va `words2.json` dagi 30 tadan unitni yuklaydi (`A` va `B`).
- Har bir qo‘shilgan unitdagi so‘zlarni 25 daqiqa, 10 soat, 24 soat, 4 kun, 14 kun va 30 kundan keyin takrorlatadi. Har bir so‘z uchun “Esimda” yoki “Qayta ko‘raman” tugmasi bor.
- Grammatika, listening, reading va Murphy bo‘yicha 30 ta gap topshirilganini qayd etadi.
- Har kuni Toshkent vaqti bilan 21:00 dan keyin kunlik hisobot yuboradi.
- Vazifa topshirganda va kunlik hisobotda natijaga mos ruhlantiruvchi o‘zbekcha xabar beradi.
- O‘rganish ma’lumotlari `/tmp/state.json` faylida saqlanadi. Render’ning bepul xizmatida bu doimiy xotira emas.

**Bepul tarif cheklovlari:** Render bepul web-xizmati ishlatilmay turganda uxlab qolishi mumkin. Shu paytda eslatmalar kechikishi yoki kelmasligi mumkin. `/tmp/state.json` faylidagi ma’lumotlar xizmat qayta ishga tushsa yoki qayta joylansa yo‘qolishi mumkin. Keyinroq kelgan Telegram xabari xizmatni uyg‘otishi mumkin, ammo kunlik hisobot aynan 21:00 da kelishiga kafolat yo‘q.

**Boshqa cheklovlar:** AI tekshiruvi o‘chiq. Bot hozircha grammatik gaplarni tuzatmaydi; reading/listening javoblarini qabul qilib, topshirilgan deb hisoblaydi, lekin xatolarni javob kaliti bilan solishtirmaydi. Reading uchun javoblar kaliti bor, uni tekshiruvga ulash kerak. Listening papkasida alohida audio fayllar ko‘rinmadi.

## Render’da bepul Web Service yaratish

1. Telegram’da `@BotFather` orqali bot yarating va token oling. Tokenni chatga yubormang.
2. Loyiha fayllarini o‘zingizning GitHub repozitoriyingizga joylang. Telegram tokenini repozitoriyga qo‘shmang.
3. Render’da **New → Blueprint** orqali GitHub omboringizni ulang. `render.yaml` bepul Web Service, webhook va sog‘liq tekshiruvini sozlaydi. `word_list.json` va `words2.json` GitHub omborining bosh papkasida bo‘lishi kerak; Dockerfile ularni shu yerdan olib, konteyner ichidagi `materials` papkasiga joylaydi.
4. Blueprint yaratilayotganda `BOT_TOKEN` maydoniga BotFather tokenini kiriting. Tokenni faqat Render’dagi maxfiy environment variable sifatida saqlang.
5. Render deploy tugagach Telegram’da botga `/start` yuboring.

`render.yaml` da `DATA_FILE=/tmp/state.json`, `MATERIALS_DIR=/app/materials`, `PORT=10000` va Toshkent vaqti uchun `TZ_OFFSET_MINUTES=300` belgilangan. Bepul Web Service’da doimiy disk bo‘lmaydi; yuqoridagi cheklovlarni inobatga oling.

### Docker’da mahalliy tekshirish

```powershell
docker compose build
```

Konteynerni Render’dan tashqarida ishga tushirish uchun `BOT_TOKEN` bilan birga Telegram kira oladigan ochiq HTTPS `WEBHOOK_URL` ham kerak. Mahalliy `localhost` webhook sifatida ishlamaydi. Render’ga deploy qilinganda webhook manzili avtomatik aniqlanadi.

## Buyruqlar

- `/vocab A 1` — `word_list.json` faylidagi 1-unitni qo‘shish.
- `/vocab B 1` — `words2.json` faylidagi 1-unitni qo‘shish.
- `/review` — vaqti kelgan lug‘atlarni ko‘rish.
- `/tasks` — kunlik vazifalarni belgilash.
- `/grammar` — Murphy mavzusini yuborib, grammatikani bajarilgan deb belgilash.
- `/submit listening` yoki `/submit reading` — javoblarni yuborib, topshirilganini qayd etish.
- `/sentences` — 30 ta gapni, har birini alohida qatorda, yuborish.
- `/done grammar`, `/done listening`, `/done reading`, `/done sentences` — vazifani qo‘lda bajarilgan deb belgilash.
- `/progress` — bugungi natija.

## Mahalliy tekshiruv

```powershell
npm test
```

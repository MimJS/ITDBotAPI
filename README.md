# ITDBotAPI

[![npm](https://img.shields.io/npm/v/itdbotapi)](https://www.npmjs.com/package/itdbotapi) [![license](https://img.shields.io/npm/l/itdbotapi)](LICENSE)

Неофициальная библиотека для личных сообщений [итд.com](https://xn--d1ah4a.com): авторизация по refresh-токену, события в реальном времени через WebSocket, отправка текста, фото и файлов от вашего имени. TypeScript, ESM, Node.js 20.10+.

```ts
import { ITDBotAPI } from "itdbotapi";

const client = new ITDBotAPI({
  refreshToken: process.env.ITD_REFRESH_TOKEN,
  sessionFile: ".itd-session.json",
});

client.command("cat", (ctx) => ctx.replyWithPhoto("https://cataas.com/cat"));
client.hears("!кот", (ctx) => ctx.replyWithPhoto("https://cataas.com/cat", { caption: "🐱" }));

await client.start();
```

## Установка

```bash
npm install itdbotapi
```

## Примеры

В папке [`examples/`](examples):

- [`cat-bot.ts`](examples/cat-bot.ts) — на `/cat` или «!кот» в ЛС отвечает фоткой случайного кота.
- [`inspect.ts`](examples/inspect.ts) — проверка без отправки сообщений: профиль, чаты и события за 60 секунд.

```bash
git clone https://github.com/MimJS/ITDBotAPI.git && cd ITDBotAPI
npm install && npm run build
cp .env.example .env   # вписать ITD_REFRESH_TOKEN
npm run example:inspect
npm run example:cat
```

## Авторизация

Вход по паролю на сайте требует капчу, поэтому библиотека работает от **refresh-токена** — это HttpOnly-cookie `refresh_token`.

1. Откройте итд.com в окне инкогнито и войдите. Так у бота будет своя сессия, отдельная от вашего основного браузера.
2. DevTools → Application → Cookies → `https://xn--d1ah4a.com` → скопируйте значение `refresh_token`.
3. Закройте окно инкогнито, **не нажимая «Выйти»** (выход отзывает токен).
4. Передайте токен в `refreshToken` и укажите `sessionFile`.

Сервер выдаёт новый refresh-токен при каждом обновлении, а старый после этого не работает. Библиотека сохраняет актуальный токен и `deviceId` в `sessionFile` и при следующем запуске берёт токен оттуда. После первого запуска токен из `.env` уже израсходован: источник правды — `sessionFile`. Без `sessionFile` (или своего `sessionStore`) после перезапуска понадобится новый токен.

Access-токен (JWT) живёт около 15 минут. Он обновляется сам: заранее, при ответе 401 и при закрытии WebSocket с кодом 4001/4003.

## Опции `new ITDBotAPI(options)`

| Опция | По умолчанию | Описание |
|---|---|---|
| `refreshToken` | — | значение cookie `refresh_token` |
| `sessionFile` | — | JSON-файл для актуального refresh-токена и deviceId (права 600) |
| `sessionStore` | — | своё хранилище `{ load(), save(data) }` вместо файла |
| `accessToken` | — | готовый JWT, если нужен разовый скрипт без refresh |
| `deviceId` | из сессии или случайный | заголовок `X-Device-Id` |
| `commandPrefixes` | `["/"]` | префиксы для `command()` |
| `autoMarkRead` | `false` | помечать входящие прочитанными |
| `showUploadStatus` | `true` | показывать «отправляет фото…» во время загрузки |
| `rateLimit` | `{ autoRetry: true, maxWaitMs: 15000, maxRetries: 3 }` | ожидание и повтор при 429 |
| `realtime` | ping 10 с, heartbeat 30 с, reconnect 2–30 с | параметры WebSocket |
| `timeoutMs` | `30000` | таймаут HTTP |
| `baseUrl`, `userAgent`, `headers`, `fetch` | | транспорт, например прокси через свой `fetch` |

## Жизненный цикл

```ts
await client.login();   // только REST: токен + профиль (для скриптов)
await client.start();   // login + WebSocket + события; резолвится после подключения
client.stop();          // отключиться

// Чтобы после перезапуска обработать сообщения, пришедшие, пока бот был выключен:
await client.start({ resumeFromSeq: savedSeq }); // savedSeq = client.lastEventSeq перед остановкой
```

Если WebSocket отваливается, клиент сам переподключается и докачивает пропущенные события через `/updates` по номеру `event_seq`. Дубли отбрасываются.

## События

Подписка через `client.on(ClientEvent.X, handler)` или строкой: `client.on("message", ...)`.

| `ClientEvent` | Аргумент | Когда |
|---|---|---|
| `Ready` | `MyProfile` | `start()` завершён |
| `Message` | `MessageContext` | входящее сообщение от другого человека |
| `OwnMessage` | `MessageContext` | ваше сообщение (с этого клиента или другого устройства) |
| `MessageEdited` | `{ chatId, messageId, message }` | |
| `MessageDeleted` | `{ chatId, messageIds, newLastMessage }` | |
| `MessagesRead` | `{ chatId, userId, lastReadMessageId, isOwn }` | |
| `Reactions` | `{ chatId, messageId, reactions, reactionVersion }` | |
| `Typing` | `{ chatId, userId, action, progress? }` | «печатает…» |
| `Presence` | `{ userId, online }` | онлайн/офлайн |
| `ChatCreated` | `{ chatId, chat? }` | новый чат; первые сообщения придут как `Message` |
| `ChatDeleted`, `HistoryCleared` | `{ chatId }` | |
| `ChatSettings` | `{ chatId, isPinned?, isMuted?, markedUnread?, isRequest? }` | |
| `Raw` | кадр сервера как есть | любое событие, включая новые типы |
| `Connected` / `Disconnected` | — / `{ code, reason, willReconnect }` | состояние WebSocket |
| `Resync` | — | сервер попросил перечитать состояние |
| `TokenRefreshed` | `{ accessTokenExpiresAt, refreshTokenRotated }` | |
| `Error` | `Error` | ошибки сети и обработчиков; процесс не падает |

## Команды и фильтры

```ts
client.command("cat", handler);               // /cat, /CAT, /cat 3 → ctx.command = { name, args, argsText }
client.command(["cat", "кот"], handler);      // несколько имён
client.hears("!кот", handler);                // точное совпадение без учёта регистра и пробелов по краям
client.hears(/^мяу+$/i, handler);             // регулярка → ctx.match
client.hears((ctx) => ctx.photos.length > 0, handler); // свой фильтр
client.command("ping", handler, { includeOwn: true }); // реагировать и на свои сообщения
```

На каждое сообщение срабатывает первый подходящий обработчик (в порядке регистрации). Свои сообщения по умолчанию игнорируются, поэтому бот не отвечает сам себе.

## MessageContext

```ts
ctx.chatId, ctx.id, ctx.text, ctx.senderId, ctx.date
ctx.isOwn, ctx.isSystem, ctx.isForwarded
ctx.attachments, ctx.photos, ctx.entities, ctx.replyTo, ctx.message // исходный объект

await ctx.reply("текст", { quote: true });               // quote → ответ с цитатой
await ctx.replyWithPhoto(source, { caption: "🐱" });
await ctx.replyWithFile(source, { caption, filename });
await ctx.sendChatAction(ChatAction.Typing);
await ctx.markRead();
await ctx.react("👍");                                   // [] — убрать реакции
await ctx.edit("новый текст");                           // только своё
await ctx.delete({ forEveryone: true });
await ctx.forwardTo(otherChatId);
await ctx.acceptRequest();                               // принять запрос на переписку
const files = await ctx.downloadAttachments();
```

`source` для файлов: путь, `http(s)`-URL (скачивается), `Buffer` / `Uint8Array` / `ArrayBuffer`, `Blob` / `File`, или `{ data, filename, mime }`. MIME и размеры картинок (PNG/JPEG/GIF/WebP) определяются по содержимому.

## Методы клиента

```ts
client.sendMessage(chatId, text, { replyTo, entities, clientMessageId })
client.sendPhoto(chatId, source, { caption, replyTo })
client.sendFile(chatId, source, { caption, filename, mime })
client.sendFiles(chatId, [src1, src2], { caption })     // несколько вложений в одном сообщении
client.sendMessageToUser("@username" | userId, text)
client.sendPhotoToUser("@username" | userId, source, { caption })
client.getDirectChatId("@username")
client.uploadFiles(chatId | null, sources)               // → fileId[]
client.react(chatId, messageId, "👍" | ["👍", "🔥"] | [])
client.downloadAttachment(attachment, chatId?)           // → Buffer
client.syncMissed()                                      // вручную докачать пропущенное
client.me, client.userId, client.isConnected, client.lastEventSeq
```

## Низкоуровневое API

Ответы сервера возвращаются как есть (snake_case, типы в `types.ts`).

```ts
client.messenger.getChats({ limit, before })      // { chats, next_before, event_seq }
client.messenger.iterateChats()                    // async-итератор по всем чатам
client.messenger.getChat(chatId)
client.messenger.getUnread()                       // { total, chats_with_unread, event_seq }
client.messenger.getMessages(chatId, { limit, before })
client.messenger.getMessagesAround(chatId, messageId, limit)
client.messenger.sendMessage / sendMessageToUser / editMessage / deleteMessages / forwardMessages
client.messenger.markRead / markUnread / setPinned / setMuted / clearHistory / deleteChat
client.messenger.createDirectChat(userId) / acceptRequest(chatId)
client.messenger.sendChatAction(chatId, ChatAction.UploadPhoto, progress?)
client.messenger.getReactionCatalog() / getReactions() / setReactions()
client.messenger.getChatMedia(chatId, MediaCategory.Media) / getFileLinks(chatId, fileIds)
client.messenger.getPresence(userId) / getPresenceMany(userIds)
client.messenger.getUpdates(sinceSeq)

client.users.getMe() / getUser("@username") / resolveId("@username")
client.media.upload(source, { filename, mime, width, height, onProgress }) // → { fileId }
client.http.get/post/put/patch/delete(path, ...)   // любой эндпоинт с авторизацией
```

## Enum'ы

`ClientEvent`, `MessengerEventType`, `ChatType`, `ChatAction`, `MediaCategory`, `EntityType`, `ReactionType`, `ApiErrorCode`, `RateLimitScope`, `WsCloseCode`.

## Ошибки

- `ITDApiError`: `status`, `code` (`ApiErrorCode`), `fieldErrors`, `body`.
- `ITDRateLimitError`: 429, `retryAfterSeconds`, `scope`. `RateLimitScope.NewRecipientsHour` / `NewRecipientsDay` значит, что вы начали слишком много новых диалогов. В уже открытых чатах писать можно.
- `ITDAuthError`: refresh-токен отсутствует, истёк или отозван. Нужен новый.

При 429 клиент сам ждёт `Retry-After` (до `rateLimit.maxWaitMs`) и повторяет запрос. Отправка сообщений идемпотентна: `client_message_id`, повтор не создаёт дубль.

## Как это устроено

| Что | Запрос |
|---|---|
| Обновление токена | `POST /api/v1/auth/refresh`, cookie `refresh_token` → `{ accessToken }` |
| Профиль | `GET /api/users/me`, `GET /api/users/:username` |
| REST мессенджера | `/api/v1/messenger/*`, `Authorization: Bearer <JWT>`, `X-Device-Id` |
| События | `wss://xn--d1ah4a.com/api/v1/messenger/ws?capabilities=chat_settings_v2`, подпротоколы `itd.messenger.v1` + `bearer.<JWT>`, heartbeat `ping`/`pong` |
| Докачка | `GET /api/v1/messenger/updates?since=<event_seq>` |
| Загрузка | `POST media/upload/init` → `PUT media/upload/:id/part/:n` (по 5 МБ) → `POST media/upload/:id/finalize` → `fileId` |

## Ограничения

- API неофициальное и может поменяться без предупреждения.
- Сейчас на сайте есть только личные чаты (`ChatType.Direct`).
- Скачивание вложений сделано по коду сайта, на реальных файлах не проверено.
- Пишите людям, которые сами вам написали. Массовые рассылки упрутся в лимиты новых диалогов и нарушают правила площадки.

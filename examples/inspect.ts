/**
 * Проверка без отправки сообщений: авторизуется, печатает профиль и чаты,
 * затем 60 секунд слушает события WebSocket и выводит их.
 *
 *   npm run example:inspect
 */
import { ClientEvent, ITDBotAPI } from "itdbotapi";

const client = new ITDBotAPI({
  refreshToken: process.env.ITD_REFRESH_TOKEN,
  sessionFile: process.env.ITD_SESSION_FILE ?? ".itd-session.json",
});

client.on(ClientEvent.TokenRefreshed, (e) =>
  console.log(`🔑 access-токен до ${e.accessTokenExpiresAt?.toLocaleTimeString()}, refresh-токен ротирован: ${e.refreshTokenRotated}`),
);
client.on(ClientEvent.Connected, () => console.log("🟢 WebSocket подключён"));
client.on(ClientEvent.Disconnected, (e) => console.log(`🔴 WebSocket отключён: ${e.code} ${e.reason}`));
client.on(ClientEvent.Message, (ctx) => console.log(`💬 [${ctx.chatId}] ${ctx.senderId}: ${ctx.text}`, ctx.attachments));
client.on(ClientEvent.OwnMessage, (ctx) => console.log(`📤 [${ctx.chatId}] я: ${ctx.text}`));
client.on(ClientEvent.Typing, (e) => console.log(`✍️  ${e.userId} ${e.action} в ${e.chatId}`));
client.on(ClientEvent.Presence, (e) => console.log(`👀 ${e.userId} ${e.online ? "онлайн" : "офлайн"}`));
client.on(ClientEvent.MessagesRead, (e) => console.log(`✅ ${e.userId} прочитал до ${e.lastReadMessageId}`));
client.on(ClientEvent.Error, (error) => console.error("⚠️ ", error.message));

const me = await client.start();
console.log(`Я: @${me.username} «${me.displayName}» id=${me.id}`);

const { chats } = await client.messenger.getChats({ limit: 20 });
for (const chat of chats) {
  console.log(`• ${chat.title} (${chat.chat_id}) непрочитано: ${chat.unread_count} — «${chat.last_message?.text ?? ""}»`);
}
console.log(`event_seq=${client.lastEventSeq}. Слушаю события 60 секунд…`);

setTimeout(() => {
  client.stop();
  process.exit(0);
}, 60_000);

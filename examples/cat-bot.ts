/**
 * Пример: бот от вашего имени, который на `/cat` или «!кот» в ЛС отвечает фоткой случайного кота.
 *
 *   cp .env.example .env   # вписать ITD_REFRESH_TOKEN
 *   npm run example:cat
 */
import { ClientEvent, ITDBotAPI, type MessageContext } from "itdbotapi";

const client = new ITDBotAPI({
  refreshToken: process.env.ITD_REFRESH_TOKEN,
  sessionFile: process.env.ITD_SESSION_FILE ?? ".itd-session.json",
});

/** Ссылка на случайного кота: TheCatAPI, а если он не ответил — cataas.com. */
async function randomCatUrl(): Promise<string> {
  try {
    const res = await fetch("https://api.thecatapi.com/v1/images/search", { signal: AbortSignal.timeout(5000) });
    const [cat] = (await res.json()) as Array<{ url?: string }>;
    if (cat?.url) return cat.url;
  } catch {
    /* запасной вариант ниже */
  }
  return `https://cataas.com/cat?ts=${Date.now()}`;
}

async function sendCat(ctx: MessageContext): Promise<void> {
  try {
    await ctx.replyWithPhoto(await randomCatUrl(), { caption: "🐱" });
  } catch (error) {
    console.error("Не удалось отправить кота:", error);
    await ctx.reply("Коты разбежались, попробуй ещё раз 🙀").catch(() => undefined);
  }
}

client.command(["cat", "кот"], sendCat); // /cat, /кот
client.hears(/^!\s*(кот|котик|cat)\s*$/i, sendCat); // «!кот», «! котик», «!cat»

client.on(ClientEvent.Ready, (me) => console.log(`Готов: @${me.username} (${me.id}). Жду /cat и !кот`));
client.on(ClientEvent.Message, (ctx) => console.log(`[${ctx.chatId}] ${ctx.senderId}: ${ctx.text}`));
client.on(ClientEvent.Disconnected, (e) => console.warn(`WebSocket отключён (${e.code}), переподключение: ${e.willReconnect}`));
client.on(ClientEvent.Error, (error) => console.error("Ошибка:", error.message));

await client.start();

const shutdown = () => {
  client.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

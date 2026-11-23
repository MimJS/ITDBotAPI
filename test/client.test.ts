import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClientEvent,
  ITDBotAPI,
  MemorySessionStore,
  MessengerEventType,
  imageSize,
  parseCommand,
  sniffMime,
  uuidv7,
  type MessengerFrame,
} from "../src/index.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

function msg(id: string, text: string, sender = OTHER) {
  return { message_id: id, sender_id: sender, created_at: new Date().toISOString(), text, attachments: [], reactions: [] };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Мини-сервер на моках fetch. */
function mockServer(updates: Array<{ events: MessengerFrame[]; next_event_seq: number }> = []) {
  const calls: Call[] = [];
  let refreshCount = 0;
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path: url.pathname + url.search, body, headers });
    const json = (data: unknown, status = 200, extra: [string, string][] = []) =>
      new Response(JSON.stringify(data), { status, headers: [["content-type", "application/json"], ...extra] });

    if (url.pathname === "/api/v1/auth/refresh") {
      refreshCount++;
      if (!headers.cookie?.includes("refresh_token=")) return json({ error: { code: "REFRESH_TOKEN_MISSING", message: "no" } }, 401);
      return json({ accessToken: jwt({ sub: ME, exp: Math.floor(Date.now() / 1000) + 900 }) }, 200, [
        ["set-cookie", `refresh_token=rotated-${refreshCount}; Path=/api/v1/auth; HttpOnly`],
        ["set-cookie", "is_auth=1; Path=/"],
      ]);
    }
    if (url.pathname === "/api/users/me") return json({ id: ME, username: "me", displayName: "Me" });
    if (url.pathname === "/api/users/someone") return json({ id: OTHER, username: "someone", displayName: "S" });
    if (url.pathname === "/api/v1/messenger/chats/unread") return json({ total: 0, chats_with_unread: 0, event_seq: 10 });
    if (url.pathname === "/api/v1/messenger/updates") {
      const next = updates.shift();
      const since = Number(url.searchParams.get("since"));
      return json({ events: next?.events ?? [], reset_required: false, next_event_seq: next?.next_event_seq ?? since });
    }
    if (url.pathname.endsWith("/messages") && method === "POST") return json({ message_id: uuidv7(), chat_id: CHAT, event_seq: 99 });
    if (url.pathname.endsWith("/action")) return new Response(null, { status: 204 });
    return json({ error: { code: "ENTITY_NOT_FOUND", message: "not mocked " + url.pathname } }, 404);
  };
  return { fetch: fetchMock, calls };
}

async function loggedIn(server: ReturnType<typeof mockServer>, store = new MemorySessionStore(), seq = 10) {
  const client = new ITDBotAPI({ refreshToken: "initial", sessionStore: store, fetch: server.fetch });
  client.on(ClientEvent.Error, (e) => assert.fail(e));
  await client.login();
  client.setEventSeq(seq);
  return client;
}

/** Имитирует кадр из WebSocket. */
function frame(client: ITDBotAPI, f: MessengerFrame) {
  (client.realtime as unknown as { emit: (e: string, f: MessengerFrame) => void }).emit("frame", f);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("parseCommand", () => {
  assert.deepEqual(parseCommand("/cat", ["/"]), { name: "cat", prefix: "/", args: [], argsText: "" });
  assert.deepEqual(parseCommand("  /CAT 3 big ", ["/"]), { name: "cat", prefix: "/", args: ["3", "big"], argsText: "3 big" });
  assert.equal(parseCommand("/cat@bot", ["/"])?.name, "cat");
  assert.equal(parseCommand("!Кот", ["!", "/"])?.name, "кот");
  assert.equal(parseCommand("cat", ["/"]), null);
  assert.equal(parseCommand("/", ["/"]), null);
});

test("sniffMime + imageSize", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 480);
  assert.equal(sniffMime(png), "image/png");
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });

  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00]);
  assert.deepEqual(imageSize(gif), { width: 288, height: 16 });

  // JPEG: SOI, APP0 (длина 4), SOF0 (h=100, w=200)
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03]);
  assert.equal(sniffMime(jpeg), "image/jpeg");
  assert.deepEqual(imageSize(jpeg), { width: 200, height: 100 });
});

test("uuidv7", () => {
  assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("refresh: cookie, ротация refresh-токена и сохранение в sessionStore", async () => {
  const server = mockServer();
  const store = new MemorySessionStore();
  const client = await loggedIn(server, store);
  assert.equal(client.userId, ME);
  const refreshCall = server.calls.find((c) => c.path === "/api/v1/auth/refresh");
  assert.equal(refreshCall?.headers.cookie, "refresh_token=initial");
  assert.equal(refreshCall?.headers["x-requested-with"], "XMLHttpRequest");
  assert.equal(store.load()?.refreshToken, "rotated-1");
  assert.equal(client.auth.refreshToken, "rotated-1");
  const meCall = server.calls.find((c) => c.path === "/api/users/me");
  assert.match(meCall?.headers.authorization ?? "", /^Bearer /);
  assert.equal(meCall?.headers["x-device-id"], store.load()?.deviceId);
});

test("события: входящие/свои сообщения, дубли, команды и hears", async () => {
  const server = mockServer();
  const client = await loggedIn(server);
  const incoming: string[] = [];
  const own: string[] = [];
  const handled: string[] = [];
  client.on(ClientEvent.Message, (ctx) => void incoming.push(ctx.text));
  client.on(ClientEvent.OwnMessage, (ctx) => void own.push(ctx.text));
  client.command("cat", (ctx) => void handled.push(`cmd:${ctx.command?.args.join(",")}`));
  client.hears("!кот", () => void handled.push("hears:кот"));
  client.hears(/^мяу+$/i, (ctx) => void handled.push(`re:${ctx.match?.[0]}`));

  frame(client, { type: MessengerEventType.NewMessage, chat_id: CHAT, message: msg("m1", "/cat 2"), event_seq: 11 });
  frame(client, { type: MessengerEventType.NewMessages, chat_id: CHAT, messages: [msg("m2", "!КОТ "), msg("m3", "Мяууу")], event_seq: 12 });
  frame(client, { type: MessengerEventType.NewMessage, chat_id: CHAT, message: msg("m1", "/cat 2"), event_seq: 12 }); // дубль
  frame(client, { type: MessengerEventType.OwnMessages, chat_id: CHAT, messages: [msg("m4", "/cat", ME)], event_seq: 13 });
  frame(client, { type: MessengerEventType.Presence, user_id: OTHER, online: true });
  await tick();

  assert.deepEqual(incoming, ["/cat 2", "!КОТ ", "Мяууу"]);
  assert.deepEqual(own, ["/cat"]);
  assert.deepEqual(handled, ["cmd:2", "hears:кот", "re:Мяууу"]); // своё /cat не обработано
  assert.equal(client.lastEventSeq, 13);
});

test("первое сообщение от нового человека (chat_created) тоже приходит как message", async () => {
  const client = await loggedIn(mockServer());
  const got: string[] = [];
  client.on(ClientEvent.ChatCreated, (e) => void got.push(`chat:${e.chatId}`));
  client.on(ClientEvent.Message, (ctx) => void got.push(ctx.text));
  frame(client, { type: MessengerEventType.ChatCreated, chat_id: CHAT, messages: [msg("c1", "/cat")], event_seq: 11 });
  await tick();
  assert.deepEqual(got, [`chat:${CHAT}`, "/cat"]);
});

test("пропуск номера события → докачка через /updates", async () => {
  const server = mockServer([
    { events: [{ type: MessengerEventType.NewMessage, chat_id: CHAT, message: msg("g11", "пропущенное"), event_seq: 11 }], next_event_seq: 11 },
  ]);
  const client = await loggedIn(server);
  const texts: string[] = [];
  client.on(ClientEvent.Message, (ctx) => void texts.push(ctx.text));

  frame(client, { type: MessengerEventType.NewMessage, chat_id: CHAT, message: msg("g12", "новое"), event_seq: 12 });
  await tick();
  assert.deepEqual(texts, ["пропущенное", "новое"]);
  assert.equal(client.lastEventSeq, 12);
  assert.ok(server.calls.some((c) => c.path.startsWith("/api/v1/messenger/updates?since=10")));
});

test("ctx.reply отправляет в тот же чат с client_message_id и reply_to", async () => {
  const server = mockServer();
  const client = await loggedIn(server);
  client.command("ping", (ctx) => ctx.reply("pong", { quote: true }));
  frame(client, { type: MessengerEventType.NewMessage, chat_id: CHAT, message: msg("p1", "/ping"), event_seq: 11 });
  await tick();
  const send = server.calls.find((c) => c.method === "POST" && c.path === `/api/v1/messenger/chats/${CHAT}/messages`);
  assert.ok(send, "сообщение не отправлено");
  const body = send.body as Record<string, unknown>;
  assert.equal(body.text, "pong");
  assert.equal(body.reply_to_id, "p1");
  assert.match(String(body.client_message_id), /^[0-9a-f-]{36}$/);
});

test("sendMessageToUser резолвит @username", async () => {
  const server = mockServer();
  const client = await loggedIn(server);
  await client.sendMessageToUser("@someone", "привет");
  assert.ok(server.calls.some((c) => c.method === "POST" && c.path === `/api/v1/messenger/users/${OTHER}/messages`));
});

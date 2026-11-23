import { randomUUID } from "node:crypto";
import { MediaAPI, type UploadOptions } from "./api/media.js";
import { MessengerAPI, type SendMessageOptions } from "./api/messenger.js";
import { UsersAPI } from "./api/users.js";
import { AuthManager } from "./auth.js";
import { API_PATHS, DEFAULT_BASE_URL, DEFAULT_USER_AGENT } from "./constants.js";
import { MessageContext, parseCommand } from "./context.js";
import { ChatAction, ClientEvent, MessengerEventType, ReactionType } from "./enums.js";
import { ITDApiError, ITDAuthError } from "./errors.js";
import { HttpClient, type RateLimitOptions, type TransportConfig } from "./http.js";
import { RealtimeGateway, type RealtimeOptions } from "./realtime.js";
import { FileSessionStore, type SessionStore } from "./session.js";
import type {
  Attachment,
  ChatCreatedEvent,
  ChatEvent,
  ChatSettingsEvent,
  DisconnectedEvent,
  KnownMessengerFrame,
  Message,
  MessageDeletedEvent,
  MessageEditedEvent,
  MessageEntity,
  MessageReactions,
  MessagesReadEvent,
  MessengerFrame,
  MyProfile,
  PresenceEvent,
  Reaction,
  ReactionsEvent,
  SentMessage,
  TokenRefreshedEvent,
  TypingEvent,
} from "./types.js";
import { TypedEmitter } from "./utils/emitter.js";
import { resolveFile, type FileSource } from "./utils/file.js";

export interface ITDBotAPIOptions {
  /** Значение cookie `refresh_token` с итд.com. Нужен для долгой работы. */
  refreshToken?: string;
  /** Готовый access-токен (JWT, живёт ~15 минут). Можно передать вместе с refreshToken. */
  accessToken?: string;
  /** Путь к JSON-файлу сессии: туда сохраняется актуальный refresh-токен и deviceId. Рекомендуется. */
  sessionFile?: string;
  /** Своё хранилище сессии (вместо sessionFile). */
  sessionStore?: SessionStore;
  /** ID устройства (`X-Device-Id`). По умолчанию берётся из сессии или генерируется. */
  deviceId?: string;
  /** Базовый адрес. По умолчанию https://xn--d1ah4a.com */
  baseUrl?: string;
  userAgent?: string;
  /** Дополнительные заголовки для всех запросов. */
  headers?: Record<string, string>;
  /** Таймаут HTTP-запросов, мс. По умолчанию 30 000. */
  timeoutMs?: number;
  /** Своя реализация fetch (например, с прокси). */
  fetch?: typeof fetch;
  rateLimit?: Partial<RateLimitOptions>;
  realtime?: Partial<RealtimeOptions>;
  /** Префиксы команд для `command()`. По умолчанию `["/"]`. */
  commandPrefixes?: string[];
  /** Автоматически помечать входящие сообщения прочитанными. По умолчанию false. */
  autoMarkRead?: boolean;
  /** Показывать «отправляет фото/файл…» во время загрузки. По умолчанию true. */
  showUploadStatus?: boolean;
}

export interface SendTextOptions extends Omit<SendMessageOptions, "attachments"> {}

export interface SendFileOptions extends UploadOptions {
  /** Подпись к файлу. */
  caption?: string;
  /** Форматирование подписи. */
  entities?: MessageEntity[];
  /** Ответ на сообщение. */
  replyTo?: string | null;
  clientMessageId?: string;
}

export interface RouteOptions {
  /** Реагировать и на ваши собственные сообщения. По умолчанию false. */
  includeOwn?: boolean;
}

export type MessageHandler = (ctx: MessageContext) => unknown;
export type HearsPattern = string | RegExp | ((ctx: MessageContext) => boolean);

/** Карта событий клиента: имя → аргументы обработчика. */
export type ClientEvents = {
  ready: [me: MyProfile];
  message: [ctx: MessageContext];
  ownMessage: [ctx: MessageContext];
  messageEdited: [event: MessageEditedEvent];
  messageDeleted: [event: MessageDeletedEvent];
  messagesRead: [event: MessagesReadEvent];
  reactions: [event: ReactionsEvent];
  typing: [event: TypingEvent];
  presence: [event: PresenceEvent];
  chatCreated: [event: ChatCreatedEvent];
  chatDeleted: [event: ChatEvent];
  chatSettings: [event: ChatSettingsEvent];
  historyCleared: [event: ChatEvent];
  raw: [frame: MessengerFrame];
  connected: [];
  disconnected: [event: DisconnectedEvent];
  resync: [];
  tokenRefreshed: [event: TokenRefreshedEvent];
  error: [error: Error];
};

type Route =
  | { kind: "command"; names: Set<string>; handler: MessageHandler; includeOwn: boolean }
  | { kind: "hears"; pattern: HearsPattern; handler: MessageHandler; includeOwn: boolean };

const SEEN_LIMIT = 2000;

/**
 * Клиент личных сообщений итд.com.
 *
 * ```ts
 * const client = new ITDBotAPI({ refreshToken: process.env.ITD_REFRESH_TOKEN, sessionFile: ".itd-session.json" });
 * client.command("cat", (ctx) => ctx.replyWithPhoto("https://cataas.com/cat"));
 * await client.start();
 * ```
 */
export class ITDBotAPI extends TypedEmitter<ClientEvents> {
  readonly transport: TransportConfig;
  readonly auth: AuthManager;
  readonly http: HttpClient;
  /** Низкоуровневое REST API мессенджера. */
  readonly messenger: MessengerAPI;
  readonly users: UsersAPI;
  readonly media: MediaAPI;
  readonly realtime: RealtimeGateway;

  /** Ваш профиль (после `login()`/`start()`). */
  me: MyProfile | null = null;

  readonly #options: ITDBotAPIOptions;
  readonly #routes: Route[] = [];
  readonly #seen = new Set<string>();
  readonly #prefixes: string[];
  #lastSeq: number | null = null;
  #syncing = false;
  #syncAgain = false;
  #pending: MessengerFrame[] = [];
  #running = false;

  constructor(options: ITDBotAPIOptions = {}) {
    super();
    this.#options = options;
    this.#prefixes = options.commandPrefixes ?? ["/"];

    this.transport = {
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      deviceId: options.deviceId ?? randomUUID(),
      timeoutMs: options.timeoutMs ?? 30_000,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      headers: options.headers ?? {},
    };

    const sessionStore = options.sessionStore ?? (options.sessionFile ? new FileSessionStore(options.sessionFile) : undefined);
    this.auth = new AuthManager(this.transport, {
      refreshToken: options.refreshToken,
      accessToken: options.accessToken,
      sessionStore,
      onRefreshed: (event) => this.emit("tokenRefreshed", event),
    });

    this.http = new HttpClient(this.transport, this.auth, {
      autoRetry: options.rateLimit?.autoRetry ?? true,
      maxWaitMs: options.rateLimit?.maxWaitMs ?? 15_000,
      maxRetries: options.rateLimit?.maxRetries ?? 3,
    });
    this.messenger = new MessengerAPI(this.http);
    this.users = new UsersAPI(this.http);
    this.media = new MediaAPI(this.http);

    this.realtime = new RealtimeGateway(this.transport, this.auth, {
      pingIntervalMs: options.realtime?.pingIntervalMs ?? 10_000,
      heartbeatTimeoutMs: options.realtime?.heartbeatTimeoutMs ?? 30_000,
      connectTimeoutMs: options.realtime?.connectTimeoutMs ?? 10_000,
      reconnectMinDelayMs: options.realtime?.reconnectMinDelayMs ?? 2_000,
      reconnectMaxDelayMs: options.realtime?.reconnectMaxDelayMs ?? 30_000,
    });
    this.realtime.on("open", () => {
      this.emit("connected");
      void this.syncMissed();
    });
    this.realtime.on("close", (code, reason, willReconnect) => this.emit("disconnected", { code, reason, willReconnect }));
    this.realtime.on("frame", (frame) => this.#onFrame(frame));
    this.realtime.on("error", (error) => this.#emitError(error));
  }

  /** Ваш ID пользователя. */
  get userId(): string | null {
    return this.me?.id ?? this.auth.userId;
  }

  /** Подключён ли WebSocket. */
  get isConnected(): boolean {
    return this.realtime.isConnected;
  }

  /** Номер последнего обработанного события. */
  get lastEventSeq(): number | null {
    return this.#lastSeq;
  }

  /* ───────────────────────── Жизненный цикл ───────────────────────── */

  /** Авторизоваться и загрузить профиль (без WebSocket). Подходит для скриптов. */
  async login(): Promise<MyProfile> {
    const storedDeviceId = await this.auth.load();
    if (!this.#options.deviceId && storedDeviceId) this.transport.deviceId = storedDeviceId;
    await this.auth.getAccessToken();
    this.me = await this.users.getMe();
    return this.me;
  }

  /**
   * Авторизоваться, подключиться к WebSocket и начать получать события.
   * `resumeFromSeq` — номер события (`client.lastEventSeq`), сохранённый перед остановкой:
   * тогда сообщения, пришедшие пока бот был выключен, тоже будут обработаны.
   */
  async start(options: { resumeFromSeq?: number } = {}): Promise<MyProfile> {
    if (this.#running && this.me) return this.me;
    const me = await this.login();
    this.#running = true;

    if (typeof options.resumeFromSeq === "number") {
      this.#lastSeq = options.resumeFromSeq;
    } else {
      const unread = await this.messenger.getUnread();
      this.#lastSeq =
        typeof unread.event_seq === "number" ? unread.event_seq : ((await this.messenger.getChats({ limit: 1 })).event_seq ?? 0);
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (error instanceof ITDAuthError) {
          cleanup();
          this.realtime.disconnect();
          this.#running = false;
          reject(error);
        }
      };
      const cleanup = () => {
        this.realtime.off("open", onOpen);
        this.realtime.off("error", onError);
      };
      this.realtime.on("open", onOpen);
      this.realtime.on("error", onError);
      this.realtime.connect();
    });

    this.emit("ready", me);
    return me;
  }

  /** Отключиться от WebSocket. */
  stop(): void {
    this.#running = false;
    this.realtime.disconnect();
  }

  /**
   * Задать номер события, с которого продолжать обработку (обычно не нужно — это делает `start()`).
   * Пригодится, чтобы обрабатывать события вручную через `syncMissed()` без WebSocket.
   */
  setEventSeq(seq: number): void {
    this.#lastSeq = seq;
  }

  /* ───────────────────────── Команды ───────────────────────── */

  /**
   * Обработчик команды: `client.command("cat", ...)` сработает на `/cat`, `/cat 3`, `/CAT`.
   * Можно передать несколько имён: `client.command(["cat", "кот"], ...)`.
   */
  command(names: string | string[], handler: MessageHandler, options: RouteOptions = {}): this {
    const list = (Array.isArray(names) ? names : [names]).map((n) => this.#stripPrefix(n).toLocaleLowerCase("ru-RU"));
    this.#routes.push({ kind: "command", names: new Set(list), handler, includeOwn: options.includeOwn ?? false });
    return this;
  }

  /**
   * Обработчик текста: строка — точное совпадение без учёта регистра и пробелов по краям,
   * RegExp — совпадение по регулярке (результат в `ctx.match`), функция — свой фильтр.
   */
  hears(pattern: HearsPattern, handler: MessageHandler, options: RouteOptions = {}): this {
    this.#routes.push({ kind: "hears", pattern, handler, includeOwn: options.includeOwn ?? false });
    return this;
  }

  /* ───────────────────────── Отправка ───────────────────────── */

  /** Отправить текст в чат. */
  sendMessage(chatId: string, text: string, options: SendTextOptions = {}): Promise<SentMessage> {
    return this.messenger.sendMessage(chatId, text, options);
  }

  /** Отправить файл (любой) в чат. `source` — путь, URL, Buffer, Blob. */
  async sendFile(chatId: string, source: FileSource, options: SendFileOptions = {}): Promise<SentMessage> {
    return this.sendFiles(chatId, [source], options);
  }

  /** Отправить картинку в чат. */
  sendPhoto(chatId: string, source: FileSource, options: SendFileOptions = {}): Promise<SentMessage> {
    return this.sendFiles(chatId, [source], options);
  }

  /** Отправить несколько файлов одним сообщением. */
  async sendFiles(chatId: string, sources: FileSource[], options: SendFileOptions = {}): Promise<SentMessage> {
    const fileIds = await this.uploadFiles(chatId, sources, options);
    return this.messenger.sendMessage(chatId, options.caption ?? "", {
      attachments: fileIds,
      ...(options.entities ? { entities: options.entities } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Отправить текст пользователю по `@username` или ID (чат создастся сам). */
  async sendMessageToUser(user: string, text: string, options: Omit<SendTextOptions, "replyTo"> = {}): Promise<SentMessage> {
    const userId = await this.users.resolveId(user);
    return this.messenger.sendMessageToUser(userId, text, options);
  }

  /** Отправить картинку/файл пользователю по `@username` или ID. */
  async sendPhotoToUser(user: string, source: FileSource, options: Omit<SendFileOptions, "replyTo"> = {}): Promise<SentMessage> {
    const userId = await this.users.resolveId(user);
    const fileIds = await this.uploadFiles(null, [source], options);
    return this.messenger.sendMessageToUser(userId, options.caption ?? "", {
      attachments: fileIds,
      ...(options.entities ? { entities: options.entities } : {}),
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
    });
  }

  /** ID личного чата с пользователем (`@username` или ID); создаёт чат, если его нет. */
  async getDirectChatId(user: string): Promise<string> {
    const userId = await this.users.resolveId(user);
    return (await this.messenger.createDirectChat(userId)).chat_id;
  }

  /** Загрузить файлы и вернуть их fileId (показывая статус «отправляет…», если указан chatId). */
  async uploadFiles(chatId: string | null, sources: FileSource[], options: UploadOptions = {}): Promise<string[]> {
    const showStatus = chatId !== null && (this.#options.showUploadStatus ?? true);
    const ids: string[] = [];
    for (const source of sources) {
      let statusTimer: NodeJS.Timeout | undefined;
      try {
        const file = await resolveFile(
          source,
          { filename: sources.length > 1 ? undefined : options.filename, mime: options.mime },
          this.transport.fetch,
        );
        if (showStatus) {
          const action = actionForMime(file.mime);
          const ping = () => this.messenger.sendChatAction(chatId, action).catch(() => undefined);
          void ping();
          statusTimer = setInterval(ping, 4000);
        }
        const uploaded = await this.media.upload(file, options);
        ids.push(uploaded.fileId);
      } finally {
        if (statusTimer) clearInterval(statusTimer);
      }
    }
    return ids;
  }

  /**
   * Установить ваши реакции на сообщение (полностью заменяет ваш набор). Пустой массив — убрать все.
   * Строка трактуется как эмодзи: `client.react(chatId, msgId, "👍")`.
   */
  async react(
    chatId: string,
    messageId: string,
    reactions: string | Reaction | Array<string | Reaction>,
    options: { expectedVersion?: string | undefined } = {},
  ): Promise<MessageReactions> {
    const list = (Array.isArray(reactions) ? reactions : [reactions]).map((r): Reaction =>
      typeof r === "string" ? { type: ReactionType.Emoji, emoji: r } : r,
    );
    let version = options.expectedVersion;
    for (let attempt = 0; ; attempt++) {
      version ??= await this.#reactionVersion(chatId, messageId);
      try {
        return await this.messenger.setReactions(chatId, messageId, list, version);
      } catch (error) {
        if (error instanceof ITDApiError && error.status === 409 && attempt < 3) {
          version = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  /** Скачать вложение. Для старых ссылок передайте chatId — ссылка будет обновлена через file-links. */
  async downloadAttachment(attachment: Attachment | string, chatId?: string): Promise<Buffer> {
    const fileId = typeof attachment === "string" ? null : attachment.fileId;
    let url = typeof attachment === "string" ? attachment : attachment.url;
    const errors: unknown[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const sameOrigin = new URL(url, this.transport.baseUrl).origin === new URL(this.transport.baseUrl).origin;
      try {
        const headers: Record<string, string> = { Accept: "*/*" };
        if (attempt === 1 && sameOrigin) {
          // Сайт отдаёт файлы чатов по cookie-сессии, которую выдаёт browser-file-session.
          const res = await this.http.raw("POST", API_PATHS.messenger + "/browser-file-session", { idempotent: true });
          const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";", 1)[0]).join("; ");
          if (cookie) headers.Cookie = cookie;
        }
        const res = await this.http.raw("GET", url, { auth: sameOrigin, headers, timeoutMs: 120_000 });
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        errors.push(error);
        if (attempt === 1 && chatId && fileId) {
          const { links } = await this.messenger.getFileLinks(chatId, [fileId]);
          const fresh = links.find((l) => l.fileId === fileId);
          if (fresh) url = fresh.url;
        }
      }
    }
    throw new AggregateError(errors, `Не удалось скачать вложение ${fileId ?? url}`);
  }

  /** Докачать события, пропущенные пока WebSocket был отключён. Вызывается автоматически. */
  async syncMissed(): Promise<void> {
    if (this.#lastSeq === null) return;
    if (this.#syncing) {
      this.#syncAgain = true;
      return;
    }
    this.#syncing = true;
    try {
      do {
        this.#syncAgain = false;
        for (let page = 0; page < 100; page++) {
          const since = this.#lastSeq ?? 0;
          const res = await this.messenger.getUpdates(since);
          if (res.reset_required) {
            const unread = await this.messenger.getUnread();
            this.#lastSeq = unread.event_seq ?? res.next_event_seq;
            this.emit("resync");
            break;
          }
          for (const event of res.events) {
            const seq = event.event_seq;
            if (typeof seq === "number" && this.#lastSeq !== null && seq <= this.#lastSeq) continue;
            this.#dispatch(event);
            if (typeof seq === "number") this.#lastSeq = Math.max(this.#lastSeq ?? 0, seq);
          }
          this.#lastSeq = Math.max(this.#lastSeq ?? 0, res.next_event_seq);
          if (res.events.length === 0 || res.next_event_seq <= since) break;
        }
      } while (this.#syncAgain);
    } catch (error) {
      this.#emitError(error as Error);
    } finally {
      this.#syncing = false;
      const pending = this.#pending.splice(0).sort((a, b) => (a.event_seq ?? 0) - (b.event_seq ?? 0));
      for (const frame of pending) this.#applySequenced(frame, true);
    }
  }

  /* ───────────────────────── Внутреннее ───────────────────────── */

  protected override onListenerError(error: unknown, event: keyof ClientEvents): void {
    if (event === "error") {
      console.error("[itdbotapi] Ошибка в обработчике события error:", error);
      return;
    }
    this.#emitError(error instanceof Error ? error : new Error(String(error)));
  }

  #emitError(error: Error): void {
    if (!this.emit("error", error)) console.warn(`[itdbotapi] ${error.message}`);
  }

  #stripPrefix(name: string): string {
    for (const prefix of this.#prefixes) if (prefix && name.startsWith(prefix)) return name.slice(prefix.length);
    return name;
  }

  async #reactionVersion(chatId: string, messageId: string): Promise<string> {
    try {
      const res = await this.messenger.getReactions(chatId, messageId);
      if (typeof res.reaction_version === "string") return res.reaction_version;
    } catch {
      /* попробуем через историю */
    }
    const around = await this.messenger.getMessagesAround(chatId, messageId, 1);
    return around.messages.find((m) => m.message_id === messageId)?.reaction_version ?? "0";
  }

  #onFrame(frame: MessengerFrame): void {
    this.emit("raw", frame);
    if (typeof frame.event_seq !== "number") {
      this.#dispatch(frame);
      return;
    }
    if (this.#syncing || this.#lastSeq === null) {
      this.#pending.push(frame);
      return;
    }
    this.#applySequenced(frame, false);
  }

  /** Применяет кадр с номером события, проверяя, что ничего не пропущено. */
  #applySequenced(frame: MessengerFrame, afterSync: boolean): void {
    const seq = frame.event_seq as number;
    const last = this.#lastSeq ?? 0;
    if (seq <= last) return;
    const count = frame.event_seq_count ?? 1;
    if (last + count !== seq && !afterSync) {
      // Дыра в номерах — докачиваем пропущенное через /updates, кадр применится после.
      this.#pending.push(frame);
      void this.syncMissed();
      return;
    }
    this.#lastSeq = seq;
    this.#dispatch(frame);
  }

  #dispatch(frame: MessengerFrame): void {
    const f = frame as KnownMessengerFrame;
    switch (f.type) {
      case MessengerEventType.NewMessage:
        this.#handleMessage(f.chat_id, f.message);
        break;
      case MessengerEventType.NewMessages:
      case MessengerEventType.OwnMessages:
        for (const message of f.messages) this.#handleMessage(f.chat_id, message);
        break;
      case MessengerEventType.ChatCreated:
        this.emit("chatCreated", { chatId: f.chat_id, ...(f.chat ? { chat: f.chat } : {}) });
        for (const message of f.messages ?? []) this.#handleMessage(f.chat_id, message);
        break;
      case MessengerEventType.MessageEdited:
        this.emit("messageEdited", { chatId: f.chat_id, messageId: f.message_id, message: f.message });
        break;
      case MessengerEventType.MessageDeleted:
        this.emit("messageDeleted", { chatId: f.chat_id, messageIds: [f.message_id], newLastMessage: f.new_last_message ?? null });
        break;
      case MessengerEventType.MessagesDeleted:
        this.emit("messageDeleted", { chatId: f.chat_id, messageIds: f.message_ids, newLastMessage: f.new_last_message ?? null });
        break;
      case MessengerEventType.MessagesRead:
        this.emit("messagesRead", {
          chatId: f.chat_id,
          userId: f.user_id,
          lastReadMessageId: f.last_read_message,
          isOwn: f.user_id === this.userId,
        });
        break;
      case MessengerEventType.MessageReactions:
        this.emit("reactions", {
          chatId: f.chat_id,
          messageId: f.message_id,
          reactions: f.reactions ?? [],
          reactionVersion: f.reaction_version ?? null,
        });
        break;
      case MessengerEventType.Typing:
        this.emit("typing", {
          chatId: f.chat_id,
          userId: f.user_id,
          action: f.action ?? ChatAction.Typing,
          ...(typeof f.progress === "number" ? { progress: f.progress } : {}),
        });
        break;
      case MessengerEventType.Presence:
        this.emit("presence", { userId: f.user_id, online: f.online });
        break;
      case MessengerEventType.ChatDeleted:
        this.emit("chatDeleted", { chatId: f.chat_id });
        break;
      case MessengerEventType.HistoryCleared:
        this.emit("historyCleared", { chatId: f.chat_id });
        break;
      case MessengerEventType.ChatSettings:
        this.emit("chatSettings", {
          chatId: f.chat_id,
          ...(typeof f.is_pinned === "boolean" ? { isPinned: f.is_pinned } : {}),
          ...(typeof f.is_muted === "boolean" ? { isMuted: f.is_muted } : {}),
          ...(typeof f.marked_unread === "boolean" ? { markedUnread: f.marked_unread } : {}),
          ...(typeof f.is_request === "boolean" ? { isRequest: f.is_request } : {}),
        });
        break;
      default:
        break;
    }
  }

  #handleMessage(chatId: string, message: Message): void {
    if (!message?.message_id || message.is_deleted) return;
    if (this.#seen.has(message.message_id)) return;
    this.#seen.add(message.message_id);
    if (this.#seen.size > SEEN_LIMIT) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }

    const ctx = new MessageContext(this, chatId, message);
    if (ctx.isOwn) {
      this.emit("ownMessage", ctx);
    } else {
      this.emit("message", ctx);
      if (this.#options.autoMarkRead) void ctx.markRead().catch((error: Error) => this.#emitError(error));
    }
    void this.#route(ctx);
  }

  async #route(ctx: MessageContext): Promise<void> {
    if (!ctx.text) return;
    const command = parseCommand(ctx.text, this.#prefixes);
    for (const route of this.#routes) {
      if (ctx.isOwn && !route.includeOwn) continue;
      let matched = false;
      if (route.kind === "command") {
        if (command && route.names.has(command.name)) {
          ctx.command = command;
          matched = true;
        }
      } else if (typeof route.pattern === "string") {
        matched = ctx.text.trim().toLocaleLowerCase("ru-RU") === route.pattern.trim().toLocaleLowerCase("ru-RU");
      } else if (route.pattern instanceof RegExp) {
        route.pattern.lastIndex = 0;
        ctx.match = route.pattern.exec(ctx.text);
        matched = ctx.match !== null;
      } else {
        try {
          matched = route.pattern(ctx);
        } catch (error) {
          this.#emitError(error as Error);
        }
      }
      if (!matched) continue;
      try {
        await route.handler(ctx);
      } catch (error) {
        this.#emitError(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
  }
}

/** Синоним для тех, кому привычнее `Client`. */
export { ITDBotAPI as ITDClient };

function actionForMime(mime: string): ChatAction {
  if (mime.startsWith("image/")) return ChatAction.UploadPhoto;
  if (mime.startsWith("video/")) return ChatAction.UploadVideo;
  if (mime.startsWith("audio/")) return ChatAction.UploadVoice;
  return ChatAction.UploadDocument;
}

// Гарантия, что enum ClientEvent и карта ClientEvents не разъедутся.
type _CheckEvents = Record<`${ClientEvent}`, unknown> extends Record<keyof ClientEvents, unknown>
  ? Record<keyof ClientEvents, unknown> extends Record<`${ClientEvent}`, unknown>
    ? true
    : never
  : never;
const _eventsInSync: _CheckEvents = true;
void _eventsInSync;

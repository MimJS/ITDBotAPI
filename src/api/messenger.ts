import { API_PATHS, UPDATES_CAPABILITIES } from "../constants.js";
import type { ChatAction, MediaCategory } from "../enums.js";
import type { HttpClient } from "../http.js";
import type {
  ChatList,
  ChatMediaPage,
  ChatSummary,
  FileLink,
  ForwardResult,
  MessageEntity,
  MessageList,
  MessageReactions,
  Reaction,
  ReactionCatalog,
  SentMessage,
  UnreadCounters,
  UpdatesResponse,
} from "../types.js";
import { uuidv7 } from "../utils/common.js";

export interface PageOptions {
  /** Сколько элементов вернуть. */
  limit?: number;
  /** Курсор: ID сообщения/чата, раньше которого брать. */
  before?: string;
}

export interface SendMessageOptions {
  /** Ответ на сообщение (ID). */
  replyTo?: string | null;
  /** ID файлов, загруженных через `media.upload()`. */
  attachments?: string[];
  /** Форматирование текста. */
  entities?: MessageEntity[];
  /** Ключ идемпотентности: повторная отправка с тем же ID не создаст дубль. По умолчанию — новый UUIDv7. */
  clientMessageId?: string;
  signal?: AbortSignal;
}

export interface EditMessageOptions {
  attachments?: string[];
  entities?: MessageEntity[];
}

const enc = encodeURIComponent;

/**
 * Низкоуровневое REST API мессенджера (`/api/v1/messenger`).
 * Возвращает ответы сервера как есть (snake_case).
 */
export class MessengerAPI {
  constructor(private readonly http: HttpClient) {}

  #path(path: string): string {
    return API_PATHS.messenger + path;
  }

  /* ───────────── Чаты ───────────── */

  /** Список чатов (новые сверху). */
  getChats(options: PageOptions = {}): Promise<ChatList> {
    return this.http.get(this.#path("/chats"), {
      query: { limit: options.limit, before: options.before, manual_unread: 1 },
    });
  }

  /** Перебирает все чаты постранично. */
  async *iterateChats(pageSize = 100): AsyncGenerator<ChatSummary> {
    let before: string | undefined;
    for (;;) {
      const page = await this.getChats({ limit: pageSize, ...(before ? { before } : {}) });
      yield* page.chats;
      if (!page.next_before || page.chats.length === 0) return;
      before = page.next_before;
    }
  }

  getChat(chatId: string): Promise<ChatSummary> {
    return this.http.get(this.#path(`/chats/${enc(chatId)}`), { query: { manual_unread: 1 } });
  }

  /** Счётчики непрочитанного. */
  getUnread(): Promise<UnreadCounters> {
    return this.http.get(this.#path("/chats/unread"), { query: { manual_unread: 1 } });
  }

  /** Создаёт (или возвращает существующий) личный чат с пользователем. */
  createDirectChat(userId: string): Promise<{ chat_id: string; [key: string]: unknown }> {
    return this.http.post(this.#path("/chats/dm"), { target_user_id: userId });
  }

  /** Принять входящий запрос на переписку. */
  acceptRequest(chatId: string): Promise<unknown> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/accept`));
  }

  setPinned(chatId: string, isPinned: boolean): Promise<void> {
    return this.http.patch(this.#path(`/chats/${enc(chatId)}/pin`), { is_pinned: isPinned });
  }

  setMuted(chatId: string, isMuted: boolean): Promise<void> {
    return this.http.patch(this.#path(`/chats/${enc(chatId)}/mute`), { is_muted: isMuted });
  }

  /** Пометить чат непрочитанным (или снять пометку). */
  markUnread(chatId: string, unread = true): Promise<unknown> {
    return this.http.patch(this.#path(`/chats/${enc(chatId)}/unread`), { unread });
  }

  /** Прочитать сообщения до `lastMessageId` включительно. */
  markRead(chatId: string, lastMessageId: string): Promise<unknown> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/read`), { last_read_message: lastMessageId }, { idempotent: true });
  }

  /** Очистить историю (у себя или у всех). */
  clearHistory(chatId: string, forEveryone = false): Promise<unknown> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/${forEveryone ? "clear-history-all" : "clear-history"}`));
  }

  /** Удалить чат (у себя или у всех). */
  deleteChat(chatId: string, forEveryone = false): Promise<unknown> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/delete`), { for_everyone: forEveryone });
  }

  /** Показать статус «печатает…», «отправляет фото…» и т.п. Держится ~5 секунд. */
  sendChatAction(chatId: string, action: ChatAction | `${ChatAction}` = "typing", progress?: number): Promise<void> {
    const body: { type: string; progress?: number } = { type: action };
    if (progress !== undefined && action.startsWith("upload_")) body.progress = Math.min(1, Math.max(0, progress));
    return this.http.post(this.#path(`/chats/${enc(chatId)}/action`), body, { idempotent: true });
  }

  /* ───────────── Сообщения ───────────── */

  /** История сообщений (новые сверху; для более старых передайте `before`). */
  getMessages(chatId: string, options: PageOptions = {}): Promise<MessageList> {
    return this.http.get(this.#path(`/chats/${enc(chatId)}/messages`), {
      query: { limit: options.limit, before: options.before },
    });
  }

  /** Сообщения вокруг указанного. */
  getMessagesAround(chatId: string, messageId: string, limit = 40): Promise<MessageList> {
    return this.http.get(this.#path(`/chats/${enc(chatId)}/messages/around/${enc(messageId)}`), { query: { limit } });
  }

  /** Отправить сообщение в чат. Нужен текст и/или вложения. */
  sendMessage(chatId: string, text: string, options: SendMessageOptions = {}): Promise<SentMessage> {
    return this.http.post(
      this.#path(`/chats/${enc(chatId)}/messages`),
      {
        client_message_id: options.clientMessageId ?? uuidv7(),
        text,
        reply_to_id: options.replyTo ?? null,
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options.entities?.length ? { entities: options.entities } : {}),
      },
      // client_message_id делает отправку идемпотентной — повтор после сбоя сети не создаст дубль.
      { idempotent: true, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  /** Отправить сообщение пользователю по его ID (чат создастся сам). Ответ на сообщение здесь не поддерживается. */
  sendMessageToUser(userId: string, text: string, options: Omit<SendMessageOptions, "replyTo"> = {}): Promise<SentMessage> {
    return this.http.post(
      this.#path(`/users/${enc(userId)}/messages`),
      {
        client_message_id: options.clientMessageId ?? uuidv7(),
        text,
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options.entities?.length ? { entities: options.entities } : {}),
      },
      { idempotent: true, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  editMessage(chatId: string, messageId: string, text: string, options: EditMessageOptions = {}): Promise<unknown> {
    return this.http.patch(this.#path(`/chats/${enc(chatId)}/messages/${enc(messageId)}`), {
      text,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.entities ? { entities: options.entities } : {}),
    });
  }

  /** Удалить сообщения у себя или у всех. */
  deleteMessages(chatId: string, messageIds: string[], options: { forEveryone?: boolean } = {}): Promise<unknown> {
    return this.http.post(
      this.#path(`/chats/${enc(chatId)}/messages/${options.forEveryone ? "delete-for-all" : "delete-for-me"}`),
      { message_ids: messageIds },
      { idempotent: true },
    );
  }

  /** Переслать сообщения из `sourceChatId` в `targetChatId`. */
  forwardMessages(targetChatId: string, sourceChatId: string, messageIds: string[]): Promise<ForwardResult> {
    return this.http.post(
      this.#path(`/chats/${enc(targetChatId)}/messages/forward`),
      {
        client_message_ids: Object.fromEntries(messageIds.map((id) => [id, uuidv7()])),
        source_chat_id: sourceChatId,
        message_ids: messageIds,
      },
      { idempotent: true },
    );
  }

  /** Отметить голосовое как прослушанное. */
  markVoiceHeard(chatId: string, messageId: string): Promise<unknown> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/messages/${enc(messageId)}/heard`), undefined, { idempotent: true });
  }

  /* ───────────── Реакции ───────────── */

  /** Доступные реакции и лимит на пользователя (`user_max`). */
  getReactionCatalog(): Promise<ReactionCatalog> {
    return this.http.get(this.#path("/reactions/available"));
  }

  getReactions(chatId: string, messageId: string): Promise<MessageReactions> {
    return this.http.get(this.#path(`/chats/${enc(chatId)}/messages/${enc(messageId)}/reactions`));
  }

  /**
   * Установить ВАШ набор реакций на сообщение (полностью заменяет предыдущий).
   * `expectedVersion` — `reaction_version` сообщения; при несовпадении сервер ответит 409.
   */
  setReactions(chatId: string, messageId: string, reactions: Reaction[], expectedVersion: string): Promise<MessageReactions> {
    return this.http.put(this.#path(`/chats/${enc(chatId)}/messages/${enc(messageId)}/reactions`), {
      reactions,
      expected_version: expectedVersion,
      operation_id: crypto.randomUUID(),
    });
  }

  /* ───────────── Медиа и файлы ───────────── */

  getChatMedia(chatId: string, category: MediaCategory, options: PageOptions = {}): Promise<ChatMediaPage> {
    return this.http.get(this.#path(`/chats/${enc(chatId)}/media`), {
      query: { category, before: options.before, limit: options.limit },
    });
  }

  /** Получить свежие ссылки на файлы чата (по 100 за раз). */
  getFileLinks(chatId: string, fileIds: string[]): Promise<{ links: FileLink[] }> {
    return this.http.post(this.#path(`/chats/${enc(chatId)}/file-links`), { file_ids: fileIds }, { idempotent: true });
  }

  /* ───────────── Присутствие ───────────── */

  getPresence(userId: string): Promise<unknown> {
    return this.http.get(this.#path(`/presence/${enc(userId)}`));
  }

  /** Онлайн-статусы: `{ [userId]: boolean }`. */
  async getPresenceMany(userIds: string[]): Promise<Record<string, boolean>> {
    const res = await this.http.post<{ presence: Record<string, boolean> }>(this.#path("/presence"), { user_ids: userIds }, { idempotent: true });
    return res.presence;
  }

  /* ───────────── Синхронизация ───────────── */

  /** События после `since` (номер `event_seq`). Используется для докачки пропущенного. */
  getUpdates(since: number, limit?: number): Promise<UpdatesResponse> {
    return this.http.get(this.#path("/updates"), {
      query: { since, capabilities: UPDATES_CAPABILITIES, manual_unread: 1, limit },
    });
  }
}

import type { ChatAction, EntityType, MessengerEventType, ReactionType } from "./enums.js";

/* ───────────────────────────── Пользователи ───────────────────────────── */

export interface UserPin {
  slug: string;
  name: string;
  description?: string | null;
  url?: string | null;
}

/** Профиль из `GET /api/users/me`. */
export interface MyProfile {
  id: string;
  username: string | null;
  displayName: string;
  avatar: string | null;
  banner: string | null;
  bio: string | null;
  verified: boolean;
  isPrivate?: boolean;
  createdAt: string;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  pin?: UserPin | null;
  [key: string]: unknown;
}

/** Профиль из `GET /api/users/:username`. */
export interface UserProfile {
  id: string;
  username: string | null;
  displayName: string;
  avatar: string | null;
  banner?: string | null;
  bio?: string | null;
  verified?: boolean;
  createdAt?: string;
  isFollowing?: boolean;
  isFollowedBy?: boolean;
  /** Можно ли написать пользователю в ЛС. */
  canMessage?: boolean;
  online?: boolean;
  lastSeen?: unknown;
  [key: string]: unknown;
}

/* ───────────────────────────── Сообщения ───────────────────────────── */

export interface Attachment {
  fileId: string;
  url: string;
  filename?: string | null;
  mime?: string | null;
  thumbUrl?: string | null;
  thumbhash?: string | null;
  waveform?: string | null;
  sizePlain?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  expiresIn?: number | null;
  thumbWidth?: number | null;
  thumbHeight?: number | null;
}

/** Форматирование куска текста. `offset`/`length` считаются в UTF-16 (как `String#length`). */
export type MessageEntity =
  | {
      type:
        | EntityType.Bold
        | EntityType.Italic
        | EntityType.Underline
        | EntityType.Strike
        | EntityType.Code
        | EntityType.Spoiler
        | `${EntityType.Bold | EntityType.Italic | EntityType.Underline | EntityType.Strike | EntityType.Code | EntityType.Spoiler}`;
      offset: number;
      length: number;
    }
  | { type: EntityType.TextLink | `${EntityType.TextLink}`; offset: number; length: number; url: string }
  | { type: EntityType.Post | `${EntityType.Post}`; post_id: string; offset?: number; length?: number }
  | { type: EntityType.Sticker | `${EntityType.Sticker}`; sticker_id: string };

export type Reaction =
  | { type: ReactionType.Emoji | `${ReactionType.Emoji}`; emoji: string }
  | { type: ReactionType.Custom | `${ReactionType.Custom}`; file_id: string };

export interface ReactionCount {
  reaction: Reaction;
  count: number;
  /** Поставили ли эту реакцию вы. */
  chosen?: boolean;
}

export interface ReplyPreview {
  message_id: string;
  sender_id: string;
  text?: string | null;
  sender_name?: string | null;
}

/** Сообщение в чате. */
export interface Message {
  message_id: string;
  sender_id: string;
  /** ISO-дата. */
  created_at: string;
  edited_at?: string | null;
  text: string | null;
  attachments?: Attachment[];
  entities?: MessageEntity[] | null;
  reactions?: ReactionCount[];
  reaction_version?: string | null;
  reply_to?: ReplyPreview | null;
  is_deleted?: boolean;
  unavailable?: boolean;
  forwarded_from_chat?: string | null;
  forwarded_from_msg?: string | null;
  forwarded_from_sender_id?: string | null;
  forwarded_from_name?: string | null;
}

/** Ответ сервера на отправку сообщения. */
export interface SentMessage extends Partial<Message> {
  message_id: string;
  chat_id?: string;
  event_seq?: number;
  event_seq_count?: number;
  /** true, если сервер уже видел этот `client_message_id` и не создал дубль. */
  replayed?: boolean;
  [key: string]: unknown;
}

/* ───────────────────────────── Чаты ───────────────────────────── */

export interface LastMessagePreview {
  id: string;
  text: string | null;
  sender_id: string | null;
  at: string | null;
  attachment_kind: string | null;
  attachment_filename: string | null;
  attachment_count: number | null;
}

/** Краткая информация о чате из списка чатов. */
export interface ChatSummary {
  chat_id: string;
  chat_type: number;
  title: string | null;
  avatar: string | null;
  other_user_id: string | null;
  other_user_deleted?: boolean;
  other_read_message_id: string | null;
  my_read_message_id?: string | null;
  unread_count: number;
  marked_unread?: boolean;
  /** Входящий запрос на переписку (от человека, с которым вы ещё не общались). */
  is_request?: boolean;
  is_pinned?: boolean;
  is_muted?: boolean;
  last_message: LastMessagePreview | null;
}

export interface ChatList {
  chats: ChatSummary[];
  /** Курсор для следующей страницы (`before`). */
  next_before: string | null;
  event_seq?: number;
}

export interface ReadCursor {
  message_id: string;
  timestamp?: string | null;
}

export interface MessageList {
  messages: Message[];
  read_cursors: Record<string, ReadCursor>;
  my_last_read: ReadCursor | null;
  has_older?: boolean;
  has_newer?: boolean;
  event_seq?: number;
}

export interface UnreadCounters {
  total: number;
  chats_with_unread: number;
  event_seq?: number;
}

export interface ReactionCatalogItem {
  type: string;
  emoji?: string;
  file_id?: string;
  title?: string;
}

export interface ReactionCatalog {
  hash: string;
  /** Сколько реакций один пользователь может поставить на сообщение. */
  user_max: number;
  reactions: ReactionCatalogItem[];
}

export interface MessageReactions {
  reactions: ReactionCount[];
  reaction_version?: string | null;
  [key: string]: unknown;
}

export interface FileLink {
  fileId: string;
  url: string;
  thumbUrl?: string | null;
  expiresIn?: number;
}

export interface ChatMediaItem {
  message_id: string;
  file: Attachment;
  [key: string]: unknown;
}

export interface ChatMediaPage {
  items: ChatMediaItem[];
  next_before?: string | null;
  [key: string]: unknown;
}

export interface ForwardResult {
  ok: Array<{ source_message_id: string; message_id?: string; [key: string]: unknown }>;
  failed: Array<{ source_message_id: string; [key: string]: unknown }>;
}

/* ───────────────────────────── Загрузка файлов ───────────────────────────── */

export interface UploadedFile {
  fileId: string;
  [key: string]: unknown;
}

/* ───────────────────────────── События ───────────────────────────── */

interface FrameBase {
  /** Номер последнего события, которое покрывает этот кадр. */
  event_seq?: number;
  /** Сколько номеров событий покрывает кадр (по умолчанию 1). */
  event_seq_count?: number;
}

export interface NewMessageFrame extends FrameBase {
  type: MessengerEventType.NewMessage | `${MessengerEventType.NewMessage}`;
  chat_id: string;
  message: Message;
}

export interface NewMessagesFrame extends FrameBase {
  type:
    | MessengerEventType.NewMessages
    | MessengerEventType.OwnMessages
    | `${MessengerEventType.NewMessages}`
    | `${MessengerEventType.OwnMessages}`;
  chat_id: string;
  messages: Message[];
}

export interface MessageEditedFrame extends FrameBase {
  type: MessengerEventType.MessageEdited | `${MessengerEventType.MessageEdited}`;
  chat_id: string;
  message_id: string;
  message: Message;
}

export interface MessageDeletedFrame extends FrameBase {
  type: MessengerEventType.MessageDeleted | `${MessengerEventType.MessageDeleted}`;
  chat_id: string;
  message_id: string;
  new_last_message?: LastMessagePreview | null;
}

export interface MessagesDeletedFrame extends FrameBase {
  type: MessengerEventType.MessagesDeleted | `${MessengerEventType.MessagesDeleted}`;
  chat_id: string;
  message_ids: string[];
  new_last_message?: LastMessagePreview | null;
}

export interface MessagesReadFrame extends FrameBase {
  type: MessengerEventType.MessagesRead | `${MessengerEventType.MessagesRead}`;
  chat_id: string;
  user_id: string;
  last_read_message: string;
}

export interface MessageReactionsFrame extends FrameBase {
  type: MessengerEventType.MessageReactions | `${MessengerEventType.MessageReactions}`;
  chat_id: string;
  message_id: string;
  reactions: ReactionCount[];
  reaction_version?: string | null;
}

export interface TypingFrame extends FrameBase {
  type: MessengerEventType.Typing | `${MessengerEventType.Typing}`;
  chat_id: string;
  user_id: string;
  action?: ChatAction | `${ChatAction}`;
  progress?: number;
}

export interface PresenceFrame extends FrameBase {
  type: MessengerEventType.Presence | `${MessengerEventType.Presence}`;
  user_id: string;
  online: boolean;
}

export interface ChatCreatedFrame extends FrameBase {
  type: MessengerEventType.ChatCreated | `${MessengerEventType.ChatCreated}`;
  chat_id: string;
  messages?: Message[];
  chat?: ChatSummary;
}

export interface ChatDeletedFrame extends FrameBase {
  type: MessengerEventType.ChatDeleted | `${MessengerEventType.ChatDeleted}`;
  chat_id: string;
}

export interface HistoryClearedFrame extends FrameBase {
  type: MessengerEventType.HistoryCleared | `${MessengerEventType.HistoryCleared}`;
  chat_id: string;
}

export interface ChatSettingsFrame extends FrameBase {
  type: MessengerEventType.ChatSettings | `${MessengerEventType.ChatSettings}`;
  chat_id: string;
  is_pinned?: boolean;
  is_muted?: boolean;
  marked_unread?: boolean;
  is_request?: boolean;
}

/** Неизвестный (новый) тип события — библиотека его не теряет, а отдаёт как есть. */
export interface UnknownFrame extends FrameBase {
  type: string;
  [key: string]: unknown;
}

export type KnownMessengerFrame =
  | NewMessageFrame
  | NewMessagesFrame
  | MessageEditedFrame
  | MessageDeletedFrame
  | MessagesDeletedFrame
  | MessagesReadFrame
  | MessageReactionsFrame
  | TypingFrame
  | PresenceFrame
  | ChatCreatedFrame
  | ChatDeletedFrame
  | HistoryClearedFrame
  | ChatSettingsFrame;

export type MessengerFrame = KnownMessengerFrame | UnknownFrame;

/** Ответ `GET /updates`. */
export interface UpdatesResponse {
  events: MessengerFrame[];
  /** Сервер не может отдать историю событий — нужно перечитать состояние заново. */
  reset_required: boolean;
  next_event_seq: number;
  chats?: ChatSummary[];
}

/* ───────────────────────────── Данные событий клиента ───────────────────────────── */

export interface MessageEditedEvent {
  chatId: string;
  messageId: string;
  message: Message;
}

export interface MessageDeletedEvent {
  chatId: string;
  messageIds: string[];
  newLastMessage: LastMessagePreview | null;
}

export interface MessagesReadEvent {
  chatId: string;
  userId: string;
  lastReadMessageId: string;
  /** true, если прочитали вы (с другого устройства). */
  isOwn: boolean;
}

export interface ReactionsEvent {
  chatId: string;
  messageId: string;
  reactions: ReactionCount[];
  reactionVersion: string | null;
}

export interface TypingEvent {
  chatId: string;
  userId: string;
  action: ChatAction | `${ChatAction}`;
  progress?: number;
}

export interface PresenceEvent {
  userId: string;
  online: boolean;
}

export interface ChatEvent {
  chatId: string;
}

export interface ChatCreatedEvent extends ChatEvent {
  chat?: ChatSummary;
}

export interface ChatSettingsEvent extends ChatEvent {
  isPinned?: boolean;
  isMuted?: boolean;
  markedUnread?: boolean;
  isRequest?: boolean;
}

export interface DisconnectedEvent {
  code: number;
  reason: string;
  /** Будет ли клиент переподключаться сам. */
  willReconnect: boolean;
}

export interface TokenRefreshedEvent {
  /** Когда истекает новый access-токен. */
  accessTokenExpiresAt: Date | null;
  /** true, если сервер выдал новый refresh-токен (он уже сохранён в sessionStore). */
  refreshTokenRotated: boolean;
}

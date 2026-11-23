/** Тип чата (`chat_type`). Сейчас на сайте есть только личные диалоги. */
export enum ChatType {
  Direct = 0,
}

/** Типы событий, которые сервер присылает в WebSocket и в `/updates`. */
export enum MessengerEventType {
  NewMessage = "new_message",
  NewMessages = "new_messages",
  /** Ваши собственные сообщения, отправленные с другого устройства/вкладки. */
  OwnMessages = "own_messages",
  MessageEdited = "message_edited",
  MessageDeleted = "message_deleted",
  MessagesDeleted = "messages_deleted",
  MessagesRead = "messages_read",
  MessageReactions = "message_reactions",
  Typing = "typing",
  Presence = "presence",
  HistoryCleared = "history_cleared",
  ChatCreated = "chat_created",
  ChatDeleted = "chat_deleted",
  ChatSettings = "chat_settings",
}

/** Статус-действие в чате («печатает…», «отправляет фото…»). */
export enum ChatAction {
  Typing = "typing",
  RecordVoice = "record_voice",
  RecordVideo = "record_video",
  UploadPhoto = "upload_photo",
  UploadVideo = "upload_video",
  UploadVoice = "upload_voice",
  UploadDocument = "upload_document",
}

/** Категория медиа для `getChatMedia`. */
export enum MediaCategory {
  Media = 0,
  Files = 1,
  Music = 2,
  Voice = 3,
}

/** Тип форматирования текста (`entities`). */
export enum EntityType {
  Bold = "bold",
  Italic = "italic",
  Underline = "underline",
  Strike = "strike",
  Code = "code",
  Spoiler = "spoiler",
  TextLink = "text_link",
  Post = "post",
  Sticker = "sticker",
}

/** Тип реакции. */
export enum ReactionType {
  Emoji = "emoji",
  Custom = "custom",
}

/** Коды ошибок API (поле `error.code`). */
export enum ApiErrorCode {
  BadRequest = "BAD_REQUEST",
  Unauthorized = "UNAUTHORIZED",
  AccessDenied = "ACCESS_DENIED",
  EntityNotFound = "ENTITY_NOT_FOUND",
  EntityAlreadyExists = "ENTITY_ALREADY_EXISTS",
  ValidationError = "VALIDATION_ERROR",
  BusinessRuleViolation = "BUSINESS_RULE_VIOLATION",
  RateLimitExceeded = "RATE_LIMIT_EXCEEDED",
  UnknownError = "UNKNOWN_ERROR",
  NetworkError = "NETWORK_ERROR",
  Timeout = "TIMEOUT",
  InvalidResponse = "INVALID_RESPONSE",
  SessionExpired = "SESSION_EXPIRED",
  SessionRevoked = "SESSION_REVOKED",
  SessionInvalidRefreshToken = "SESSION_INVALID_REFRESH_TOKEN",
  RefreshTokenMissing = "REFRESH_TOKEN_MISSING",
  PhoneVerificationRequired = "PHONE_VERIFICATION_REQUIRED",
  WriteAccessRestricted = "WRITE_ACCESS_RESTRICTED",
  ContentModerationFailed = "CONTENT_MODERATION_FAILED",
  FileTooLarge = "FILE_TOO_LARGE",
  UnsupportedFileType = "UNSUPPORTED_FILE_TYPE",
  UploadFailed = "UPLOAD_FAILED",
  UploadBusy = "UPLOAD_BUSY",
}

/** Значения заголовка `X-RateLimit-Scope` при ответе 429. */
export enum RateLimitScope {
  IpFlood = "ip_flood",
  GlobalFlood = "global_flood",
  /** Слишком много новых диалогов за час. В уже открытых чатах писать можно. */
  NewRecipientsHour = "new_recipients_hour",
  /** Слишком много новых диалогов за сутки. */
  NewRecipientsDay = "new_recipients_day",
}

/** Коды закрытия WebSocket, после которых нужно обновить токен. */
export enum WsCloseCode {
  AuthExpired = 4001,
  AuthRejected = 4003,
}

/** События клиента `ITDBotAPI` (подписка через `client.on(...)`). */
export enum ClientEvent {
  /** Клиент авторизован, WebSocket подключён. Аргумент — ваш профиль. */
  Ready = "ready",
  /** Входящее сообщение от другого пользователя. */
  Message = "message",
  /** Ваше собственное сообщение (отправлено этим клиентом или с другого устройства). */
  OwnMessage = "ownMessage",
  MessageEdited = "messageEdited",
  MessageDeleted = "messageDeleted",
  MessagesRead = "messagesRead",
  Reactions = "reactions",
  Typing = "typing",
  Presence = "presence",
  ChatCreated = "chatCreated",
  ChatDeleted = "chatDeleted",
  ChatSettings = "chatSettings",
  HistoryCleared = "historyCleared",
  /** Любой кадр от сервера без обработки. */
  Raw = "raw",
  Connected = "connected",
  Disconnected = "disconnected",
  /** Сервер попросил полностью перечитать состояние (`reset_required`). */
  Resync = "resync",
  /** Получен новый access-токен (и, возможно, новый refresh-токен). */
  TokenRefreshed = "tokenRefreshed",
  Error = "error",
}

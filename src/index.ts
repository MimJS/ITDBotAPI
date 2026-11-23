export { ITDBotAPI, ITDClient } from "./client.js";
export type {
  ITDBotAPIOptions,
  ClientEvents,
  SendTextOptions,
  SendFileOptions,
  RouteOptions,
  MessageHandler,
  HearsPattern,
} from "./client.js";

export { MessageContext, parseCommand } from "./context.js";
export type { ParsedCommand, ReplyOptions, ReplyFileOptions } from "./context.js";

export { MessengerAPI } from "./api/messenger.js";
export type { PageOptions, SendMessageOptions, EditMessageOptions } from "./api/messenger.js";
export { UsersAPI } from "./api/users.js";
export { MediaAPI } from "./api/media.js";
export type { UploadOptions } from "./api/media.js";

export { AuthManager } from "./auth.js";
export type { AuthManagerOptions } from "./auth.js";
export { HttpClient } from "./http.js";
export type { TransportConfig, RateLimitOptions, RequestOptions, TokenProvider } from "./http.js";
export { RealtimeGateway } from "./realtime.js";
export type { RealtimeOptions, RealtimeEvents } from "./realtime.js";
export { FileSessionStore, MemorySessionStore } from "./session.js";
export type { SessionStore, SessionData } from "./session.js";

export * from "./enums.js";
export * from "./errors.js";
export type * from "./types.js";
export * from "./constants.js";

export { TypedEmitter } from "./utils/emitter.js";
export { resolveFile, sniffMime, imageSize } from "./utils/file.js";
export type { FileSource, ResolvedFile } from "./utils/file.js";
export { decodeJwt, uuidv7, isUuid } from "./utils/common.js";

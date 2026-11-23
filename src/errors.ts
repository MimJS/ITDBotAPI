import { ApiErrorCode, type RateLimitScope } from "./enums.js";

/** Базовая ошибка библиотеки. */
export class ITDError extends Error {
  override name = "ITDError";
}

/** Ошибка, которую вернул сервер (или сеть) при запросе к API. */
export class ITDApiError extends ITDError {
  override name = "ITDApiError";
  /** HTTP-статус. 0 — сетевая ошибка или таймаут. */
  readonly status: number;
  /** Код ошибки (см. {@link ApiErrorCode}); может прийти и неизвестный код. */
  readonly code: ApiErrorCode | (string & {});
  /** Ошибки валидации по полям, если сервер их прислал. */
  readonly fieldErrors?: Record<string, string[]>;
  readonly method: string;
  readonly url: string;
  /** Сырой ответ сервера. */
  readonly body?: unknown;

  constructor(init: {
    message: string;
    status: number;
    code: string;
    method: string;
    url: string;
    fieldErrors?: Record<string, string[]>;
    body?: unknown;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.status = init.status;
    this.code = init.code;
    this.method = init.method;
    this.url = init.url;
    if (init.fieldErrors) this.fieldErrors = init.fieldErrors;
    if (init.body !== undefined) this.body = init.body;
  }
}

/** 429 Too Many Requests. */
export class ITDRateLimitError extends ITDApiError {
  override name = "ITDRateLimitError";
  /** Через сколько секунд можно повторить запрос. */
  readonly retryAfterSeconds: number;
  /** Область лимита из заголовка `X-RateLimit-Scope`. */
  readonly scope: RateLimitScope | (string & {}) | null;

  constructor(init: ConstructorParameters<typeof ITDApiError>[0] & { retryAfterSeconds: number; scope: string | null }) {
    super(init);
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.scope = init.scope;
  }
}

/** Не удалось авторизоваться: refresh-токен отсутствует, истёк или отозван. Нужен новый токен. */
export class ITDAuthError extends ITDApiError {
  override name = "ITDAuthError";
}

export function isAuthErrorCode(code: string): boolean {
  return (
    code === ApiErrorCode.Unauthorized ||
    code === ApiErrorCode.SessionExpired ||
    code === ApiErrorCode.SessionRevoked ||
    code === ApiErrorCode.SessionInvalidRefreshToken ||
    code === ApiErrorCode.RefreshTokenMissing
  );
}

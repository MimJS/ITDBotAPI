import { ApiErrorCode } from "./enums.js";
import { ITDApiError, ITDAuthError, ITDRateLimitError, isAuthErrorCode } from "./errors.js";
import { parseRetryAfter, sleep } from "./utils/common.js";

/** Тело запроса, которое принимает fetch. */
export type RequestBody = NonNullable<RequestInit["body"]>;

/** Общие настройки транспорта. */
export interface TransportConfig {
  baseUrl: string;
  userAgent: string;
  deviceId: string;
  timeoutMs: number;
  fetch: typeof fetch;
  /** Дополнительные заголовки для всех запросов. */
  headers: Record<string, string>;
}

/** Откуда HttpClient берёт access-токен. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Вызывается на 401: должен обновить токен. Возвращает true, если запрос стоит повторить. */
  handleUnauthorized(rejectedToken: string): Promise<boolean>;
}

export interface RateLimitOptions {
  /** Автоматически ждать и повторять запрос при 429. По умолчанию true. */
  autoRetry: boolean;
  /** Максимальное ожидание (мс), при котором ещё имеет смысл ждать. По умолчанию 15 000. */
  maxWaitMs: number;
  /** Сколько раз повторять при 429. По умолчанию 3. */
  maxRetries: number;
}

export interface RequestOptions {
  /** JSON-тело запроса. */
  json?: unknown;
  /** Бинарное или FormData-тело (взаимоисключающе с `json`). */
  body?: RequestBody;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** Добавлять ли `Authorization: Bearer`. По умолчанию true. */
  auth?: boolean;
  /** Можно ли безопасно повторить запрос при сетевой ошибке/5xx. По умолчанию true для GET/PUT/DELETE. */
  idempotent?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Заголовки, которые сайт шлёт с каждым запросом. */
export function baseHeaders(config: TransportConfig): Record<string, string> {
  return {
    "User-Agent": config.userAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    Origin: config.baseUrl,
    Referer: `${config.baseUrl}/`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Device-Id": config.deviceId,
    ...config.headers,
  };
}

function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return ApiErrorCode.BadRequest;
    case 401:
      return ApiErrorCode.Unauthorized;
    case 403:
      return ApiErrorCode.AccessDenied;
    case 404:
      return ApiErrorCode.EntityNotFound;
    case 409:
      return ApiErrorCode.EntityAlreadyExists;
    case 422:
      return ApiErrorCode.ValidationError;
    case 429:
      return ApiErrorCode.RateLimitExceeded;
    default:
      return ApiErrorCode.UnknownError;
  }
}

/** Разбирает ответ с ошибкой в ITDApiError (формат `{error:{code,message}}`, `{detail,title}` или violations). */
export async function errorFromResponse(res: Response, method: string, url: string): Promise<ITDApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const outer = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const inner = (outer.error && typeof outer.error === "object" ? outer.error : outer) as Record<string, unknown>;
  let fieldErrors = inner.errors as Record<string, string[]> | undefined;
  if (Array.isArray(inner.violations)) {
    fieldErrors = {};
    for (const v of inner.violations as Array<{ field: string; message: string }>) {
      (fieldErrors[v.field] ??= []).push(v.message);
    }
  }
  const message =
    (typeof inner.detail === "string" && inner.detail) ||
    (typeof inner.message === "string" && inner.message) ||
    (typeof inner.title === "string" && inner.title) ||
    (typeof outer.error === "string" && outer.error) ||
    `HTTP ${res.status}`;
  const code = (typeof inner.code === "string" && inner.code) || statusToCode(res.status);
  const init = { message, status: res.status, code, method, url, body, ...(fieldErrors ? { fieldErrors } : {}) };

  if (res.status === 429) {
    const isMessageSend = method === "POST" && /\/messenger\/(chats|users)\/[^/?]+\/messages(?:\?|$)/.test(url);
    return new ITDRateLimitError({
      ...init,
      retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After"), isMessageSend ? 2 : 30),
      scope: res.headers.get("X-RateLimit-Scope"),
    });
  }
  if (res.status === 401 || isAuthErrorCode(code)) return new ITDAuthError(init);
  return new ITDApiError(init);
}

/** HTTP-клиент: авторизация, повтор после обновления токена, ожидание при 429, ретраи при 5xx. */
export class HttpClient {
  constructor(
    readonly config: TransportConfig,
    private readonly tokens: TokenProvider,
    private readonly rateLimit: RateLimitOptions,
  ) {}

  /** Абсолютный URL для пути (`/api/...`) или уже абсолютного адреса. */
  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path, this.config.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, json?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, ...(json !== undefined ? { json } : {}) });
  }

  put<T>(path: string, json?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, ...(json !== undefined ? { json } : {}) });
  }

  patch<T>(path: string, json?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, ...(json !== undefined ? { json } : {}) });
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /** Выполняет запрос и разбирает JSON. 204 → undefined. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, options);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ITDApiError({
        message: "Сервер вернул не JSON",
        status: res.status,
        code: ApiErrorCode.InvalidResponse,
        method,
        url: res.url,
        body: text.slice(0, 500),
        cause,
      });
    }
  }

  /**
   * Выполняет запрос и возвращает сырой Response (только успешный, иначе бросает ITDApiError).
   * Сам обновляет токен на 401, ждёт на 429 и повторяет идемпотентные запросы на 5xx/сетевых ошибках.
   */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path, options.query);
    const useAuth = options.auth ?? true;
    const idempotent = options.idempotent ?? (method === "GET" || method === "PUT" || method === "DELETE");
    let authRetried = false;
    let rateLimitRetries = 0;
    let transientRetries = 0;

    for (;;) {
      const headers: Record<string, string> = { ...baseHeaders(this.config), ...options.headers };
      let body: RequestBody | undefined = options.body;
      if (options.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.json);
      }
      let token = "";
      if (useAuth) {
        token = await this.tokens.getAccessToken();
        headers.Authorization = `Bearer ${token}`;
      }

      const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
      const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
      let res: Response;
      try {
        res = await this.config.fetch(url, { method, headers, body: body ?? null, signal: AbortSignal.any(signals) });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        const timedOut = (cause as Error)?.name === "TimeoutError";
        if (idempotent && transientRetries < 2) {
          await sleep(500 * 3 ** transientRetries++);
          continue;
        }
        throw new ITDApiError({
          message: timedOut ? `Таймаут запроса (${timeoutMs} мс)` : `Сетевая ошибка: ${(cause as Error)?.message ?? cause}`,
          status: 0,
          code: timedOut ? ApiErrorCode.Timeout : ApiErrorCode.NetworkError,
          method,
          url,
          cause,
        });
      }

      if (res.ok) return res;

      if (res.status === 401 && useAuth && !authRetried) {
        await res.body?.cancel().catch(() => undefined);
        authRetried = true;
        if (await this.tokens.handleUnauthorized(token)) continue;
      }

      const error = await errorFromResponse(res, method, url);

      if (error instanceof ITDRateLimitError && this.rateLimit.autoRetry && rateLimitRetries < this.rateLimit.maxRetries) {
        const waitMs = error.retryAfterSeconds * 1000;
        if (waitMs <= this.rateLimit.maxWaitMs) {
          rateLimitRetries++;
          await sleep(waitMs, options.signal);
          continue;
        }
      }

      const transient =
        res.status >= 500 && res.status <= 599 && (idempotent || (res.status === 503 && error.code === ApiErrorCode.UploadBusy));
      if (transient && transientRetries < (error.code === ApiErrorCode.UploadBusy ? 10 : 2)) {
        await sleep(Math.min(500 * 3 ** transientRetries++, 5000), options.signal);
        continue;
      }

      throw error;
    }
  }
}

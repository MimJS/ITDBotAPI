import { ACCESS_TOKEN_REFRESH_MARGIN_MS, API_PATHS, REFRESH_COOKIE_NAME } from "./constants.js";
import { ApiErrorCode } from "./enums.js";
import { ITDApiError, ITDAuthError } from "./errors.js";
import { baseHeaders, errorFromResponse, type TokenProvider, type TransportConfig } from "./http.js";
import type { SessionStore } from "./session.js";
import type { TokenRefreshedEvent } from "./types.js";
import { decodeJwt, readSetCookie, sleep, type JwtClaims } from "./utils/common.js";

export interface AuthManagerOptions {
  /** Начальный refresh-токен (cookie `refresh_token`). Если в sessionStore есть более свежий — используется он. */
  refreshToken?: string | undefined;
  /** Готовый access-токен (JWT). Без refresh-токена работает только до истечения (~15 минут). */
  accessToken?: string | undefined;
  sessionStore?: SessionStore | undefined;
  onRefreshed?: ((event: TokenRefreshedEvent) => void) | undefined;
}

/**
 * Управляет токенами: хранит refresh-токен, получает access-токен через `POST /api/v1/auth/refresh`,
 * обновляет его заранее, сохраняет ротированный refresh-токен в sessionStore.
 */
export class AuthManager implements TokenProvider {
  #refreshToken: string | null;
  #initialRefreshToken: string | null;
  #accessToken: string | null;
  #claims: JwtClaims | null = null;
  #inflight: Promise<string> | null = null;
  #loaded = false;

  constructor(
    private readonly transport: TransportConfig,
    private readonly options: AuthManagerOptions = {},
  ) {
    this.#refreshToken = options.refreshToken?.trim() || null;
    this.#initialRefreshToken = this.#refreshToken;
    this.#accessToken = null;
    if (options.accessToken) this.#setAccessToken(options.accessToken.trim());
  }

  /** ID текущего пользователя из JWT (`sub`). Доступен после первого получения токена. */
  get userId(): string | null {
    return typeof this.#claims?.sub === "string" ? this.#claims.sub : null;
  }

  /** ID сессии из JWT (`sid`). */
  get sessionId(): string | null {
    return typeof this.#claims?.sid === "string" ? this.#claims.sid : null;
  }

  get accessTokenExpiresAt(): Date | null {
    return typeof this.#claims?.exp === "number" ? new Date(this.#claims.exp * 1000) : null;
  }

  get hasRefreshToken(): boolean {
    return this.#refreshToken !== null;
  }

  /** Текущий refresh-токен (например, чтобы сохранить его самостоятельно). */
  get refreshToken(): string | null {
    return this.#refreshToken;
  }

  /** Загружает сессию из sessionStore (один раз). Возвращает deviceId из хранилища, если он там есть. */
  async load(): Promise<string | undefined> {
    if (this.#loaded) return undefined;
    this.#loaded = true;
    const stored = await this.options.sessionStore?.load();
    if (stored?.refreshToken) this.#refreshToken = stored.refreshToken;
    return stored?.deviceId;
  }

  /** Возвращает действующий access-токен, при необходимости обновляя его. */
  async getAccessToken(): Promise<string> {
    if (this.#accessToken && !this.#isExpiring()) return this.#accessToken;
    return this.refresh();
  }

  async handleUnauthorized(rejectedToken: string): Promise<boolean> {
    if (!this.#refreshToken) return false;
    // Если пока ждали ответ, токен уже обновил кто-то другой — просто повторяем.
    if (this.#accessToken && this.#accessToken !== rejectedToken && !this.#isExpiring()) return true;
    this.#accessToken = null;
    await this.refresh();
    return true;
  }

  /** Сбрасывает access-токен, чтобы следующий запрос получил новый. */
  invalidateAccessToken(): void {
    this.#accessToken = null;
  }

  /** Принудительно обновляет access-токен. Параллельные вызовы объединяются в один запрос. */
  refresh(): Promise<string> {
    this.#inflight ??= this.#doRefresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #doRefresh(): Promise<string> {
    await this.load();
    if (!this.#refreshToken) {
      if (this.#accessToken) {
        throw new ITDAuthError({
          message: "Access-токен истёк, а refresh-токен не задан. Передайте refreshToken в опции клиента.",
          status: 401,
          code: ApiErrorCode.RefreshTokenMissing,
          method: "POST",
          url: API_PATHS.auth + "/refresh",
        });
      }
      throw new ITDAuthError({
        message: "Не задан refresh-токен. Передайте refreshToken (значение cookie refresh_token с итд.com).",
        status: 401,
        code: ApiErrorCode.RefreshTokenMissing,
        method: "POST",
        url: API_PATHS.auth + "/refresh",
      });
    }

    try {
      return await this.#refreshWith(this.#refreshToken);
    } catch (error) {
      // В sessionStore мог остаться протухший токен, а в опциях — новый, свежий. Пробуем его.
      const fallback = this.#initialRefreshToken;
      if (error instanceof ITDAuthError && fallback && fallback !== this.#refreshToken) {
        this.#refreshToken = fallback;
        return this.#refreshWith(fallback);
      }
      throw error;
    }
  }

  async #refreshWith(refreshToken: string): Promise<string> {
    const url = new URL(API_PATHS.auth + "/refresh", this.transport.baseUrl).toString();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.transport.fetch(url, {
          method: "POST",
          headers: {
            ...baseHeaders(this.transport),
            "Content-Type": "application/json",
            Cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`,
          },
          signal: AbortSignal.timeout(this.transport.timeoutMs),
        });
      } catch (cause) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ITDApiError({
          message: `Не удалось обновить токен: ${(cause as Error)?.message ?? cause}`,
          status: 0,
          code: ApiErrorCode.NetworkError,
          method: "POST",
          url,
          cause,
        });
      }

      if (!res.ok) {
        const error = await errorFromResponse(res, "POST", url);
        if (res.status >= 500 && attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }

      const body = (await res.json()) as { accessToken?: unknown };
      if (typeof body.accessToken !== "string" || !body.accessToken) {
        throw new ITDApiError({
          message: "Ответ /auth/refresh не содержит accessToken",
          status: res.status,
          code: ApiErrorCode.InvalidResponse,
          method: "POST",
          url,
          body,
        });
      }

      const rotated = readSetCookie(res.headers.getSetCookie?.() ?? [], REFRESH_COOKIE_NAME);
      const refreshTokenRotated = !!rotated && rotated !== refreshToken;
      if (refreshTokenRotated) this.#refreshToken = rotated;
      // Сохраняем всегда: так в файле появится и токен из опций, и deviceId.
      await this.options.sessionStore?.save({
        refreshToken: this.#refreshToken ?? refreshToken,
        deviceId: this.transport.deviceId,
      });

      this.#setAccessToken(body.accessToken);
      this.options.onRefreshed?.({ accessTokenExpiresAt: this.accessTokenExpiresAt, refreshTokenRotated });
      return body.accessToken;
    }
  }

  #setAccessToken(token: string): void {
    this.#accessToken = token;
    this.#claims = decodeJwt(token);
  }

  #isExpiring(): boolean {
    const exp = this.#claims?.exp;
    if (typeof exp !== "number") return false;
    return exp * 1000 - Date.now() <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
  }
}

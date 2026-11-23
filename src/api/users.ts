import { API_PATHS } from "../constants.js";
import type { HttpClient } from "../http.js";
import type { MyProfile, UserProfile } from "../types.js";
import { isUuid } from "../utils/common.js";

/** Профили пользователей (`/api/users`). */
export class UsersAPI {
  #idCache = new Map<string, string>();

  constructor(private readonly http: HttpClient) {}

  /** Ваш профиль. */
  getMe(): Promise<MyProfile> {
    return this.http.get(API_PATHS.core + "/users/me");
  }

  /** Профиль по username (можно с `@`) или ID. */
  getUser(usernameOrId: string): Promise<UserProfile> {
    const key = usernameOrId.trim().replace(/^@/, "");
    return this.http.get(API_PATHS.core + `/users/${encodeURIComponent(key)}`);
  }

  /** Превращает `@username` / `username` / UUID в ID пользователя (с кэшем). */
  async resolveId(usernameOrId: string): Promise<string> {
    const key = usernameOrId.trim().replace(/^@/, "");
    if (isUuid(key)) return key;
    const cached = this.#idCache.get(key.toLowerCase());
    if (cached) return cached;
    const user = await this.getUser(key);
    this.#idCache.set(key.toLowerCase(), user.id);
    return user.id;
  }
}

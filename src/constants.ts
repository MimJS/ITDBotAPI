/** Базовый адрес сайта (итд.com в punycode). */
export const DEFAULT_BASE_URL = "https://xn--d1ah4a.com";

/** Пути API относительно базового адреса. */
export const API_PATHS = {
  /** Основное API (профили, посты, уведомления). */
  core: "/api",
  /** Авторизация: refresh, logout и т.д. */
  auth: "/api/v1/auth",
  /** Мессенджер (личные сообщения). */
  messenger: "/api/v1/messenger",
} as const;

/** Имя HttpOnly-cookie, в которой сайт хранит refresh-токен. */
export const REFRESH_COOKIE_NAME = "refresh_token";

/** Подпротокол WebSocket мессенджера. */
export const WS_PROTOCOL = "itd.messenger.v1";

/** Capabilities, которые сайт передаёт при подключении к WebSocket. */
export const WS_CAPABILITIES = "chat_settings_v2";

/** Capabilities, которые сайт передаёт в `/updates`. */
export const UPDATES_CAPABILITIES = "chat_settings";

/** User-Agent по умолчанию: без браузерного UA часть эндпоинтов отвечает 502. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** ID системного пользователя «ИТД», который пишет служебные сообщения. */
export const ITD_SYSTEM_USER_ID = "6befaf81-e77b-51ac-be16-9d0ceebaff75";

/** Размер одной части при загрузке файла (как на сайте). */
export const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

/** Максимальный размер файла во вложении. */
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;

/** Сколько частей файла грузить параллельно. */
export const UPLOAD_CONCURRENCY = 2;

/** За сколько миллисекунд до истечения access-токена его нужно обновить. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

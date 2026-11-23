import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** UUIDv7 (сортируемый по времени), как `client_message_id` на сайте. */
export function uuidv7(now = Date.now()): string {
  const hex = now.toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface JwtClaims {
  sub?: string;
  sid?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  roles?: string[];
  [key: string]: unknown;
}

/** Декодирует payload JWT без проверки подписи. */
export function decodeJwt(token: string): JwtClaims | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return null;
  }
}

/** Достаёт значение cookie `name` из массива заголовков Set-Cookie. `""` — cookie удалена. */
export function readSetCookie(setCookies: string[], name: string): string | undefined {
  let found: string | undefined;
  for (const header of setCookies) {
    const first = header.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    found = decodeURIComponent(first.slice(eq + 1).trim());
    // Сервер иногда шлёт одну cookie дважды (с Domain и без) — берём непустое значение.
    if (found) return found;
  }
  return found;
}

/** Парсит `Retry-After` (секунды или HTTP-дата). */
export function parseRetryAfter(value: string | null, fallbackSeconds: number, now = Date.now()): number {
  if (value && /^\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
  }
  const date = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : fallbackSeconds;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Что нужно хранить между запусками. */
export interface SessionData {
  /** Актуальный refresh-токен (значение cookie `refresh_token`). */
  refreshToken: string;
  /** ID устройства (заголовок `X-Device-Id`). */
  deviceId?: string;
  /** Когда данные были сохранены (ISO). */
  updatedAt?: string;
}

/**
 * Хранилище сессии. Сервер может выдавать новый refresh-токен при каждом обновлении,
 * поэтому его нужно сохранять — иначе после перезапуска старый токен уже не подойдёт.
 */
export interface SessionStore {
  load(): Promise<SessionData | null> | SessionData | null;
  save(data: SessionData): Promise<void> | void;
}

/** Хранит сессию в памяти процесса (после перезапуска пропадёт). */
export class MemorySessionStore implements SessionStore {
  #data: SessionData | null;

  constructor(initial: SessionData | null = null) {
    this.#data = initial;
  }

  load(): SessionData | null {
    return this.#data;
  }

  save(data: SessionData): void {
    this.#data = { ...data };
  }
}

/** Хранит сессию в JSON-файле (права 600, запись атомарная через временный файл). */
export class FileSessionStore implements SessionStore {
  constructor(readonly path: string) {}

  async load(): Promise<SessionData | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<SessionData>;
      if (typeof raw.refreshToken !== "string" || !raw.refreshToken) return null;
      return {
        refreshToken: raw.refreshToken,
        ...(typeof raw.deviceId === "string" ? { deviceId: raw.deviceId } : {}),
        ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(data: SessionData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

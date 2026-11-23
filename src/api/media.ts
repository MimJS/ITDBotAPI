import { API_PATHS, MAX_UPLOAD_SIZE, UPLOAD_CHUNK_SIZE, UPLOAD_CONCURRENCY } from "../constants.js";
import type { HttpClient } from "../http.js";
import type { UploadedFile } from "../types.js";
import { imageSize, resolveFile, type FileSource, type ResolvedFile } from "../utils/file.js";

export interface UploadOptions {
  /** Имя файла, которое увидит собеседник. */
  filename?: string;
  /** MIME-тип. По умолчанию определяется по содержимому. */
  mime?: string;
  /** Размеры картинки/видео. Для PNG/JPEG/GIF/WebP определяются автоматически. */
  width?: number;
  height?: number;
  /** Длительность аудио/видео. */
  durationMs?: number;
  /** Волна голосового сообщения (base64), как на сайте. */
  waveform?: string;
  thumbhash?: string;
  /** Прогресс загрузки. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Загрузка файлов во вложения мессенджера:
 * `POST /media/upload/init` → `PUT /media/upload/:id/part/:n` (части по 5 МБ) → `POST /media/upload/:id/finalize`.
 */
export class MediaAPI {
  constructor(private readonly http: HttpClient) {}

  /** Загружает файл и возвращает `fileId` для `sendMessage(..., { attachments: [fileId] })`. */
  async upload(source: FileSource | ResolvedFile, options: UploadOptions = {}): Promise<UploadedFile & { file: ResolvedFile }> {
    const file = isResolved(source)
      ? source
      : await resolveFile(source, { filename: options.filename, mime: options.mime }, this.http.config.fetch);
    const size = file.data.byteLength;
    if (size === 0) throw new Error("Пустой файл");
    if (size > MAX_UPLOAD_SIZE) throw new Error(`Файл слишком большой: ${size} байт (максимум ${MAX_UPLOAD_SIZE})`);

    const totalParts = Math.max(1, Math.ceil(size / UPLOAD_CHUNK_SIZE));
    const base = API_PATHS.messenger + "/media/upload";
    const requestOpts = options.signal ? { signal: options.signal } : {};

    const { uploadId } = await this.http.post<{ uploadId: string }>(
      `${base}/init`,
      { mime: file.mime, size, totalParts },
      requestOpts,
    );

    let uploaded = 0;
    let next = 0;
    const worker = async () => {
      for (let part = next++; part < totalParts; part = next++) {
        const chunk = file.data.subarray(part * UPLOAD_CHUNK_SIZE, Math.min((part + 1) * UPLOAD_CHUNK_SIZE, size));
        await this.http.raw("PUT", `${base}/${encodeURIComponent(uploadId)}/part/${part}`, {
          body: chunk,
          headers: { "Content-Type": "application/octet-stream" },
          idempotent: true,
          timeoutMs: 120_000,
          ...requestOpts,
        }).then((res) => res.body?.cancel());
        uploaded += chunk.byteLength;
        options.onProgress?.(uploaded, size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, totalParts) }, worker));

    const dims =
      options.width && options.height
        ? { width: options.width, height: options.height }
        : file.mime.startsWith("image/")
          ? imageSize(file.data)
          : null;

    const result = await this.http.post<UploadedFile>(
      `${base}/${encodeURIComponent(uploadId)}/finalize`,
      {
        filename: file.filename,
        ...(dims ?? {}),
        ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
        ...(options.waveform ? { waveform: options.waveform } : {}),
        ...(options.thumbhash ? { thumbhash: options.thumbhash } : {}),
      },
      { idempotent: true, timeoutMs: 120_000, ...requestOpts },
    );
    if (!result || typeof result.fileId !== "string") throw new Error("Сервер не вернул fileId после загрузки");
    return { ...result, file };
  }
}

function isResolved(value: unknown): value is ResolvedFile {
  return (
    !!value &&
    typeof value === "object" &&
    (value as ResolvedFile).data instanceof Uint8Array &&
    typeof (value as ResolvedFile).filename === "string" &&
    typeof (value as ResolvedFile).mime === "string"
  );
}

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/**
 * Что можно передать как файл:
 * - `Buffer` / `Uint8Array` / `ArrayBuffer`
 * - `Blob` / `File`
 * - строку: путь к файлу или URL `http(s)://` (файл будет скачан)
 * - объект `{ data, filename?, mime? }`, чтобы явно задать имя и тип
 */
export type FileSource =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | string
  | URL
  | { data: Uint8Array | ArrayBuffer | Blob; filename?: string; mime?: string };

export interface ResolvedFile {
  data: Uint8Array;
  filename: string;
  mime: string;
}

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
};

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

/** Определяет MIME по сигнатуре файла. */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  const ascii = (start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (b.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
  if (b.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("hei") || brand === "mif1") return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 3 && (ascii(0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))) return "audio/mpeg";
  if (b.length >= 4 && ascii(0, 4) === "%PDF") return "application/pdf";
  return null;
}

/** Размеры картинки (PNG, JPEG, GIF, WebP) без сторонних библиотек. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = sniffMime(bytes);
  try {
    if (mime === "image/png" && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mime === "image/gif" && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mime === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") {
        const w = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
        const h = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
        return { width: w, height: h };
      }
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = bytes[offset + 1] ?? 0;
        if (marker === 0xff) {
          offset++;
          continue;
        }
        // SOF0..SOF15, кроме DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          offset += 2;
          continue;
        }
        offset += 2 + view.getUint16(offset + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toUint8(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function filenameFromUrl(url: URL): string | null {
  const name = decodeURIComponent(basename(url.pathname));
  return name && name !== "/" ? name : null;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

/** Приводит любой {@link FileSource} к байтам + имени + MIME. */
export async function resolveFile(
  source: FileSource,
  overrides: { filename?: string | undefined; mime?: string | undefined } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedFile> {
  let data: Uint8Array;
  let filename: string | null = null;
  let mime: string | null = null;

  if (typeof source === "string" || source instanceof URL) {
    const asString = source.toString();
    if (/^https?:\/\//i.test(asString)) {
      const url = new URL(asString);
      const res = await fetchImpl(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`Не удалось скачать ${url.href}: HTTP ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
      mime = res.headers.get("content-type")?.split(";")[0]?.trim() || null;
      filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? filenameFromUrl(new URL(res.url || url.href));
    } else {
      const path = asString.startsWith("file://") ? new URL(asString).pathname : asString;
      data = new Uint8Array(await readFile(path));
      filename = basename(path);
      mime = EXT_TO_MIME[extname(path).toLowerCase()] ?? null;
    }
  } else if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    data = toUint8(source);
  } else if (source instanceof Blob) {
    data = new Uint8Array(await source.arrayBuffer());
    mime = source.type || null;
    filename = "name" in source && typeof source.name === "string" ? source.name : null;
  } else {
    const inner = source.data;
    if (inner instanceof Blob) {
      data = new Uint8Array(await inner.arrayBuffer());
      mime = inner.type || null;
    } else {
      data = toUint8(inner as Uint8Array | ArrayBuffer);
    }
    filename = source.filename ?? null;
    mime = source.mime ?? mime;
  }

  const sniffed = sniffMime(data);
  // Сигнатура надёжнее заголовков: котики с CDN часто приходят как application/octet-stream.
  const finalMime =
    overrides.mime ??
    (sniffed && (!mime || mime === "application/octet-stream" || mime.startsWith("image/")) ? sniffed : null) ??
    mime ??
    (filename ? EXT_TO_MIME[extname(filename).toLowerCase()] : undefined) ??
    sniffed ??
    "application/octet-stream";

  let finalName = overrides.filename ?? filename ?? `file.${MIME_TO_EXT[finalMime] ?? "bin"}`;
  if (!extname(finalName) && MIME_TO_EXT[finalMime]) finalName += `.${MIME_TO_EXT[finalMime]}`;

  return { data, filename: finalName, mime: finalMime };
}

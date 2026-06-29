/**
 * Resolve TeraBox share links to downloadable files and save them to a public
 * folder. For personal/offline use.
 *
 * How it works: TeraBox's share API needs a logged-in account session (the
 * httpOnly `ndus` cookie) and the CDN gates downloads behind it — which a mobile
 * app can't satisfy (Android hides httpOnly cookies; the CDN blocks cross-origin
 * reads). So both the resolve (file list) and the download run server-side in a
 * tiny Cloudflare Worker that holds the cookie (see /terabox-worker). This module
 * fetches the file list from the Worker, parses it, and saves downloaded files;
 * the Worker does the TeraBox API work. No in-app TeraBox login or WebView.
 *
 * Saves land in a "Mordern Video Player" folder at the storage root via the
 * native raw-Java copy (expo-file-system refuses to write to shared storage even
 * with the all-files grant — same constraint the Instagram saver hits, see
 * lib/instagram.ts). On iOS the media goes to the gallery via expo-media-library.
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { Directory, File, Paths } from "expo-file-system";
import { Asset } from "expo-media-library";
import { Platform } from "react-native";

import { copyToPublicDir } from "@modules/all-files-access";

/** Public folder, at the storage root, that downloads are saved into (Android). */
export const SAVE_DIR = "/storage/emulated/0/Mordern Video Player/TeraBox";

/**
 * URL of the TeraBox download proxy (a Cloudflare Worker — see /terabox-worker).
 * The signed `dlink` 403s from the native downloader because it needs the
 * account's httpOnly session cookie, which a mobile app can't send. The Worker
 * does that authenticated fetch server-side and streams the file. When unset,
 * the app falls back to a (usually failing) direct download.
 */
export const TERABOX_PROXY_URL =
  process.env.EXPO_PUBLIC_TERABOX_PROXY_URL ?? "";
const TERABOX_PROXY_TOKEN =
  process.env.EXPO_PUBLIC_TERABOX_PROXY_TOKEN ?? "";

/**
 * The proxy URL that streams a file — used both for downloading and for online
 * playback (the Worker serves the bytes with the session cookie). Returns the
 * raw dlink when no proxy is configured (won't authenticate, but it's the only
 * fallback). Empty string only if there's no dlink and no proxy.
 */
export function teraboxStreamUrl(file: TeraboxFile): string {
  if (!TERABOX_PROXY_URL) return file.dlink;
  const base = TERABOX_PROXY_URL.replace(/\/$/, "");
  const token = TERABOX_PROXY_TOKEN
    ? `&token=${encodeURIComponent(TERABOX_PROXY_TOKEN)}`
    : "";
  // Prefer the surl so the Worker re-resolves on its own (cookie's) domain —
  // a dlink minted on a different mirror won't match the Worker's cookie.
  if (file.surl) {
    return `${base}/?surl=${encodeURIComponent(file.surl)}&fs_id=${encodeURIComponent(file.fsId)}${token}`;
  }
  return `${base}/?url=${encodeURIComponent(file.dlink)}${token}`;
}

/** Desktop UA for the direct-download fallback (used only when no proxy is set). */
const DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Headers for the file download. The CDN checks the User-Agent (must match the
 * one that minted the dlink) and the Referer (must be the originating TeraBox
 * mirror). The Referer is derived per-dlink from its host.
 */
function downloadHeaders(dlink: string): Record<string, string> {
  let referer = "https://www.terabox.com/";
  try {
    // d.1024tera.com → www.1024tera.com (the share page that minted the link).
    const host = new URL(dlink).hostname.replace(/^[^.]+\./, "www.");
    referer = `https://${host}/`;
  } catch {
    // keep the default
  }
  return {
    "User-Agent": DOWNLOAD_USER_AGENT,
    Referer: referer,
    Accept: "*/*",
  };
}

/**
 * The many mirror hosts TeraBox serves the same content under. A pasted link may
 * use any of them; we canonicalise to www.terabox.com (which the WebView session
 * is bound to) before hitting the API.
 */
const TERABOX_HOSTS = [
  "terabox.com",
  "terabox.app",
  "1024terabox.com",
  "teraboxapp.com",
  "terafileshare.com",
  "terasharelink.com",
  "teraboxlink.com",
  "mirrobox.com",
  "nephobox.com",
  "freeterabox.com",
  "4funbox.com",
  "momerybox.com",
  "tibibox.com",
];

/** Raised for any expected failure so the UI can show a friendly message. */
export class TeraboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeraboxError";
  }
}

/** Whether a URL's host is one of TeraBox's known mirror domains. */
export function isTeraboxUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl.trim()).hostname.replace(/^www\./, "");
    return TERABOX_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Pull the short-url id out of a share link. TeraBox links come as
 * `https://<host>/s/1XXXXXXXX` (the leading `1` is a prefix, not part of the id)
 * or `https://<host>/sharing/link?surl=XXXXXXXX`. Returns the bare id (no `1`),
 * which is what the API's `shorturl` param wants prefixed back with `1`.
 */
export function extractSurl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  // ?surl= form (already without the leading 1).
  const fromQuery = url.match(/[?&]surl=([A-Za-z0-9_-]+)/);
  if (fromQuery) return fromQuery[1].replace(/^1/, "");
  // /s/1XXXX form.
  const fromPath = url.match(/\/s\/1?([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  return null;
}

/** A single downloadable file from a TeraBox share. */
export type TeraboxFile = {
  /** Numeric file id, used as the stable React key and for logging. */
  fsId: string;
  filename: string;
  /** Size in bytes (0 if unknown). */
  size: number;
  /** Preview image URL, if TeraBox provided one. */
  thumbnail: string | null;
  /**
   * The signed download URL from the API. May be short-lived and/or require the
   * session; the download step handles failures by surfacing a friendly error.
   */
  dlink: string;
  /** The share's short-url id, so the proxy can re-resolve on its own domain. */
  surl?: string;
};

export type TeraboxShare = {
  surl: string;
  /** Name of the share's root folder, used to label/name saved files. */
  title: string | null;
  files: TeraboxFile[];
};

/** Compact preview of a long string for logs. */
function snippet(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max
    ? `${clean.slice(0, max)}…(${text.length} chars)`
    : clean;
}

/** Human-readable byte size for the UI (e.g. "12.4 MB"). */
export function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** One entry from the `share/list` response. */
type ListEntry = {
  fs_id?: number | string;
  server_filename?: string;
  size?: number | string;
  isdir?: number | string;
  dlink?: string;
  thumbs?: { url3?: string; url2?: string; url1?: string };
};

/**
 * Parse the raw body of a `share/list?...&root=1` response (fetched inside the
 * logged-in WebView) into the share's downloadable files. Throws
 * {@link TeraboxError} with a user-facing message if the body isn't usable JSON,
 * the API reported an error, the share is a nested folder, or there's nothing to
 * download. Folders (`isdir=1`) are skipped — v1 only handles flat file shares.
 */
export function parseShareListResponse(
  text: string,
  surl: string,
): TeraboxShare {
  let json: { errno?: number; list?: ListEntry[]; title?: string };
  try {
    json = JSON.parse(text);
  } catch {
    console.warn("[terabox] response not JSON:", snippet(text));
    throw new TeraboxError(
      "Couldn't read this link. Make sure you're connected and try again.",
    );
  }

  if (json.errno && json.errno !== 0) {
    console.warn(`[terabox] api errno=${json.errno}; body:`, snippet(text));
    // errno 2 = bad/missing params, -9 = file doesn't exist, 105 = bad link.
    throw new TeraboxError(
      json.errno === 105 || json.errno === -9
        ? "This TeraBox link is invalid or has expired."
        : "TeraBox rejected this request. The link may be private or password-protected.",
    );
  }

  const entries = json.list ?? [];
  const files: TeraboxFile[] = [];
  let skippedFolders = 0;
  for (const entry of entries) {
    if (String(entry.isdir) === "1") {
      skippedFolders++;
      continue;
    }
    if (!entry.fs_id) continue;
    files.push({
      fsId: String(entry.fs_id),
      filename: entry.server_filename ?? `terabox_${entry.fs_id}`,
      size: Number(entry.size) || 0,
      thumbnail:
        entry.thumbs?.url3 ?? entry.thumbs?.url2 ?? entry.thumbs?.url1 ?? null,
      dlink: entry.dlink ?? "",
      surl,
    });
  }

  console.log(
    `[terabox] parsed ${entries.length} entr(ies), ${files.length} file(s), ${skippedFolders} folder(s) skipped`,
  );

  if (files.length === 0) {
    throw new TeraboxError(
      skippedFolders > 0
        ? "This share is a folder. Open it and share an individual video link."
        : "This share has no downloadable files.",
    );
  }

  return { surl, title: json.title ?? null, files };
}

/**
 * Fetch a share's file list from the proxy Worker (which resolves it on the
 * cookie's domain). Replaces the old in-app WebView resolve, so the app needs no
 * TeraBox login at all. Throws {@link TeraboxError} if the proxy isn't configured
 * or the resolve fails.
 */
export async function fetchShareInfo(surl: string): Promise<TeraboxShare> {
  if (!TERABOX_PROXY_URL) {
    throw new TeraboxError(
      "TeraBox proxy isn't configured. Set EXPO_PUBLIC_TERABOX_PROXY_URL.",
    );
  }
  const base = TERABOX_PROXY_URL.replace(/\/$/, "");
  const token = TERABOX_PROXY_TOKEN
    ? `&token=${encodeURIComponent(TERABOX_PROXY_TOKEN)}`
    : "";
  const url = `${base}/?surl=${encodeURIComponent(surl)}&list=1${token}`;

  let text: string;
  try {
    const res = await fetch(url);
    text = await res.text();
  } catch (err) {
    console.warn("[terabox] info fetch failed:", String(err));
    throw new TeraboxError("Couldn't reach the TeraBox proxy. Check your connection.");
  }
  console.log(`[terabox] info response: ${text.length} chars`);
  // The Worker returns the shorturlinfo-style { errno, list } body, so the same
  // parser handles it. On a resolve error it returns { stage, errno, … }.
  return parseShareListResponse(text, surl);
}

/** Cache dir downloads land in before being moved to their final location. */
function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, "terabox");
  if (!dir.exists) dir.create();
  return dir;
}

/**
 * Build a `file://` URI from a raw path by percent-encoding each segment. The
 * new File/Directory API parses its argument as a `java.net.URI`, which throws on
 * raw spaces (and "Mordern Video Player" has them), so the path must be encoded.
 */
function pathToUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Strip `file://` and percent-decode a URI to a raw path for the native copy. */
function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

/**
 * A destination under {@link SAVE_DIR} for `name` that doesn't exist yet,
 * inserting ` (1)`, ` (2)`, … before the extension so re-saving never overwrites
 * a previous download. Mirrors the Instagram saver's behaviour.
 */
function uniqueDestPath(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let candidate = `${SAVE_DIR}/${name}`;
  let suffix = 1;
  while (new File(pathToUri(candidate)).exists) {
    candidate = `${SAVE_DIR}/${base} (${suffix})${ext}`;
    suffix++;
  }
  return candidate;
}

/** Strip characters that aren't safe in a file name. */
function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "terabox";
}

/**
 * Download one file and save it. On Android it's copied into the public
 * {@link SAVE_DIR} folder via the native raw-Java copy (which also media-scans
 * it so it shows in the gallery) — this needs the all-files grant. On iOS it goes
 * to the photo library via expo-media-library. The temporary cache file is always
 * removed. Returns the saved path/asset id. Throws {@link TeraboxError}.
 */
export async function saveTeraboxFile(
  file: TeraboxFile,
  onProgress?: (written: number, total: number) => void,
): Promise<string> {
  const filename = sanitizeName(file.filename);
  const emit = (m: string) => console.log(`[terabox] ${m}`);

  const usingProxy = !!TERABOX_PROXY_URL;
  const downloadUrl = teraboxStreamUrl(file);
  // Via the proxy, the Worker sets the cookie/UA/Referer itself; a direct
  // download still needs the browser-like headers (and usually 403s anyway).
  const headers = usingProxy ? {} : downloadHeaders(file.dlink);
  emit(`download "${filename}" (${formatSize(file.size) || "?"}) via ${usingProxy ? "proxy" : "dlink"}`);

  let downloaded: File | null = null;
  try {
    // Clear any leftover from a previous attempt so the download doesn't fail
    // on an already-existing destination.
    const dest = new File(cacheDir(), filename);
    if (dest.exists) dest.delete();
    downloaded = await File.downloadFileAsync(downloadUrl, dest, {
      headers,
      onProgress: onProgress
        ? ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes)
        : undefined,
    });
  } catch (err) {
    emit(`download error: ${String(err)}`);
    throw new TeraboxError(
      "Download failed. The link may have expired — fetch it again.",
    );
  }

  const downloadedSize = downloaded.size ?? 0;
  emit(`downloaded ${formatSize(downloadedSize) || `${downloadedSize}B`}`);
  // A tiny "download" is almost always an HTML/JSON error page, not the video —
  // the CDN rejected us (expired link, or it needs the session cookie).
  if (downloadedSize > 0 && downloadedSize < 4096) {
    emit(`too small — likely an error page, not the file`);
    // Surface the body (e.g. the proxy's JSON error) to aid debugging.
    try {
      emit(`body: ${(await downloaded.text()).slice(0, 200)}`);
    } catch {
      // best-effort
    }
    try {
      downloaded.delete();
    } catch {
      // best-effort
    }
    throw new TeraboxError(
      "TeraBox refused the download (the link may be expired or restricted). Try fetching again.",
    );
  }

  try {
    if (Platform.OS === "android") {
      const destPath = uniqueDestPath(filename);
      const saved = await copyToPublicDir(uriToPath(downloaded.uri), destPath);
      emit(`saved to ${saved}`);
      return saved;
    }
    const asset = await Asset.create(downloaded.uri);
    emit(`saved to gallery (${asset.id})`);
    return asset.id;
  } catch (err) {
    emit(`save error: ${String(err)}`);
    throw new TeraboxError("Couldn't save the file to your device.");
  } finally {
    try {
      downloaded.delete();
    } catch {
      // best-effort cleanup of the cache copy
    }
  }
}

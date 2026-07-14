/**
 * Resolve TeraBox share links to downloadable files and save them to a public
 * folder. For personal/offline use.
 *
 * How it works (on-device): TeraBox now blocks datacenter IPs — a server-side
 * resolver (the old Cloudflare Worker) is served an empty stub page, so it can't
 * read the share at all. But from a normal residential IP (the phone) the whole
 * flow works WITHOUT any login: fetch the share page to pick up the anti-bot
 * cookies (browserid/csrfToken, set automatically into the app's cookie store)
 * and the page's jsToken, call `/api/shorturlinfo` for the file list + share
 * signature, then hit `/share/streaming` for the transcoded HLS manifest. The
 * HLS segments are served by an open CDN that needs no cookies/headers, so we can
 * play them (via a local .m3u8) and download them (concatenated into one .ts)
 * entirely on-device. No proxy, no TeraBox login, no WebView.
 *
 * The full-quality "original" file still sits behind a logged-in httpOnly cookie
 * wall (its signed dlink 403s without the account session), so that mode is
 * best-effort via the optional proxy Worker; HLS is the reliable path.
 *
 * Saves land in a "Mordern Video Player" folder at the storage root via the
 * native raw-Java copy (expo-file-system refuses to write to shared storage even
 * with the all-files grant — same constraint the Instagram saver hits, see
 * lib/instagram.ts). On iOS the media goes to the gallery via expo-media-library.
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { Asset } from "expo-media-library";
import { Platform } from "react-native";

import { copyToPublicDir } from "@modules/all-files-access";
import {
  isBackgroundDownloadAvailable,
  startBackgroundDownload,
} from "@modules/media-downloader";

/** Public folder, at the storage root, that downloads are saved into (Android). */
export const SAVE_DIR = "/storage/emulated/0/Mordern Video Player/TeraBox";

/**
 * Optional TeraBox download proxy (a Cloudflare Worker — see /terabox-worker),
 * used ONLY for the "original" full-quality download, whose signed dlink needs
 * the account's httpOnly session cookie the app can't send. Resolve and the HLS
 * path no longer use it (they run on-device). When unset, "original" falls back
 * to a direct (usually 403ing) dlink download.
 */
export const TERABOX_PROXY_URL =
  process.env.EXPO_PUBLIC_TERABOX_PROXY_URL ?? "";
const TERABOX_PROXY_TOKEN =
  process.env.EXPO_PUBLIC_TERABOX_PROXY_TOKEN ?? "";

/** The h5 (mobile-web) origin we resolve against; may 3xx to a regional mirror. */
const H5_ORIGIN = "https://www.1024tera.com";

/** Common query params every h5 share API call carries. */
const API_BASE_QS =
  "app_id=250528&web=1&channel=dubox&clienttype=0&clientfrom=h5";

/** Transcoded HLS quality variants. 480 works on any account; 720/1080 need VIP. */
export type TeraboxQuality = "480" | "720" | "1080";

/** The `/share/streaming` `type` value per quality (mirrors the TeraBox site). */
const HLS_TYPES: Record<TeraboxQuality, string> = {
  "480": "M3U8_FLV_264_480",
  "720": "M3U8_AUTO_720",
  "1080": "M3U8_FLV_264_1080",
};

/**
 * How to fetch the bytes:
 * - `"hls"`   — the transcoded HLS stream (fast, unthrottled CDN). Quality is
 *               capped at the transcode and the file is a `.ts` container. This
 *               is the reliable, fully on-device path.
 * - `"original"` — the original file via its signed dlink. Full quality, but it
 *               needs the account session (proxy Worker) and TeraBox throttles it
 *               to ~20-30 KB/s for non-VIP accounts.
 */
export type TeraboxDownloadMode = "hls" | "original";

/** Desktop UA — TeraBox serves the full share page (with jsToken) to this. */
const TERABOX_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * The many mirror hosts TeraBox serves the same content under. A pasted link may
 * use any of them; we only need to recognise them — the resolve always runs
 * against {@link H5_ORIGIN} regardless of the pasted host.
 */
const TERABOX_HOSTS = [
  "terabox.com",
  "terabox.app",
  "1024tera.com",
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
 * or with a `?surl=XXXXXXXX` query (`/sharing/link`, `/wap/share/filelist`, …).
 * Returns the bare id, which the API's `shorturl` param wants prefixed back
 * with `1`. The query form never carries the leading `1`, so it's left intact;
 * only the `/s/1…` path form strips it.
 */
export function extractSurl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  // ?surl= form (already without the leading 1 — don't strip anything).
  const fromQuery = url.match(/[?&]surl=([A-Za-z0-9_-]+)/);
  if (fromQuery) return fromQuery[1];
  // /s/1XXXX form (the leading 1 is a prefix, not part of the id).
  const fromPath = url.match(/\/s\/1?([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  return null;
}

/**
 * Everything needed to build the authenticated `/share/streaming` and download
 * URLs for a share — resolved once (on-device) and stamped onto each file.
 */
type ShareContext = {
  shareid: string;
  uk: string;
  sign: string;
  timestamp: string;
  jsToken: string;
  /** Final origin after any regional redirect (API calls hang off this). */
  origin: string;
};

/** A single downloadable file from a TeraBox share. */
export type TeraboxFile = ShareContext & {
  /** Numeric file id, used as the stable React key and for logging. */
  fsId: string;
  filename: string;
  /** Size in bytes of the ORIGINAL file (0 if unknown). */
  size: number;
  /** Preview image URL, if TeraBox provided one. */
  thumbnail: string | null;
  /** Signed original-file dlink, if resolved (used by "original" mode). */
  dlink: string;
  /** The share's short-url id (bare, no leading 1). */
  surl: string;
};

export type TeraboxShare = {
  surl: string;
  /** Name of the share's root folder, used to label/name saved files. */
  title: string | null;
  files: TeraboxFile[];
};

/** Compact preview of a long string for logs. */
function snippet(text: string, max = 300): string {
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

/**
 * Extract the jsToken from the share page HTML. TeraBox embeds it as
 * `window.jsToken = a};fn("<256-hex>")` — the `fn` body is a no-op that just
 * assigns its argument, so the hex string IS the token. Handles both the raw and
 * URL-encoded forms (the page ships it inside an `eval(decodeURIComponent(...))`).
 */
function extractJsToken(html: string): string | null {
  let decoded = html;
  try {
    decoded = decodeURIComponent(html);
  } catch {
    // keep the raw html
  }
  const patterns = [
    /fn\("([0-9a-fA-F]{60,})"\)/,
    /fn%28%22([0-9a-fA-F]{60,})%22%29/,
    /"jsToken"\s*:\s*"([0-9a-fA-F]{60,})"/,
    /jsToken%22%3A%22([0-9a-fA-F]{60,})%22/,
  ];
  for (const p of patterns) {
    const m = html.match(p) || decoded.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** One entry from a `shorturlinfo` / `share/list` response `list`. */
type ListEntry = {
  fs_id?: number | string;
  server_filename?: string;
  size?: number | string;
  isdir?: number | string;
  /** Full path within the share (`/Folder/Sub/file.mp4`); used to list folders. */
  path?: string;
  dlink?: string;
  thumbs?: { url3?: string; url2?: string; url1?: string; icon?: string };
};

/**
 * Bounds on how much of a share we enumerate, so a pathologically deep or huge
 * folder can't spin forever. Personal-use shares are comfortably under these.
 */
const MAX_SHARE_FILES = 200;
const MAX_FOLDER_VISITS = 60;

type ShortUrlInfo = {
  errno?: number;
  errmsg?: string;
  shareid?: number | string;
  uk?: number | string;
  sign?: string;
  timestamp?: number | string;
  title?: string;
  list?: ListEntry[];
};

/** A friendly message for a shorturlinfo errno. */
function errnoMessage(errno: number | undefined): string {
  // -9 = file gone, 105 = bad link, -12 = needs password, 400210 = anti-bot.
  if (errno === 105 || errno === -9) {
    return "This TeraBox link is invalid or has expired.";
  }
  if (errno === -12) {
    return "This share is password-protected, which isn't supported.";
  }
  if (errno === 400210) {
    return "TeraBox blocked the request. Please try fetching again.";
  }
  return "TeraBox rejected this request. The link may be private or restricted.";
}

/**
 * Resolve a share on-device: GET the share page (which sets the anti-bot cookies
 * into the app's cookie store and carries the jsToken), then call shorturlinfo
 * for the file list + share signature. Runs from the device's residential IP, so
 * it isn't hit by the datacenter-IP block that kills a server-side resolver.
 * Throws {@link TeraboxError} with a user-facing message on any failure.
 */
async function resolveShareOnDevice(surl: string): Promise<TeraboxShare> {
  const ua = { "User-Agent": TERABOX_USER_AGENT };
  const pageUrl = `${H5_ORIGIN}/sharing/link?surl=${encodeURIComponent(surl)}`;

  let pageRes: Response;
  let html: string;
  try {
    pageRes = await fetch(pageUrl, { headers: ua });
    html = await pageRes.text();
  } catch (err) {
    console.warn("[terabox] page fetch failed:", String(err));
    throw new TeraboxError("Couldn't reach TeraBox. Check your connection.");
  }

  let origin = H5_ORIGIN;
  try {
    origin = new URL(pageRes.url).origin;
  } catch {
    // keep H5_ORIGIN
  }

  const jsToken = extractJsToken(html);
  if (!jsToken) {
    console.warn(
      `[terabox] no jsToken (status=${pageRes.status}, htmlLen=${html.length}, finalUrl=${pageRes.url})`,
    );
    throw new TeraboxError(
      "Couldn't read this share. TeraBox may be blocking the request — please try again.",
    );
  }

  const qs =
    `${API_BASE_QS}&jsToken=${encodeURIComponent(jsToken)}&dp-logid=`;
  const apiHeaders = { ...ua, Referer: pageUrl };

  let info: ShortUrlInfo;
  try {
    const res = await fetch(
      `${origin}/api/shorturlinfo?${qs}&shorturl=1${encodeURIComponent(surl)}&root=1`,
      { headers: apiHeaders },
    );
    info = (await res.json()) as ShortUrlInfo;
  } catch (err) {
    console.warn("[terabox] shorturlinfo failed:", String(err));
    throw new TeraboxError("Couldn't read this share right now. Please try again.");
  }

  if (info.errno !== 0 || !info.shareid || !info.sign) {
    console.warn(
      `[terabox] shorturlinfo errno=${info.errno} errmsg=${info.errmsg ?? ""}`,
    );
    throw new TeraboxError(errnoMessage(info.errno));
  }

  const ctx: ShareContext = {
    shareid: String(info.shareid),
    uk: String(info.uk),
    sign: String(info.sign),
    timestamp: String(info.timestamp),
    jsToken,
    origin,
  };

  const rootEntries = info.list ?? [];
  // Walk the share breadth-first, descending into subfolders (a folder share's
  // root is just the folder entry). shorturlinfo gives the share-level signature;
  // each folder's contents come from share/list?dir=<path>.
  const collected: ListEntry[] = [];
  const queue: ListEntry[] = [...rootEntries];
  let folderVisits = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (collected.length >= MAX_SHARE_FILES) {
      truncated = true;
      break;
    }
    const entry = queue.shift() as ListEntry;
    if (String(entry.isdir) === "1") {
      if (folderVisits >= MAX_FOLDER_VISITS) {
        truncated = true;
        continue;
      }
      folderVisits++;
      const children = await listShareDir(
        origin,
        apiHeaders,
        qs,
        surl,
        String(entry.path ?? ""),
      );
      queue.push(...children);
    } else if (entry.fs_id) {
      collected.push(entry);
    }
  }

  const files: TeraboxFile[] = collected.map((entry) => ({
    ...ctx,
    fsId: String(entry.fs_id),
    filename: entry.server_filename ?? `terabox_${entry.fs_id}`,
    size: Number(entry.size) || 0,
    thumbnail:
      entry.thumbs?.url3 ??
      entry.thumbs?.url2 ??
      entry.thumbs?.url1 ??
      entry.thumbs?.icon ??
      null,
    dlink: entry.dlink ?? "",
    surl,
  }));

  console.log(
    `[terabox] resolved ${files.length} file(s) across ${folderVisits} folder(s)${truncated ? " (truncated)" : ""}`,
  );

  if (files.length === 0) {
    throw new TeraboxError("This share has no downloadable files.");
  }

  return { surl, title: info.title ?? topFolderName(rootEntries), files };
}

/**
 * List one folder inside a share via `share/list?dir=<path>`. Returns its entries
 * (files and subfolders); on any error returns [] so one bad folder doesn't sink
 * the whole resolve.
 */
async function listShareDir(
  origin: string,
  headers: Record<string, string>,
  qs: string,
  surl: string,
  dir: string,
): Promise<ListEntry[]> {
  const url =
    `${origin}/share/list?${qs}&shorturl=${encodeURIComponent(surl)}` +
    `&dir=${encodeURIComponent(dir)}&page=1&num=1000&by=name&order=asc`;
  let json: { errno?: number; list?: ListEntry[] };
  try {
    const res = await fetch(url, { headers });
    json = (await res.json()) as { errno?: number; list?: ListEntry[] };
  } catch (err) {
    console.warn(`[terabox] share/list failed (dir=${dir}):`, String(err));
    return [];
  }
  if (json.errno !== 0) {
    console.warn(`[terabox] share/list errno=${json.errno} (dir=${dir})`);
    return [];
  }
  return json.list ?? [];
}

/** The share's top-level folder name (from the first entry's path), for a title. */
function topFolderName(entries: ListEntry[]): string | null {
  for (const entry of entries) {
    const seg = String(entry.path ?? "")
      .split("/")
      .filter(Boolean)[0];
    if (seg) return seg;
  }
  return null;
}

/**
 * Fetch a share's file list, on-device. Throws {@link TeraboxError} on failure.
 */
export async function fetchShareInfo(surl: string): Promise<TeraboxShare> {
  return resolveShareOnDevice(surl);
}

/** Build the authenticated `/share/streaming` HLS manifest URL for a file. */
function streamingUrl(file: TeraboxFile, quality: TeraboxQuality): string {
  const type = HLS_TYPES[quality] ?? HLS_TYPES["480"];
  return (
    `${file.origin}/share/streaming?uk=${encodeURIComponent(file.uk)}` +
    `&shareid=${encodeURIComponent(file.shareid)}&type=${type}` +
    `&fid=${encodeURIComponent(file.fsId)}&sign=${encodeURIComponent(file.sign)}` +
    `&timestamp=${encodeURIComponent(file.timestamp)}` +
    `&jsToken=${encodeURIComponent(file.jsToken)}` +
    `&isplayer=1&esl=1&ehps=1&${API_BASE_QS}`
  );
}

/**
 * Fetch the transcoded HLS manifest text for a file. The `/share/streaming`
 * endpoint needs the session cookies + jsToken (both held on-device); a
 * non-manifest body means the quality isn't available (720/1080 need VIP) or the
 * signature expired. Throws {@link TeraboxError} in that case.
 */
async function fetchHlsManifest(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<string> {
  let text: string;
  try {
    const res = await fetch(streamingUrl(file, quality), {
      headers: { "User-Agent": TERABOX_USER_AGENT, Referer: `${file.origin}/` },
    });
    text = await res.text();
  } catch (err) {
    console.warn("[terabox] streaming fetch failed:", String(err));
    throw new TeraboxError("Couldn't reach TeraBox. Check your connection.");
  }
  if (!text.trim().startsWith("#EXTM3U")) {
    console.warn(`[terabox] streaming q=${quality} not a manifest:`, snippet(text));
    throw new TeraboxError(
      quality === "480"
        ? "Couldn't get a playable stream for this file."
        : `The ${quality}p stream isn't available for this share.`,
    );
  }
  return text;
}

/**
 * Fetch the transcoded stream and expand TeraBox's short preview window into a
 * manifest covering the whole file (see {@link expandTranscodedManifest}). Falls
 * back to the preview as-is if it isn't the expected byte-range form.
 */
async function fetchFullStream(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<FullManifest> {
  const sample = await fetchHlsManifest(file, quality);
  const base = streamingUrl(file, quality);
  const full = expandTranscodedManifest(sample, base);
  logManifestDiagnostics(sample, full, quality);
  return full ?? { manifest: sample, segments: hlsSegmentUrls(sample, base) };
}

/** Read a numeric query param off a URL string (0 if absent/unparseable). */
function numParam(url: string, name: string): number {
  return Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)?.[1] ?? 0);
}

/** Replace an existing query param's value in a URL string (no-op if absent). */
function setParam(url: string, name: string, value: string | number): string {
  return url.replace(new RegExp(`([?&]${name}=)[^&]*`), `$1${value}`);
}

/**
 * A full manifest reconstructed from TeraBox's short preview window.
 *
 * TeraBox's `/share/streaming` returns only a few segments (~20-30s) that are
 * byte-range slices of the transcoded `.ts` (`ts_size` = its full length),
 * marked `#EXT-X-ENDLIST` so a player stops there. But every segment shares one
 * `sign`/`xcode` that authorizes the whole object — only `range`/`len` change —
 * so we can page contiguous byte windows over the entire `0…ts_size` range and
 * rebuild the complete stream. Segment durations are extrapolated from the
 * sample window's bytes-per-second ratio (used for the seek bar; playback of the
 * full stream doesn't depend on their accuracy).
 */
type FullManifest = { manifest: string; segments: string[] };

/** Roughly how many seconds of video each rebuilt segment should span. */
const SEGMENT_TARGET_SECONDS = 10;

/**
 * Expand a windowed preview manifest into one covering the whole transcoded
 * file. Returns `null` if the manifest isn't the expected byte-range form (no
 * `ts_size`/`range` on the segments), so the caller can fall back to the raw
 * preview segments.
 */
function expandTranscodedManifest(
  sample: string,
  baseUrl: string,
): FullManifest | null {
  const sampleSegments = hlsSegmentUrls(sample, baseUrl);
  const template = sampleSegments[0];
  if (!template) return null;

  const tsSize = numParam(template, "ts_size");
  // The byte-range slicing markers must be present to page the file safely.
  if (!tsSize || !/[?&]range=/.test(template) || !/[?&]len=/.test(template)) {
    return null;
  }

  // Bytes-per-second from the preview window: Σ segment length ÷ Σ EXTINF.
  const durations = [...sample.matchAll(/#EXTINF:([\d.]+)/g)].map((m) =>
    Number(m[1] || 0),
  );
  const totalLen = sampleSegments.reduce((s, u) => s + numParam(u, "len"), 0);
  const totalDur = durations.reduce((s, d) => s + d, 0);
  const bytesPerSecond = totalDur > 0 && totalLen > 0 ? totalLen / totalDur : 0;

  // Window size ≈ SEGMENT_TARGET_SECONDS, aligned down to the 188-byte MPEG-TS
  // packet size so segment boundaries land on packet edges.
  const rawWindow = bytesPerSecond
    ? Math.round(bytesPerSecond * SEGMENT_TARGET_SECONDS)
    : 1_000_000;
  const windowBytes = Math.max(188, Math.floor(rawWindow / 188) * 188);

  const segments: string[] = [];
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(SEGMENT_TARGET_SECONDS)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let start = 0; start < tsSize; start += windowBytes) {
    const end = Math.min(start + windowBytes, tsSize) - 1;
    const bytes = end - start + 1;
    const dur = bytesPerSecond ? bytes / bytesPerSecond : SEGMENT_TARGET_SECONDS;
    let url = setParam(template, "range", `${start}-${end}`);
    url = setParam(url, "len", bytes);
    url = setParam(url, "dtime", Math.max(1, Math.round(dur)));
    segments.push(url);
    lines.push(`#EXTINF:${dur.toFixed(3)},`, url);
  }
  lines.push("#EXT-X-ENDLIST");
  return { manifest: lines.join("\n"), segments };
}

/**
 * Log a one-line summary of the preview manifest and the rebuilt full manifest,
 * so a short/truncated stream is easy to spot in device logs.
 */
function logManifestDiagnostics(
  manifest: string,
  full: FullManifest | null,
  quality: TeraboxQuality,
): void {
  const previewSegs = hlsSegmentUrls(manifest, "").length;
  const previewSecs = [...manifest.matchAll(/#EXTINF:([\d.]+)/g)].reduce(
    (s, m) => s + Number(m[1] || 0),
    0,
  );
  if (full) {
    const fullSecs = [...full.manifest.matchAll(/#EXTINF:([\d.]+)/g)].reduce(
      (s, m) => s + Number(m[1] || 0),
      0,
    );
    console.log(
      `[terabox] manifest q=${quality}: preview ${previewSegs} seg / ` +
        `${previewSecs.toFixed(1)}s → rebuilt ${full.segments.length} seg / ` +
        `${fullSecs.toFixed(1)}s`,
    );
  } else {
    console.log(
      `[terabox] manifest q=${quality}: preview ${previewSegs} seg / ` +
        `${previewSecs.toFixed(1)}s (not a byte-range manifest, using as-is)`,
    );
  }
}

/** The absolute segment URLs from an HLS media playlist, in order. */
function hlsSegmentUrls(manifest: string, baseUrl: string): string[] {
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (/^https?:\/\//.test(l) ? l : new URL(l, baseUrl).toString()));
}

/** Cache dir downloads land in before being moved to their final location. */
function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, "terabox");
  if (!dir.exists) dir.create();
  return dir;
}

/**
 * Resolve a local, playable URI for a file. Fetches the HLS manifest on-device
 * (the site's fast transcoded stream) and writes it to a cache `.m3u8` whose
 * segments are absolute, open-CDN URLs — so the player streams them directly with
 * no headers. Falls back to the throttled dlink/proxy stream if HLS is
 * unavailable. Returns "" if nothing is playable.
 */
export async function prepareTeraboxWatchUri(
  file: TeraboxFile,
  quality: TeraboxQuality = "480",
): Promise<string> {
  try {
    const { manifest } = await fetchFullStream(file, quality);
    const local = new File(cacheDir(), `play_${file.fsId}_${quality}.m3u8`);
    if (local.exists) local.delete();
    local.write(manifest);
    return local.uri;
  } catch (err) {
    console.warn("[terabox] watch prepare failed, trying dlink:", String(err));
    return teraboxStreamUrl(file);
  }
}

/**
 * The proxy URL that streams the ORIGINAL file (full quality). The signed dlink
 * needs the account's httpOnly cookie, so it goes through the proxy Worker when
 * configured; otherwise the raw dlink (which usually 403s without the session).
 * Empty string if there's neither.
 */
export function teraboxStreamUrl(file: TeraboxFile): string {
  if (!TERABOX_PROXY_URL) return file.dlink;
  const base = TERABOX_PROXY_URL.replace(/\/$/, "");
  const token = TERABOX_PROXY_TOKEN
    ? `&token=${encodeURIComponent(TERABOX_PROXY_TOKEN)}`
    : "";
  if (file.surl) {
    return `${base}/?surl=${encodeURIComponent(file.surl)}&fs_id=${encodeURIComponent(file.fsId)}${token}`;
  }
  return `${base}/?url=${encodeURIComponent(file.dlink)}${token}`;
}

/** Build a `file://` URI from a raw path by percent-encoding each segment. */
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

/** The saved file name for a download: HLS downloads are `.ts` containers. */
function downloadFileName(file: TeraboxFile, mode: TeraboxDownloadMode): string {
  const name = sanitizeName(file.filename);
  return mode === "hls" ? `${name.replace(/\.[^.]+$/, "")}.ts` : name;
}

/** Best-effort MIME from a filename's extension — labels the download notification. */
function guessMimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "ts":
      return "video/mp2t";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    default:
      return "video/*";
  }
}

/**
 * Whether a file can be enqueued as a system background download. Only the
 * "original" mode can (a single URL the OS DownloadManager fetches). HLS is a
 * multi-segment stream that has to be concatenated in-app, so it always uses the
 * foreground download path regardless of this.
 */
export function teraboxBackgroundDownloadAvailable(
  mode: TeraboxDownloadMode = "hls",
): boolean {
  return mode === "original" && isBackgroundDownloadAvailable();
}

/**
 * Enqueue the ORIGINAL file as a system background download (Android). HLS isn't
 * supported here (it needs in-app concatenation) — callers must use
 * {@link saveTeraboxFile} for HLS. Returns the DownloadManager id.
 */
export async function startTeraboxDownload(
  file: TeraboxFile,
  mode: TeraboxDownloadMode = "hls",
): Promise<number> {
  if (mode !== "original") {
    throw new TeraboxError("HLS downloads run in-app, not in the background.");
  }
  const url = teraboxStreamUrl(file);
  if (!url) throw new TeraboxError("No download URL for this file.");
  const name = downloadFileName(file, mode);
  return startBackgroundDownload({
    url,
    fileName: name,
    destPath: `${SAVE_DIR}/${name}`,
    mimeType: guessMimeType(name),
  });
}

/**
 * Download the HLS stream into `dest` by fetching each segment and appending it,
 * so memory stays flat (one segment at a time) even for a large video. Segments
 * are open-CDN URLs needing no headers. Reports approximate byte progress
 * (extrapolated from segment count, since the transcode's total size is unknown).
 */
async function downloadHlsToFile(
  file: TeraboxFile,
  quality: TeraboxQuality,
  dest: File,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const { segments } = await fetchFullStream(file, quality);
  if (segments.length === 0) {
    throw new TeraboxError("This stream has no segments to download.");
  }

  if (dest.exists) dest.delete();
  dest.create();
  const handle = dest.open(FileMode.Append);
  let written = 0;
  try {
    for (let i = 0; i < segments.length; i++) {
      let buf: ArrayBuffer;
      try {
        const res = await fetch(segments[i]);
        if (!res.ok) throw new Error(`segment ${i} HTTP ${res.status}`);
        buf = await res.arrayBuffer();
      } catch {
        throw new TeraboxError(
          `Download interrupted (segment ${i + 1}/${segments.length}). Try again.`,
        );
      }
      handle.writeBytes(new Uint8Array(buf));
      written += buf.byteLength;
      // Extrapolate a total from the average segment size so the UI can show a
      // sensible percentage; the true transcode size isn't known up front.
      const total = Math.round((written / (i + 1)) * segments.length);
      onProgress?.(written, total);
    }
  } finally {
    handle.close();
  }
}

/**
 * Download one file and save it. HLS is fetched + concatenated on-device; the
 * "original" mode uses the (proxied) dlink. On Android it's copied into the public
 * {@link SAVE_DIR} folder via the native raw-Java copy (which also media-scans it)
 * — this needs the all-files grant. On iOS it goes to the photo library. The temp
 * cache file is always removed. Returns the saved path/asset id. Throws
 * {@link TeraboxError}.
 */
export async function saveTeraboxFile(
  file: TeraboxFile,
  mode: TeraboxDownloadMode = "hls",
  onProgress?: (written: number, total: number) => void,
  quality: TeraboxQuality = "480",
): Promise<string> {
  const filename = downloadFileName(file, mode);
  const emit = (m: string) => console.log(`[terabox] ${m}`);
  emit(`download "${filename}" (${formatSize(file.size) || "?"}) via ${mode}`);

  const cached = new File(cacheDir(), filename);

  try {
    if (mode === "hls") {
      await downloadHlsToFile(file, quality, cached, onProgress);
    } else {
      const url = teraboxStreamUrl(file);
      if (!url) throw new TeraboxError("No download URL for this file.");
      if (cached.exists) cached.delete();
      await File.downloadFileAsync(url, cached, {
        headers: TERABOX_PROXY_URL
          ? {}
          : {
              "User-Agent": TERABOX_USER_AGENT,
              Referer: `${file.origin}/`,
              Accept: "*/*",
            },
        onProgress: onProgress
          ? ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes)
          : undefined,
      });
    }
  } catch (err) {
    emit(`download error: ${String(err)}`);
    if (err instanceof TeraboxError) throw err;
    throw new TeraboxError(
      "Download failed. The link may have expired — fetch it again.",
    );
  }

  const downloadedSize = cached.size ?? 0;
  emit(`downloaded ${formatSize(downloadedSize) || `${downloadedSize}B`}`);
  // A tiny "download" is almost always an HTML/JSON error page, not the video.
  if (downloadedSize > 0 && downloadedSize < 4096) {
    emit(`too small — likely an error page, not the file`);
    try {
      emit(`body: ${(await cached.text()).slice(0, 200)}`);
    } catch {
      // best-effort
    }
    try {
      cached.delete();
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
      const saved = await copyToPublicDir(uriToPath(cached.uri), destPath);
      emit(`saved to ${saved}`);
      return saved;
    }
    const asset = await Asset.create(cached.uri);
    emit(`saved to gallery (${asset.id})`);
    return asset.id;
  } catch (err) {
    emit(`save error: ${String(err)}`);
    throw new TeraboxError("Couldn't save the file to your device.");
  } finally {
    try {
      cached.delete();
    } catch {
      // best-effort cleanup of the cache copy
    }
  }
}

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
 * A SHARE's `/share/streaming` only ever transcodes a short (~4-min) preview
 * window, even logged in — confirmed by testing the same account's web session.
 * TeraBox's own site works around this by first "saving" the shared file into
 * your own drive, then streaming/downloading it as an owned file, which isn't
 * capped (see {@link fetchHlsManifest}, {@link saveShareToOwnDrive}). We
 * replicate that: resolve the share as usual, copy it into a folder in the
 * account (`/api/create` + `/share/transfer`), stream from `/api/streaming?path=`
 * (no shareid/uk/sign needed — just the file's own path), then delete the copy
 * once done with it ({@link deleteOwnFile}) so it doesn't pile up in the
 * account's storage quota. Falls back to the capped share preview if any of this
 * fails. The login cookie is fetched at RUNTIME from the Worker's token-gated
 * `?cookie=1` endpoint (so a rotated cookie needs only a `wrangler secret put`,
 * no app rebuild), cached in SQLite as a backup, and falls back to
 * `EXPO_PUBLIC_TERABOX_COOKIE`. See {@link ensureTeraboxCookie}.
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

import { Storage, StorageKeys } from "@/lib/storage";

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
// Must match the domain the login cookie is valid for — TeraBox sessions are
// domain-bound (1024tera.com and 1024terabox.com are DIFFERENT registrable
// domains, not subdomains of one parent, so a cookie captured on one 404s
// "user not login" on the other). The Worker has used 1024terabox.com all
// along and every resolve/sharedownload call there has succeeded with this
// cookie — so the on-device resolve targets the same, proven domain.
const H5_ORIGIN = "https://www.1024terabox.com";

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
 * Optional full cookie header for a logged-in TeraBox account (same value as the
 * Worker's `TERABOX_COOKIE`: `lang=…; ndus=…; ndut_fmt=…; csrfToken=…; browserid=…`).
 * When set, the on-device resolve and `/share/streaming` run LOGGED-IN from the
 * phone's residential IP — which returns the FULL-LENGTH transcode instead of the
 * ~4-minute anonymous preview. (The datacenter Worker can't do this: its
 * server IP is blocked at the streaming endpoint. The device isn't.) The cookie
 * expires periodically — refresh it the same way you refresh the Worker's.
 */
/** Optional env fallback for the cookie (last resort; usually empty). */
const TERABOX_COOKIE_ENV = process.env.EXPO_PUBLIC_TERABOX_COOKIE ?? "";

/**
 * The active logged-in cookie for on-device requests, resolved at RUNTIME so a
 * rotated cookie doesn't need an app rebuild. Populated by
 * {@link ensureTeraboxCookie} in priority order: Worker → SQLite cache → env.
 * Starts at the env value so anonymous/offline still has a sane default.
 */
let activeCookie = TERABOX_COOKIE_ENV;
/** Whether the runtime cookie load has been attempted this session. */
let cookieLoaded = false;

/** Whether an on-device logged-in session is available. */
export function isTeraboxLoggedIn(): boolean {
  return !!activeCookie;
}

/** The cookie's names (no values) for logs. */
function cookieNamesOf(cookie: string): string {
  return cookie
    .split(";")
    .map((p) => p.trim().split("=")[0])
    .filter(Boolean)
    .join(",");
}

/**
 * Load the logged-in cookie used for on-device requests. Fetches it from the
 * Worker (the fresh source of truth — so a rotated cookie is picked up on the
 * next launch with NO app rebuild), caches it to SQLite as a backup for when the
 * Worker is unreachable, and falls back to the env var. Runs once per session
 * (pass `force` to re-fetch, e.g. after an auth failure). Safe to call anywhere
 * before a resolve/stream; the result feeds {@link teraboxHeaders}.
 */
export async function ensureTeraboxCookie(force = false): Promise<void> {
  if (cookieLoaded && !force) return;
  cookieLoaded = true;

  // 1. Worker — needs the proxy URL + token (the cookie endpoint is token-gated).
  if (TERABOX_PROXY_URL && TERABOX_PROXY_TOKEN) {
    try {
      const base = TERABOX_PROXY_URL.replace(/\/$/, "");
      const res = await fetch(
        `${base}/?cookie=1&token=${encodeURIComponent(TERABOX_PROXY_TOKEN)}`,
      );
      const json = (await res.json()) as { cookie?: string };
      if (json.cookie) {
        activeCookie = json.cookie;
        try {
          await Storage.setItem(StorageKeys.teraboxCookie, json.cookie);
        } catch {
          // caching is best-effort
        }
        console.log(
          `[terabox] cookie: from worker (names=[${cookieNamesOf(json.cookie)}])`,
        );
        return;
      }
      console.warn("[terabox] cookie: worker returned no cookie");
    } catch (err) {
      console.warn("[terabox] cookie: worker fetch failed:", String(err));
    }
  }

  // 2. SQLite cache — backup when the Worker is down/unreachable.
  try {
    const cached = await Storage.getItem(StorageKeys.teraboxCookie);
    if (cached) {
      activeCookie = cached;
      console.log(
        `[terabox] cookie: from cache (names=[${cookieNamesOf(cached)}])`,
      );
      return;
    }
  } catch {
    // ignore
  }

  // 3. Env fallback (already the initial value).
  console.log(
    `[terabox] cookie: ${activeCookie ? `env fallback (names=[${cookieNamesOf(activeCookie)}])` : "none (anonymous)"}`,
  );
}

/**
 * One-time diagnostic: confirm the cookie is actually recognized as a real
 * logged-in session (not merely accepted-but-ignored), and log any VIP/tier
 * field TeraBox returns — the ~4-min transcode cap may be a VIP-only feature
 * rather than a login gate, in which case a free account stays capped even
 * logged in. `/api/quota` is a lightweight endpoint that errnos out (-6 "user
 * not login") for an invalid/expired cookie, so a clean `errno:0` here proves
 * the session itself is good, isolating the cap question to account tier.
 */
export async function logTeraboxAccountInfo(): Promise<void> {
  if (!activeCookie) return;
  try {
    const res = await fetch(
      `${H5_ORIGIN}/api/quota?checkfree=1&checkexpire=1&${API_BASE_QS}`,
      { headers: teraboxHeaders() },
    );
    const text = await res.text();
    console.log(`[terabox] account quota check: status=${res.status} body=${snippet(text, 500)}`);
  } catch (err) {
    console.warn("[terabox] account quota check failed:", String(err));
  }
}

/**
 * TeraBox caps SHARE streaming to a short preview (see the module doc) — but
 * playing/downloading a file already in your OWN drive isn't capped. So for a
 * logged-in session, we replicate the site's own "Save" flow: copy the shared
 * file into a folder in your account, stream/download it from there, then
 * delete the copy. Confirmed via a captured browser session (chrome net-export)
 * showing `GET /api/streaming?path=<ownPath>&type=...` — no shareid/uk/sign,
 * just the file's own path — returning multiple real transcode segments where
 * the anonymous/share preview only ever returns one capped object.
 */
const OWN_DRIVE_FOLDER = "/ModernVideoPlayer";

type OwnFile = { path: string; fsId: string };

/** Files already copied into the account this session, keyed by share fs_id. */
const ownDriveCache = new Map<string, OwnFile>();

/**
 * The CSRF-style `bdstoken` needed for mutating own-drive calls (create/delete;
 * `transfer` works without it). Cached for the session — like `jsToken`, it's
 * embedded in a logged-in account page's HTML, not returned by any JSON API, so
 * we fetch a normal page and regex it out.
 */
let bdsToken = "";

async function ensureBdsToken(origin: string): Promise<string> {
  if (bdsToken) return bdsToken;
  for (const path of ["/main", "/disk/home", "/"]) {
    try {
      const res = await fetch(`${origin}${path}`, { headers: teraboxHeaders() });
      const html = await res.text();
      const m = /bdstoken["']?\s*[:=]\s*["']([0-9a-f]{32})["']/.exec(html);
      console.log(
        `[terabox] bdstoken try ${path}: status=${res.status} htmlLen=${html.length} found=${!!m}`,
      );
      if (m) {
        bdsToken = m[1];
        return bdsToken;
      }
    } catch (err) {
      console.warn(`[terabox] bdstoken fetch ${path} failed:`, String(err));
    }
  }
  return "";
}

/**
 * Copy a shared file into the account's own drive (mirrors the site's "Save"
 * button: `/api/create` to ensure the destination folder, then
 * `/share/transfer` to do the copy). Cached per share fs_id for the session, so
 * watching then downloading the same file doesn't save it twice. Throws
 * {@link TeraboxError} if the copy fails.
 */
async function saveShareToOwnDrive(file: TeraboxFile): Promise<OwnFile> {
  const cached = ownDriveCache.get(file.fsId);
  if (cached) return cached;

  const token = await ensureBdsToken(file.origin);
  const referer = `${file.origin}/`;

  // Ensure the destination folder exists. errno!=0 here (e.g. "already exists")
  // is non-fatal — the transfer call below is what actually matters.
  try {
    const createRes = await fetch(
      `${file.origin}/api/create?${API_BASE_QS}&a=commit&bdstoken=${encodeURIComponent(token)}&jsToken=${encodeURIComponent(file.jsToken)}&dp-logid=`,
      {
        method: "POST",
        headers: teraboxHeaders({
          Referer: referer,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body:
          `path=${encodeURIComponent(OWN_DRIVE_FOLDER)}&isdir=1&method=post` +
          `&dataType=json&bdstoken=${encodeURIComponent(token)}`,
      },
    );
    const createJson = (await createRes.json()) as { errno?: number };
    console.log(`[terabox] own-drive create folder: errno=${createJson.errno}`);
  } catch (err) {
    console.warn("[terabox] own-drive create folder failed (continuing):", String(err));
  }

  let transferJson: {
    errno?: number;
    errmsg?: string;
    extra?: { list?: { to?: string; to_fs_id?: number | string }[] };
  };
  try {
    const transferRes = await fetch(
      `${file.origin}/share/transfer?${API_BASE_QS}&ondup=newcopy&async=1` +
        `&scene=purchased_list&bdstoken=&shareid=${encodeURIComponent(file.shareid)}` +
        `&from=${encodeURIComponent(file.uk)}&jsToken=${encodeURIComponent(file.jsToken)}&dp-logid=`,
      {
        method: "POST",
        headers: teraboxHeaders({
          Referer: referer,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body:
          `fsidlist=${encodeURIComponent(`["${file.fsId}"]`)}` +
          `&path=${encodeURIComponent(OWN_DRIVE_FOLDER)}`,
      },
    );
    transferJson = await transferRes.json();
  } catch (err) {
    console.warn("[terabox] own-drive transfer failed:", String(err));
    throw new TeraboxError("Couldn't save this share to your TeraBox drive.");
  }
  const entry = transferJson.extra?.list?.[0];
  console.log(
    `[terabox] own-drive transfer: errno=${transferJson.errno} errmsg=${transferJson.errmsg ?? ""} ` +
      `to=${entry?.to} to_fs_id=${entry?.to_fs_id}`,
  );
  if (transferJson.errno !== 0 || !entry?.to) {
    throw new TeraboxError("Couldn't save this share to your TeraBox drive.");
  }

  const owned: OwnFile = { path: entry.to, fsId: String(entry.to_fs_id) };
  ownDriveCache.set(file.fsId, owned);
  return owned;
}

/** Best-effort cleanup: delete a file previously copied into the own drive. */
async function deleteOwnFile(origin: string, shareFsId: string, owned: OwnFile): Promise<void> {
  ownDriveCache.delete(shareFsId);
  try {
    const token = await ensureBdsToken(origin);
    const res = await fetch(
      `${origin}/api/filemanager?${API_BASE_QS}&opera=delete&async=1&onnest=fail` +
        `&bdstoken=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: teraboxHeaders({
          Referer: `${origin}/`,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: `filelist=${encodeURIComponent(`["${owned.path}"]`)}`,
      },
    );
    const json = (await res.json()) as { errno?: number };
    console.log(`[terabox] own-drive cleanup: errno=${json.errno} path=${owned.path}`);
  } catch (err) {
    console.warn("[terabox] own-drive cleanup failed (non-fatal):", String(err));
  }
}

/**
 * Fetch the HLS manifest for a file already in the own drive. Unlike a share's
 * `/share/streaming`, this needs only the file's own `path` — no shareid/uk/sign
 * — and (per a captured logged-in session) isn't capped to a short preview.
 */
async function fetchOwnFileManifest(
  origin: string,
  path: string,
  quality: TeraboxQuality,
): Promise<string> {
  const type = HLS_TYPES[quality] ?? HLS_TYPES["480"];
  const url =
    `${origin}/api/streaming?path=${encodeURIComponent(path)}` +
    `&app_id=250528&clienttype=0&type=${type}&vip=0`;
  const res = await fetch(url, { headers: teraboxHeaders({ Referer: `${origin}/` }) });
  const text = await res.text();
  console.log(`[terabox] own-file streaming: status=${res.status} len=${text.length}`);
  return text;
}

/** Standard headers for on-device TeraBox requests, incl. the login cookie if set. */
function teraboxHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": TERABOX_USER_AGENT,
    ...(activeCookie ? { Cookie: activeCookie } : {}),
    ...extra,
  };
}

/** Cookie summary for logs — names + length only, never the secret values. */
function cookieDiag(): string {
  if (!activeCookie) return "none (anonymous)";
  return `len=${activeCookie.length} names=[${cookieNamesOf(activeCookie)}]`;
}

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
  await ensureTeraboxCookie();
  const pageUrl = `${H5_ORIGIN}/sharing/link?surl=${encodeURIComponent(surl)}`;
  console.log(
    `[terabox] resolve start: surl=${surl} loggedIn=${isTeraboxLoggedIn()} cookie=${cookieDiag()}`,
  );
  if (isTeraboxLoggedIn()) await logTeraboxAccountInfo();

  let pageRes: Response;
  let html: string;
  try {
    pageRes = await fetch(pageUrl, { headers: teraboxHeaders() });
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
  console.log(
    `[terabox] page: status=${pageRes.status} finalUrl=${pageRes.url} ` +
      `htmlLen=${html.length} jsToken=${jsToken ? `found(${jsToken.length})` : "NONE"}`,
  );
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
  const apiHeaders = teraboxHeaders({ Referer: pageUrl });

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

  console.log(
    `[terabox] shorturlinfo: errno=${info.errno} shareid=${info.shareid ?? "?"} ` +
      `uk=${info.uk ?? "?"} sign=${info.sign ? "yes" : "no"} listLen=${info.list?.length ?? 0}`,
  );
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

/** Build the `/share/streaming` HLS manifest URL for a raw transcode `type`. */
function streamingUrlForType(file: TeraboxFile, type: string): string {
  return (
    `${file.origin}/share/streaming?uk=${encodeURIComponent(file.uk)}` +
    `&shareid=${encodeURIComponent(file.shareid)}&type=${type}` +
    `&fid=${encodeURIComponent(file.fsId)}&sign=${encodeURIComponent(file.sign)}` +
    `&timestamp=${encodeURIComponent(file.timestamp)}` +
    `&jsToken=${encodeURIComponent(file.jsToken)}` +
    `&isplayer=1&esl=1&ehps=1&${API_BASE_QS}`
  );
}

/** Build the authenticated `/share/streaming` HLS manifest URL for a file. */
function streamingUrl(file: TeraboxFile, quality: TeraboxQuality): string {
  return streamingUrlForType(file, HLS_TYPES[quality] ?? HLS_TYPES["480"]);
}

/**
 * Fetch the transcoded HLS manifest via the proxy Worker in its LOGGED-IN
 * session — which returns the FULL-LENGTH transcode, not the ~4-min anonymous
 * preview the device gets. Returns `null` (so the caller falls back to the
 * on-device anonymous fetch) if the proxy isn't configured, errors, or the
 * cookie is expired. The manifest's segments are open-CDN URLs the device
 * fetches directly, so only the manifest needs the login.
 */
async function fetchHlsManifestViaProxy(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<string | null> {
  if (!TERABOX_PROXY_URL) return null;
  const base = TERABOX_PROXY_URL.replace(/\/$/, "");
  const url =
    `${base}/?hls=1&quality=${encodeURIComponent(quality)}` +
    `&${originalContextQs(file)}${proxyTokenQs()}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (text.trim().startsWith("#EXTM3U")) {
      console.log("[terabox] HLS manifest via proxy (logged-in, full length)");
      return text;
    }
    console.warn("[terabox] proxy HLS not a manifest:", snippet(text, 160));
    return null;
  } catch (err) {
    console.warn("[terabox] proxy HLS fetch failed:", String(err));
    return null;
  }
}

/** Result of fetching an HLS manifest: the text, plus the own-drive copy if one was made. */
type ManifestFetch = { text: string; ownFile?: OwnFile };

/** Parse `{errno, errmsg}` out of a non-manifest JSON error body, best-effort. */
function parseStreamingError(text: string): { errno: unknown; errmsg: unknown } {
  try {
    const j = JSON.parse(text);
    return { errno: j.errno, errmsg: j.errmsg };
  } catch {
    return { errno: undefined, errmsg: undefined };
  }
}

/**
 * Fetch the capped anonymous/share `/share/streaming` preview directly (or the
 * proxy Worker's logged-in manifest, when there's no on-device cookie at all).
 * Extracted so the multi-sample loop in {@link fetchFullStream} can call this
 * directly once the own-drive path is known to be failing, instead of retrying
 * (and re-failing) the own-drive save on every sample. Throws
 * {@link TeraboxError} if nothing playable comes back.
 */
async function fetchAnonymousManifest(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<ManifestFetch> {
  if (!activeCookie) {
    const viaProxy = await fetchHlsManifestViaProxy(file, quality);
    if (viaProxy) return { text: viaProxy };
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(streamingUrl(file, quality), {
      headers: teraboxHeaders({ Referer: `${file.origin}/` }),
    });
    text = await res.text();
  } catch (err) {
    console.warn("[terabox] streaming fetch failed:", String(err));
    throw new TeraboxError("Couldn't reach TeraBox. Check your connection.");
  }
  const isManifest = text.trim().startsWith("#EXTM3U");
  console.log(
    `[terabox] streaming: status=${res.status} len=${text.length} ` +
      `isManifest=${isManifest} ts_size=${isManifest ? manifestTsSize(text) : 0}`,
  );
  if (!isManifest) {
    const { errno, errmsg } = parseStreamingError(text);
    console.warn(
      `[terabox] streaming q=${quality} not a manifest: errno=${errno} errmsg=${errmsg} body=${snippet(text)}`,
    );
    throw new TeraboxError(
      quality === "480"
        ? "Couldn't get a playable stream for this file."
        : `The ${quality}p stream isn't available for this share.`,
    );
  }
  return { text };
}

/**
 * Fetch the transcoded HLS manifest text for a file. When logged in, saves the
 * share to the own drive first and streams it from there — TeraBox caps SHARE
 * streaming to a short preview regardless of login, but an owned file isn't
 * capped (confirmed via a captured browser session). Falls back to the
 * anonymous/share `/share/streaming` (or the proxy Worker) if that fails for any
 * reason, so watch/download still works, just capped. Throws {@link TeraboxError}
 * only if every path fails.
 */
async function fetchHlsManifest(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<ManifestFetch> {
  if (activeCookie) {
    console.log(`[terabox] hls fetch: q=${quality} path=on-device logged-in (own-drive)`);
    try {
      const owned = await saveShareToOwnDrive(file);
      const text = await fetchOwnFileManifest(file.origin, owned.path, quality);
      if (text.trim().startsWith("#EXTM3U")) {
        return { text, ownFile: owned };
      }
      const { errno, errmsg } = parseStreamingError(text);
      console.warn(
        `[terabox] own-file streaming q=${quality} not a manifest: errno=${errno} errmsg=${errmsg} body=${snippet(text)}`,
      );
      // Own copy didn't help — clean it up and fall through to the share path.
      await deleteOwnFile(file.origin, file.fsId, owned);
    } catch (err) {
      console.warn("[terabox] own-drive flow failed, falling back:", String(err));
    }
  } else {
    console.log(`[terabox] hls fetch: q=${quality} path=on-device anonymous`);
  }
  return fetchAnonymousManifest(file, quality);
}

/** The `ts_size` (full transcode size) advertised by a manifest's segments. */
function manifestTsSize(manifest: string): number {
  return Number(/[?&]ts_size=(\d+)/.exec(manifest)?.[1] ?? 0);
}

/**
 * How many times to sample `/share/streaming` before committing. TeraBox hands
 * back transcode objects of *varying* size for the same video across calls
 * (observed 6.3 MB vs 8.4 MB); sampling a few and keeping the largest avoids
 * paging a needlessly short one.
 */
const STREAM_SAMPLE_ATTEMPTS = 4;

/**
 * Fetch the transcoded stream for a file, full-length if possible.
 *
 * When logged in, {@link fetchHlsManifest} streams from a copy in the account's
 * own drive — per a captured browser session this manifest already covers the
 * real duration (multiple distinct transcode objects), unlike a share's capped
 * preview, so it's used as-is with no further paging. The `ownFile` is returned
 * so the caller can delete the copy once done with it.
 *
 * Otherwise (no cookie, own-drive save failed, or the manifest still looks like
 * a short single-object preview) falls back to sampling the anonymous/share
 * endpoint a few times — it hands back a different-sized transcode object per
 * call — and expanding the largest one's byte-range window to cover it fully
 * (see {@link expandTranscodedManifest}); still capped to that object's length.
 */
async function fetchFullStream(
  file: TeraboxFile,
  quality: TeraboxQuality,
): Promise<FullManifest> {
  await ensureTeraboxCookie();
  console.log(
    `[terabox] fetchFullStream: q=${quality} loggedIn=${isTeraboxLoggedIn()}`,
  );

  const first = await fetchHlsManifest(file, quality);
  if (first.ownFile) {
    // Own-drive manifest: trust it as the real, un-truncated playlist.
    const segments = hlsSegmentUrls(first.text, file.origin);
    logManifestDiagnostics(first.text, null, quality);
    console.log(
      `[terabox] own-drive manifest: ${segments.length} segment(s), ` +
        `ts_size(s) seen=${[...new Set(first.text.match(/[?&]ts_size=(\d+)/g) ?? [])].join(",")}`,
    );
    return { manifest: first.text, segments, ownFile: first.ownFile };
  }

  // Anonymous/share fallback (own-drive failed, or no cookie at all): each call
  // returns a different-sized, differently-windowed capped object — sample a
  // few and keep the largest before expanding it, rather than committing to
  // whatever random window the first call happened to return.
  const attempts = STREAM_SAMPLE_ATTEMPTS;
  let sample = first.text;
  let bestTs = manifestTsSize(first.text);
  for (let i = 1; i < attempts; i++) {
    // Own-drive already failed on `first` — go straight to the anonymous/share
    // fetch instead of re-attempting (and re-failing) the own-drive save again.
    const candidate = await fetchAnonymousManifest(file, quality);
    const ts = manifestTsSize(candidate.text);
    if (ts > bestTs) {
      bestTs = ts;
      sample = candidate.text;
    }
  }
  console.log(`[terabox] picked largest object: ts_size=${bestTs}`);

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
type FullManifest = {
  manifest: string;
  segments: string[];
  /** Set when streamed from a copy in the own drive — the caller should delete it once done. */
  ownFile?: OwnFile;
};

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

  const previewRange = /[?&]range=([\d-]+)/.exec(template)?.[1] ?? "?";
  console.log(
    `[terabox] expand: ts_size=${tsSize} bytes/s=${bytesPerSecond.toFixed(0)} ` +
      `window=${windowBytes} previewRange=${previewRange} previewLen=${totalLen}`,
  );

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
/** How long to leave a watch's own-drive copy before cleaning it up. */
const WATCH_CLEANUP_DELAY_MS = 15 * 60 * 1000;

export async function prepareTeraboxWatchUri(
  file: TeraboxFile,
  quality: TeraboxQuality = "480",
): Promise<string> {
  try {
    const { manifest, ownFile } = await fetchFullStream(file, quality);
    const local = new File(cacheDir(), `play_${file.fsId}_${quality}.m3u8`);
    if (local.exists) local.delete();
    local.write(manifest);
    if (ownFile) {
      // Segment URLs are signed/CDN-hosted, not re-checked against the account
      // per request, so deleting the own-drive copy after a viewing-sized delay
      // (rather than the moment playback starts) is safe and avoids leaving it
      // in the account if the app is closed mid-watch.
      console.log(`[terabox] own-drive cleanup for watch scheduled in ${WATCH_CLEANUP_DELAY_MS / 60000}min`);
      setTimeout(() => {
        void deleteOwnFile(file.origin, file.fsId, ownFile);
      }, WATCH_CLEANUP_DELAY_MS);
    }
    return local.uri;
  } catch (err) {
    console.warn("[terabox] watch prepare failed, trying dlink:", String(err));
    return teraboxStreamUrl(file);
  }
}

/** `&token=` query fragment for the proxy Worker, if a token is configured. */
function proxyTokenQs(): string {
  return TERABOX_PROXY_TOKEN
    ? `&token=${encodeURIComponent(TERABOX_PROXY_TOKEN)}`
    : "";
}

/**
 * The device-resolved share context, passed to the Worker so it can call
 * `/api/sharedownload` with its own cookie WITHOUT resolving the share page
 * itself — the Worker's server-side resolve is dead (TeraBox serves datacenter
 * IPs a stub page). The device does the residential-IP resolve; the Worker only
 * supplies the login cookie.
 */
function originalContextQs(file: TeraboxFile): string {
  const p = (v: string) => encodeURIComponent(v ?? "");
  return (
    `surl=${p(file.surl)}&fs_id=${p(file.fsId)}` +
    `&shareid=${p(file.shareid)}&uk=${p(file.uk)}&sign=${p(file.sign)}` +
    `&timestamp=${p(file.timestamp)}&jsToken=${p(file.jsToken)}` +
    `&fn=${p(file.filename)}`
  );
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
  return `${base}/?${originalContextQs(file)}${proxyTokenQs()}`;
}

/** Result of preflighting the ORIGINAL download against the Worker. */
export type OriginalAvailability =
  | { ok: true }
  | { ok: false; reason: "no_proxy" | "cookie_expired" | "error"; message?: string };

/**
 * Preflight the ORIGINAL download: ask the Worker to resolve a dlink with its
 * cookie (no file transfer). Distinguishes an expired/invalid server cookie
 * (`cookie_expired` → the UI prompts to refresh it) from other failures, so a
 * background download isn't started only to save a broken error-page file.
 */
export async function checkTeraboxOriginal(
  file: TeraboxFile,
): Promise<OriginalAvailability> {
  if (!TERABOX_PROXY_URL) return { ok: false, reason: "no_proxy" };
  const base = TERABOX_PROXY_URL.replace(/\/$/, "");
  const url = `${base}/?resolve=1&${originalContextQs(file)}${proxyTokenQs()}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      errno?: number;
      errmsg?: string;
      error?: string;
    };
    if (json.ok) return { ok: true };
    if (json.reason === "cookie_expired") {
      return { ok: false, reason: "cookie_expired" };
    }
    return {
      ok: false,
      reason: "error",
      message: json.error ?? json.errmsg ?? `errno ${json.errno ?? "?"}`,
    };
  } catch (err) {
    console.warn("[terabox] original preflight failed:", String(err));
    return { ok: false, reason: "error", message: String(err) };
  }
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
  const { segments, ownFile } = await fetchFullStream(file, quality);
  if (segments.length === 0) {
    throw new TeraboxError("This stream has no segments to download.");
  }

  // We now know the transcode's true size, so progress is exact. An own-drive
  // manifest can span several distinct transcode objects (each with its own
  // ts_size), so sum the distinct sizes rather than trusting just segments[0].
  const tsSize = [
    ...new Set(segments.map((s) => numParam(s, "ts_size")).filter(Boolean)),
  ].reduce((a, b) => a + b, 0);
  console.log(
    `[terabox] download: ${segments.length} segment(s), target ts_size=${tsSize}`,
  );

  if (dest.exists) dest.delete();
  dest.create();
  const handle = dest.open(FileMode.Append);
  let written = 0;
  let shortSegments = 0;
  try {
    for (let i = 0; i < segments.length; i++) {
      const expected = numParam(segments[i], "len");
      let buf: ArrayBuffer;
      let status = 0;
      try {
        const res = await fetch(segments[i]);
        status = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = await res.arrayBuffer();
      } catch (err) {
        console.warn(
          `[terabox] download: segment ${i + 1}/${segments.length} failed ` +
            `(status=${status}): ${String(err)}`,
        );
        throw new TeraboxError(
          `Download interrupted (segment ${i + 1}/${segments.length}). Try again.`,
        );
      }
      // Log any segment whose body doesn't match the requested byte range — a
      // silent truncation (CDN honouring only part of the range) shows up here.
      if (expected && buf.byteLength !== expected) {
        console.warn(
          `[terabox] download: segment ${i + 1} short — got ${buf.byteLength}B, ` +
            `expected ${expected}B (status=${status})`,
        );
        shortSegments++;
      }
      handle.writeBytes(new Uint8Array(buf));
      written += buf.byteLength;
      onProgress?.(written, tsSize || written);
    }
  } finally {
    handle.close();
  }
  console.log(
    `[terabox] download done: wrote ${written}B of ts_size=${tsSize} ` +
      `(${shortSegments} short segment(s))`,
  );

  if (ownFile) {
    // Download has every byte on disk now — safe to clean up the own-drive copy.
    await deleteOwnFile(file.origin, file.fsId, ownFile);
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

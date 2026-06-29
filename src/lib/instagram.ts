/**
 * Download videos and images from Instagram reels/posts to a public folder.
 *
 * For personal/offline use. As of 2026 Instagram serves a login wall to every
 * anonymous request, so extraction now requires a logged-in session. We get one
 * by running the request *inside* a WebView the user has logged into (see
 * components/instagram-webview.tsx): the page-context fetch automatically carries
 * the session cookies, including the httpOnly `sessionid`. This module holds the
 * shared constants, the response parser, and the download/save step (the signed
 * CDN media URL itself downloads fine without cookies).
 *
 * Saves land in a "Mordern Video Player" folder at the storage root via the
 * native raw-Java copy (expo-file-system refuses to write to shared storage even
 * with the all-files grant — same constraint the WhatsApp status saver hits, see
 * lib/whatsapp-status.ts). On iOS, where that folder concept doesn't apply, the
 * media goes to the gallery via expo-media-library instead.
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { Directory, File, Paths } from "expo-file-system";
import { Asset } from "expo-media-library";
import { Platform } from "react-native";

import { copyToPublicDir } from "@modules/all-files-access";
import {
  isBackgroundDownloadAvailable,
  startBackgroundDownload,
} from "@modules/media-downloader";

/** Public folder, at the storage root, that downloads are saved into (Android). */
export const SAVE_DIR = "/storage/emulated/0/Mordern Video Player/Instagram";

/** Instagram's public web App ID (stable; sent by the official web client). */
export const IG_APP_ID = "936619743392459";

/**
 * Decode a shortcode to its numeric media id. Instagram shortcodes are the post's
 * media id encoded in url-safe base64, so the media id (needed for the private
 * `/api/v1/media/{id}/info/` endpoint) is a plain base64 decode back to an
 * integer. Uses BigInt because media ids exceed Number.MAX_SAFE_INTEGER. Returns
 * null if the shortcode contains a character outside the alphabet.
 */
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortcodeToMediaId(shortcode: string): string | null {
  let id = 0n;
  for (const ch of shortcode) {
    const value = SHORTCODE_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    id = id * 64n + BigInt(value);
  }
  return id.toString();
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** A single downloadable item from a post (a post may be a carousel of several). */
export type InstagramItem = {
  type: "video" | "image";
  /** Direct CDN URL of the .mp4 (video) or .jpg (image). */
  url: string;
  /** Preview image URL (a video's poster, or the image itself). */
  thumbnail: string | null;
  width: number;
  height: number;
};

export type InstagramMedia = {
  shortcode: string;
  /** Post owner's username, used to name saved files. */
  username: string | null;
  items: InstagramItem[];
};

/** Raised for any expected failure so the UI can show a friendly message. */
export class InstagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramError";
  }
}

/** Pull the shortcode out of a /p/, /reel/, /reels/, or /tv/ URL. */
function extractShortcode(url: string): string | null {
  const match = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Resolve the shortcode for a pasted URL. Handles direct post/reel URLs and
 * follows `instagram.com/share/...` links (which 30x-redirect to the real post)
 * by letting `fetch` follow the redirect and reading the final URL. The redirect
 * target's shortcode is all we need — the (walled) page body is ignored.
 */
export async function resolveShortcode(rawUrl: string): Promise<string> {
  const url = rawUrl.trim();
  const direct = extractShortcode(url);
  if (direct) {
    console.log(`[instagram] shortcode from URL: ${direct}`);
    return direct;
  }

  console.log(`[instagram] no shortcode in URL, resolving redirect: ${url}`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    console.log(`[instagram] redirect resolved to: ${res.url}`);
    const fromRedirect = extractShortcode(res.url);
    if (fromRedirect) return fromRedirect;
  } catch (err) {
    console.warn("[instagram] redirect resolve failed:", String(err));
  }
  throw new InstagramError(
    "That doesn't look like an Instagram post or reel link.",
  );
}

/** One media item from the `/api/v1/media/{id}/info/` response. */
type MediaInfoItem = {
  /** Highest-quality first; the entry's `url` is the playable mp4. */
  video_versions?: { url?: string; width?: number; height?: number }[];
  /** Highest-quality first; used as the poster for videos and the file for images. */
  image_versions2?: {
    candidates?: { url?: string; width?: number; height?: number }[];
  };
  /** Present on carousel posts; each child is itself a media item. */
  carousel_media?: MediaInfoItem[];
  user?: { username?: string };
};

/**
 * Turn a media-info item into an InstagramItem. Prefers the video stream; falls
 * back to the still image so photo posts (and image slides in a carousel) are
 * downloadable too. Returns null only if neither is present.
 */
function toItem(item: MediaInfoItem): InstagramItem | null {
  const video = item.video_versions?.[0];
  const image = item.image_versions2?.candidates?.[0];
  if (video?.url) {
    return {
      type: "video",
      url: video.url,
      thumbnail: image?.url ?? null,
      width: video.width ?? 0,
      height: video.height ?? 0,
    };
  }
  if (image?.url) {
    return {
      type: "image",
      url: image.url,
      thumbnail: image.url,
      width: image.width ?? 0,
      height: image.height ?? 0,
    };
  }
  return null;
}

/** Compact preview of a long string for logs. */
function snippet(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max
    ? `${clean.slice(0, max)}…(${text.length} chars)`
    : clean;
}

/**
 * Parse the raw body of an `/api/v1/media/{id}/info/` response (fetched inside
 * the logged-in WebView) into the post's downloadable items (videos and images).
 * Throws {@link InstagramError} with a user-facing message if the body isn't
 * usable JSON, has no media (private/invalid/login wall), or has nothing to save.
 */
export function parseMediaInfoResponse(
  text: string,
  shortcode: string,
): InstagramMedia {
  let json: { items?: MediaInfoItem[] };
  try {
    json = JSON.parse(text);
  } catch {
    console.warn("[instagram] response not JSON:", snippet(text));
    throw new InstagramError(
      "Couldn't read this post. Make sure you're connected and try again.",
    );
  }

  const item = json?.items?.[0];
  if (!item) {
    console.warn("[instagram] no media item; body:", snippet(text));
    throw new InstagramError(
      "Couldn't read this post. It may be private, age-restricted, or the link is invalid.",
    );
  }

  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  const items = nodes.map(toItem).filter((i): i is InstagramItem => i !== null);

  console.log(
    `[instagram] parsed ${nodes.length} node(s), ${items.length} item(s), owner=${item.user?.username}`,
  );
  if (items.length === 0) {
    throw new InstagramError("This post has no media to download.");
  }

  return { shortcode, username: item.user?.username ?? null, items };
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

/** The saved file's name for an item — `baseName` with the type's extension. */
function itemFileNameWithExt(item: InstagramItem, baseName: string): string {
  return `${baseName}.${item.type === "video" ? "mp4" : "jpg"}`;
}

/**
 * Whether Instagram items can be saved as true background downloads (Android's
 * DownloadManager: survives backgrounding, shows a system progress notification).
 * When false, callers fall back to {@link saveInstagramItem}'s foreground download.
 */
export function instagramBackgroundDownloadAvailable(): boolean {
  return isBackgroundDownloadAvailable();
}

/**
 * Enqueue an Instagram item as a system background download. The signed CDN URL is
 * fetched by the OS directly (no cookies needed) and the finished file is moved
 * into {@link SAVE_DIR}. Returns the download id — match it against the
 * progress/complete events from `@modules/media-downloader`. Android-only; the
 * caller must hold the all-files grant first (see ensurePermission).
 */
export async function startInstagramDownload(
  item: InstagramItem,
  baseName: string,
): Promise<number> {
  const filename = itemFileNameWithExt(item, baseName);
  return startBackgroundDownload({
    url: item.url,
    fileName: filename,
    destPath: `${SAVE_DIR}/${filename}`,
    mimeType: item.type === "video" ? "video/mp4" : "image/jpeg",
  });
}

/** Cache dir downloads land in before being moved to their final location. */
function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, "instagram");
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
 * a previous download. Mirrors the WhatsApp status saver's behaviour.
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

/**
 * Download one item and save it. On Android it's copied into the public
 * {@link SAVE_DIR} folder via the native raw-Java copy (which also media-scans
 * it so it shows in the gallery) — this needs the all-files grant. On iOS it goes
 * to the photo library via expo-media-library. The temporary cache file is always
 * removed. Returns the saved path/asset id. Throws {@link InstagramError}.
 */
export async function saveInstagramItem(
  item: InstagramItem,
  baseName: string,
): Promise<string> {
  const filename = itemFileNameWithExt(item, baseName);
  console.log(`[instagram] downloading ${filename} (${item.type})`);

  let downloaded: File | null = null;
  try {
    // Clear any leftover from a previous attempt so the download doesn't fail
    // on an already-existing destination.
    const dest = new File(cacheDir(), filename);
    if (dest.exists) dest.delete();
    downloaded = await File.downloadFileAsync(item.url, dest);
  } catch (err) {
    console.warn("[instagram] download failed:", err);
    throw new InstagramError(
      "Download failed. The media link may have expired.",
    );
  }

  try {
    if (Platform.OS === "android") {
      const destPath = uniqueDestPath(filename);
      const saved = await copyToPublicDir(uriToPath(downloaded.uri), destPath);
      console.log(`[instagram] saved to folder: ${saved}`);
      return saved;
    }
    const asset = await Asset.create(downloaded.uri);
    console.log(`[instagram] saved to gallery: ${asset.id}`);
    return asset.id;
  } catch (err) {
    console.warn("[instagram] save failed:", err);
    throw new InstagramError("Couldn't save the media to your device.");
  } finally {
    try {
      downloaded.delete();
    } catch {
      // best-effort cleanup of the cache copy
    }
  }
}

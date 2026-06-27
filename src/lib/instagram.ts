/**
 * Download videos from Instagram reels/posts and save them to the gallery.
 *
 * For personal/offline use. As of 2026 Instagram serves a login wall to every
 * anonymous request (GraphQL, post page, and embed alike), so extraction now
 * requires a logged-in session. We get one by running the GraphQL query *inside*
 * a WebView the user has logged into (see components/instagram-webview.tsx): the
 * page-context fetch automatically carries the session cookies, including the
 * httpOnly `sessionid`. This module holds the shared constants, the response
 * parser, and the download/save step (the CDN video URL itself is signed and
 * downloads fine without cookies).
 *
 * The {@link GRAPHQL_DOC_ID} is undocumented and rotated by Instagram every few
 * weeks — if fetching suddenly fails for posts that are definitely public, that's
 * the first thing to refresh.
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { Directory, File, Paths } from "expo-file-system";
import { Asset } from "expo-media-library";

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

/** A single downloadable video extracted from a post (a post may be a carousel). */
export type InstagramVideo = {
  /** Direct CDN URL of the .mp4. */
  url: string;
  /** Poster image URL, or null. */
  thumbnail: string | null;
  width: number;
  height: number;
};

export type InstagramMedia = {
  shortcode: string;
  /** Post owner's username, used to name saved files. */
  username: string | null;
  videos: InstagramVideo[];
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
  image_versions2?: { candidates?: { url?: string }[] };
  /** Present on carousel posts; each child is itself a media item. */
  carousel_media?: MediaInfoItem[];
  user?: { username?: string };
};

/** Turn a media-info item into an InstagramVideo if it carries a video. */
function toVideo(item: MediaInfoItem): InstagramVideo | null {
  const version = item.video_versions?.[0];
  if (!version?.url) return null;
  return {
    url: version.url,
    thumbnail: item.image_versions2?.candidates?.[0]?.url ?? null,
    width: version.width ?? 0,
    height: version.height ?? 0,
  };
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
 * the logged-in WebView) into the post's downloadable videos. Throws
 * {@link InstagramError} with a user-facing message if the body isn't usable
 * JSON, has no media (private/invalid/login wall), or contains no video.
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
  const videos = nodes
    .map(toVideo)
    .filter((v): v is InstagramVideo => v !== null);

  console.log(
    `[instagram] parsed ${nodes.length} node(s), ${videos.length} video(s), owner=${item.user?.username}`,
  );
  if (videos.length === 0) {
    throw new InstagramError("This post doesn't contain a video to download.");
  }

  return { shortcode, username: item.user?.username ?? null, videos };
}

/** Cache dir downloads land in before being copied into the gallery. */
function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, "instagram");
  if (!dir.exists) dir.create();
  return dir;
}

/**
 * Download one video and save it to the device gallery via expo-media-library
 * (`Asset.create`), which needs only the standard media permission and works on
 * both iOS and Android. The temporary cache file is removed afterwards. Returns
 * the created asset's id. Throws {@link InstagramError} on failure.
 */
export async function saveInstagramVideo(
  video: InstagramVideo,
  baseName: string,
): Promise<string> {
  const filename = `${baseName}.mp4`;
  console.log(`[instagram] downloading ${filename}`);

  let downloaded: File | null = null;
  try {
    // Clear any leftover from a previous attempt so the download doesn't fail
    // on an already-existing destination.
    const dest = new File(cacheDir(), filename);
    if (dest.exists) dest.delete();
    downloaded = await File.downloadFileAsync(video.url, dest);
  } catch (err) {
    console.warn("[instagram] download failed:", err);
    throw new InstagramError(
      "Download failed. The video link may have expired.",
    );
  }

  try {
    const asset = await Asset.create(downloaded.uri);
    console.log(`[instagram] saved to gallery: ${asset.id}`);
    return asset.id;
  } catch (err) {
    console.warn("[instagram] save-to-gallery failed:", err);
    throw new InstagramError("Couldn't save the video to your gallery.");
  } finally {
    try {
      downloaded.delete();
    } catch {
      // best-effort cleanup of the cache copy
    }
  }
}

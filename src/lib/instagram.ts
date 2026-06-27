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
 * GraphQL `doc_id` for the `PolarisPostActionLoadPostQueryQuery` (shortcode →
 * media). Undocumented and rotated by Instagram periodically — if downloads start
 * failing with "couldn't read this post", this is the first thing to refresh.
 */
export const GRAPHQL_DOC_ID = "10015901848480474";

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

type ShortcodeMediaNode = {
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  dimensions?: { width?: number; height?: number };
};

type ShortcodeMedia = ShortcodeMediaNode & {
  owner?: { username?: string };
  edge_sidecar_to_children?: { edges?: { node: ShortcodeMediaNode }[] };
};

/** Turn a raw media node into an InstagramVideo if it actually is a video. */
function toVideo(node: ShortcodeMediaNode): InstagramVideo | null {
  if (!node.is_video || !node.video_url) return null;
  return {
    url: node.video_url,
    thumbnail: node.display_url ?? null,
    width: node.dimensions?.width ?? 0,
    height: node.dimensions?.height ?? 0,
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
 * Parse the raw body of a `xdt_shortcode_media` GraphQL response (fetched inside
 * the logged-in WebView) into the post's downloadable videos. Throws
 * {@link InstagramError} with a user-facing message if the body isn't usable
 * JSON, has no media (private/invalid/login wall), or contains no video.
 */
export function parseMediaResponse(
  text: string,
  shortcode: string,
): InstagramMedia {
  let json: { data?: { xdt_shortcode_media?: ShortcodeMedia } };
  try {
    json = JSON.parse(text);
  } catch {
    console.warn("[instagram] response not JSON:", snippet(text));
    throw new InstagramError(
      "Couldn't read this post. Make sure you're connected and try again.",
    );
  }

  const media = json?.data?.xdt_shortcode_media ?? null;
  if (!media) {
    console.warn(
      "[instagram] no xdt_shortcode_media; data keys:",
      JSON.stringify(Object.keys(json?.data ?? {})),
      "| body:",
      snippet(text),
    );
    throw new InstagramError(
      "Couldn't read this post. It may be private, age-restricted, or the link is invalid.",
    );
  }

  const children = media.edge_sidecar_to_children?.edges?.map((e) => e.node);
  const nodes = children?.length ? children : [media];
  const videos = nodes
    .map(toVideo)
    .filter((v): v is InstagramVideo => v !== null);

  console.log(
    `[instagram] parsed ${nodes.length} node(s), ${videos.length} video(s), owner=${media.owner?.username}`,
  );
  if (videos.length === 0) {
    throw new InstagramError("This post doesn't contain a video to download.");
  }

  return { shortcode, username: media.owner?.username ?? null, videos };
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

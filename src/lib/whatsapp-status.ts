/**
 * Browsing WhatsApp "statuses" and saving them to a public folder.
 *
 * WhatsApp caches every status the user has viewed in a hidden `.Statuses`
 * folder, where it auto-expires after 24h. This module scans those folders,
 * lists the images/videos inside, and copies the chosen ones into a public
 * "WhatsApp Status Saver" folder at the storage root before WhatsApp clears
 * them.
 *
 * Android only. iOS WhatsApp does not expose statuses to other apps and there is
 * no shared `.Statuses` path, so {@link listStatuses} returns `[]` there.
 *
 * The `.Statuses` folder is a hidden dot-folder; scoped media permissions never
 * surface it, so reading requires all-files access (MANAGE_EXTERNAL_STORAGE) —
 * the same grant the Archives screen uses (see use-storage-permission.ts).
 *
 * Operation split (important, mirrors archives.ts):
 *   - list → expo-file-system *new* API `Directory.list()`  (reads fine)
 *   - save → native `copyToPublicDir` (raw java.io)          (writes)
 *
 * Why a native copy: expo-file-system (BOTH the new and legacy APIs) enforce a
 * scoped-storage guard and refuse to create/write in Android shared storage even
 * with the OS all-files grant — they fail with "Location isn't writable". With
 * the grant held, plain `java.io` works, so the copy lives in the all-files
 * native module (the same approach `react-native-zip-archive` uses to extract
 * into shared storage). `expo-media-library`'s `Asset.create` was tried first
 * but couldn't reliably read WhatsApp's `Android/media/...` source and copies
 * into MediaStore's own location rather than the folder the user asked for.
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 */
import { Directory, File } from "expo-file-system";
import { Platform } from "react-native";

import { copyToPublicDir } from "@modules/all-files-access";

const BASE = "/storage/emulated/0";

/** Public folder saved statuses are copied into (raw, decoded path). */
export const SAVE_DIR = `${BASE}/WhatsApp Status Saver`;

/**
 * Candidate `.Statuses` directories, as *raw* decoded paths. We scan all that
 * exist: the modern (Android 11+) scoped `Android/media` location and the legacy
 * top-level one, for both WhatsApp and WhatsApp Business.
 */
const STATUS_DIRS = [
  `${BASE}/Android/media/com.whatsapp/WhatsApp/Media/.Statuses`,
  `${BASE}/WhatsApp/Media/.Statuses`,
  `${BASE}/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses`,
  `${BASE}/WhatsApp Business/Media/.Statuses`,
];

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
const VIDEO_EXTS = [".mp4", ".3gp", ".mkv", ".mov"];

export type StatusType = "image" | "video";

export type StatusFile = {
  /** `file://` URI of the status file. */
  uri: string;
  /** Filename including extension. */
  name: string;
  type: StatusType;
  /** Size in bytes, or null when unavailable. */
  size: number | null;
  /** Last-modified time in ms since epoch, or 0 when unavailable. */
  modificationTime: number;
};

/**
 * Build a valid `file://` URI from a raw absolute path by percent-encoding each
 * path segment. expo-file-system's `Directory`/`File` parse their argument as a
 * `java.net.URI` on Android, which throws on raw spaces or `[` `]` — common in
 * media filenames — so the path must be encoded before it's handed over.
 */
function pathToUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Strip the `file://` scheme and percent-decode a URI into a raw absolute path
 * for the native copy (which operates on plain java.io paths). Inverse of
 * {@link pathToUri}.
 */
function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

/** The media type for a filename by extension, or null if it isn't media. */
function statusTypeForName(name: string): StatusType | null {
  const lower = name.toLowerCase();
  if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) return "image";
  if (VIDEO_EXTS.some((ext) => lower.endsWith(ext))) return "video";
  return null;
}

/** Images/videos in a single `.Statuses` directory. Returns [] if unreadable. */
function listDir(dir: string): StatusFile[] {
  try {
    const directory = new Directory(pathToUri(dir));
    if (!directory.exists) {
      console.log(`[status] dir absent: ${dir}`);
      return [];
    }
    const entries = directory.list();
    const media = entries
      .filter((entry): entry is File => entry instanceof File)
      .map((file): StatusFile | null => {
        const type = statusTypeForName(file.name);
        if (!type) return null;
        return {
          uri: file.uri,
          name: file.name,
          type,
          size: file.size ?? null,
          modificationTime: file.modificationTime ?? 0,
        };
      })
      .filter((s): s is StatusFile => s !== null);
    console.log(
      `[status] ${dir}: ${entries.length} entries, ${media.length} media`,
    );
    return media;
  } catch (err) {
    // No all-files access yet, or the folder doesn't exist — surfaced to the
    // user as an empty list + grant button.
    console.warn(
      `[status] failed to list ${dir}:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return [];
  }
}

/**
 * All WhatsApp/Business statuses currently cached on the device, newest first.
 * De-duplicated by filename (the same status can appear under more than one of
 * the candidate paths). Returns [] on non-Android or without access.
 */
export function listStatuses(): StatusFile[] {
  if (Platform.OS !== "android") return [];

  console.log("[status] scanning status folders…");
  const byName = new Map<string, StatusFile>();
  for (const dir of STATUS_DIRS) {
    for (const status of listDir(dir)) {
      if (!byName.has(status.name)) byName.set(status.name, status);
    }
  }

  const result = [...byName.values()].sort(
    (a, b) => b.modificationTime - a.modificationTime,
  );
  console.log(`[status] found ${result.length} unique status file(s)`);
  return result;
}

/**
 * A raw destination path under {@link SAVE_DIR} for `name` that doesn't exist
 * yet, inserting ` (1)`, ` (2)`, … before the extension so re-saving the same
 * status never overwrites a previous copy. Existence is checked with the new
 * File API (a read, which the all-files grant permits).
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
 * Copy a status into the public {@link SAVE_DIR} folder via the native raw-Java
 * copy (expo-file-system can't write to shared storage — see the file header).
 * Creates the folder on first use and triggers a media scan so the file shows
 * up in the gallery. Throws if the copy fails. Returns the destination path.
 */
export async function saveStatus(status: StatusFile): Promise<string> {
  console.log(`[status] save start: ${status.name} (${status.uri})`);

  const fromPath = uriToPath(status.uri);
  const destPath = uniqueDestPath(status.name);
  console.log(`[status] copying ${fromPath} -> ${destPath}`);
  const saved = await copyToPublicDir(fromPath, destPath);
  console.log(`[status] save OK: ${saved}`);
  return saved;
}

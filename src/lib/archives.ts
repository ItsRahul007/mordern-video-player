/**
 * Browsing and extracting local `.zip` archives.
 *
 * Where we look depends on the platform:
 *   - Android → the public Downloads folder (requires all-files access).
 *   - iOS     → the app's Documents folder (visible in the Files app; iOS has
 *               no shared Downloads folder, so this is the natural drop spot).
 *
 * Operation split (important): expo-file-system's *new* API enforces its own
 * scoped-storage guard and refuses to write/create in Android shared storage
 * even when the OS has granted all-files access (MANAGE_EXTERNAL_STORAGE). So we
 * use the right tool per task:
 *   - list   → expo-file-system new API `Directory.list()`   (reads fine)
 *   - extract→ react-native-zip-archive `unzip()`            (raw Java + OS grant)
 *   - delete → expo-file-system `File.delete()`
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 */
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { subscribe, unzip } from "react-native-zip-archive";

import { scanFolder } from "@modules/all-files-access";

/**
 * Raw filesystem path of the folder we browse/extract in. Kept as a *decoded*
 * path (no `file://`, no percent-encoding) because react-native-zip-archive
 * operates on raw Java paths. Build a `file://` URI from it with `pathToUri`
 * whenever the expo-file-system API needs one.
 */
export const ARCHIVES_DIR =
  Platform.OS === "android"
    ? "/storage/emulated/0/Download"
    : plainPath(Paths.document.uri);

export type ZipFile = {
  /** `file://` URI of the archive. */
  uri: string;
  /** Filename including the `.zip` extension. */
  name: string;
  /** Size in bytes, or null when unavailable. */
  size: number | null;
};

/**
 * react-native-zip-archive operates on raw filesystem paths, while
 * expo-file-system hands back percent-encoded `file://` URIs (e.g. `%20` for a
 * space, `%5B` for `[`). Strip the scheme AND decode so the native unzip finds
 * the real file instead of a literal `%20`-laden path.
 */
function plainPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/\/$/, "");
}

/**
 * Build a valid `file://` URI from a raw absolute path by percent-encoding each
 * path segment. expo-file-system's `Directory`/`File` parse their argument as a
 * `java.net.URI` on Android, which throws on raw spaces or `[` `]` — common in
 * downloaded filenames — so the path must be encoded before it's handed over.
 */
function pathToUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * A sub-folder path under {@link ARCHIVES_DIR} for `baseName` that doesn't exist
 * yet, appending ` (1)`, ` (2)`, … if needed — so re-extracting never
 * overwrites a previous extraction. Returns a *raw* path (for `unzip`).
 */
function uniqueExtractionDir(baseName: string): string {
  let candidate = `${ARCHIVES_DIR}/${baseName}`;
  let suffix = 1;
  while (new Directory(pathToUri(candidate)).exists) {
    candidate = `${ARCHIVES_DIR}/${baseName} (${suffix})`;
    suffix++;
  }
  return candidate;
}

/** All `.zip` files in {@link ARCHIVES_DIR}, sorted A–Z. Returns [] if unreadable. */
export function listZipFiles(): ZipFile[] {
  try {
    const entries = new Directory(pathToUri(ARCHIVES_DIR)).list();
    return entries
      .filter((entry): entry is File => entry instanceof File)
      .filter((file) => file.name.toLowerCase().endsWith(".zip"))
      .map((file) => ({
        uri: file.uri,
        name: file.name,
        size: file.size ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // No all-files access yet (Android) — surfaced to the user as an empty list
    // + grant button.
    return [];
  }
}

/**
 * Extract `zip` into a sibling folder named after the archive (minus `.zip`).
 * `unzip` creates the target directory itself (mkdirs) and reads/writes via raw
 * Java, so it works with the OS all-files grant. Reports 0–1 progress; returns
 * the target folder path.
 */
export async function extractZip(
  zip: ZipFile,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const sourcePath = plainPath(zip.uri);
  // `zip.name` is already decoded, so the folder gets real characters (spaces,
  // brackets). Pick a fresh name if a folder of that name already exists.
  const folderName = zip.name.replace(/\.zip$/i, "");
  const targetPath = uniqueExtractionDir(folderName);

  const sub = subscribe(({ progress }) => onProgress?.(progress));
  try {
    // `unzip` writes via raw java.io, leaving the extracted files absent from
    // MediaStore — so the videos wouldn't appear in the library (or in a
    // sibling dev/preview build, a separate package) until the OS happened to
    // scan them. Index them explicitly so they're immediately visible to every
    // app with media-read permission.
    const dir = await unzip(sourcePath, targetPath);
    await scanFolder(dir);
    return dir;
  } finally {
    sub.remove();
  }
}

/** Permanently delete the archive file. */
export async function deleteZip(zip: ZipFile): Promise<void> {
  new File(zip.uri).delete();
}
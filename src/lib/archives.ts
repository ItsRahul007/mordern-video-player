/**
 * Browsing and extracting local `.zip` archives in the device's public Downloads
 * folder. Android-only — iOS has no shared Downloads folder.
 *
 * Operation split (important): expo-file-system's *new* API enforces its own
 * scoped-storage guard and refuses to write/create in shared storage even when
 * the OS has granted all-files access (MANAGE_EXTERNAL_STORAGE). So we use the
 * right tool per task:
 *   - list   → expo-file-system new API `Directory.list()`   (reads fine)
 *   - extract→ react-native-zip-archive `unzip()`            (raw Java + OS grant)
 *   - delete → expo-file-system *legacy* `deleteAsync()`     (no new-API guard)
 * https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/
 */
import { Directory, File } from "expo-file-system";
import { subscribe, unzip } from "react-native-zip-archive";

/** Public Downloads folder on Android. */
export const DOWNLOADS_DIR = "/storage/emulated/0/Download";

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
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

/**
 * A Downloads sub-folder path for `baseName` that doesn't exist yet, appending
 * ` (1)`, ` (2)`, … if needed — so re-extracting never overwrites a previous
 * extraction.
 */
function uniqueDownloadDir(baseName: string): string {
  let candidate = `${DOWNLOADS_DIR}/${baseName}`;
  let suffix = 1;
  while (new Directory(`file://${candidate}`).exists) {
    candidate = `${DOWNLOADS_DIR}/${baseName} (${suffix})`;
    suffix++;
  }
  return candidate;
}

/**
 * Whether the Downloads folder is readable — a reliable proxy for all-files
 * access. With the grant, `list()` returns the folder's full contents; without
 * it, it returns nothing. (Downloads is realistically never empty, so a truly
 * empty folder reading as "no access" is a tolerable, harmless edge case.)
 */
export function downloadsReadable(): boolean {
  try {
    return new Directory(`file://${DOWNLOADS_DIR}`).list().length > 0;
  } catch {
    return false;
  }
}

/** All `.zip` files in the Downloads folder, sorted A–Z. Returns [] if unreadable. */
export function listZipFiles(): ZipFile[] {
  try {
    const entries = new Directory(`file://${DOWNLOADS_DIR}`).list();
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
    // No all-files access yet — surfaced to the user as an empty list + grant button.
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
  const targetPath = uniqueDownloadDir(folderName);

  const sub = subscribe(({ progress }) => onProgress?.(progress));
  try {
    return await unzip(sourcePath, targetPath);
  } finally {
    sub.remove();
  }
}

/** Permanently delete the archive file. */
export async function deleteZip(zip: ZipFile): Promise<void> {
  new File(zip.uri).delete();
}

import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Native bridge for sharing one *or many* files through Android's system share
 * sheet. expo-sharing (and the Web Share API it wraps) only ever shares a single
 * file, so multi-select share isn't possible through it. This module builds an
 * `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent natively, exposing each file via
 * a FileProvider content URI so the receiving app can read it.
 *
 * Optional so non-Android platforms (where the module isn't built) resolve to
 * `null` instead of throwing at import time.
 */
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{
        shareFiles(paths: string[], mimeType: string | null): Promise<number>;
      }>("ShareFiles")
    : null;

/**
 * Open the system share sheet for the given files. `paths` are raw absolute
 * paths — no `file://` scheme, already decoded (see `fileUriToPath`). `mimeType`
 * narrows the list of target apps (e.g. `"video/*"`); pass `null` for any type.
 * Files that no longer exist on disk are skipped. Resolves to the number of
 * files actually offered to the share sheet. Android-only.
 */
export async function shareFiles(
  paths: string[],
  mimeType: string | null = null,
): Promise<number> {
  if (!native) throw new Error("shareFiles is only available on Android");
  return native.shareFiles(paths, mimeType);
}

/** Whether native multi-file sharing is available on this platform/build. */
export function canShareFiles(): boolean {
  return native != null;
}

/**
 * Convert a `file://` URI (as returned by expo-media-library on Android) into a
 * raw, decoded absolute path, which is what {@link shareFiles} expects. Tolerates
 * malformed percent-escapes, and leaves non-`file://` strings untouched.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const path = uri.slice("file://".length);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

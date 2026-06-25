import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Native bridge for Android's MANAGE_EXTERNAL_STORAGE grant state. Optional so
 * non-Android platforms (where the module isn't built) resolve to `null`
 * instead of throwing at import time.
 */
const native = Platform.OS === "android"
  ? requireOptionalNativeModule<{
      isGranted(): boolean;
      copyToPublicDir(from: string, to: string): Promise<string>;
    }>("AllFilesAccess")
  : null;

/**
 * Whether the app currently holds all-files access. Returns `true` on
 * platforms/versions without the concept (iOS, Android ≤10) so callers fall
 * back to their normal listing logic there.
 */
export function isAllFilesAccessGranted(): boolean {
  return native?.isGranted() ?? true;
}

/**
 * Copy a file into Android shared storage via raw java.io (honours the
 * all-files grant where expo-file-system refuses). `from`/`to` are raw absolute
 * paths — no `file://` scheme, already decoded. Returns the destination path.
 * Android-only.
 */
export async function copyToPublicDir(from: string, to: string): Promise<string> {
  if (!native) throw new Error("copyToPublicDir is only available on Android");
  return native.copyToPublicDir(from, to);
}

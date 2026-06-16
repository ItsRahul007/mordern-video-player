import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Native bridge for Android's MANAGE_EXTERNAL_STORAGE grant state. Optional so
 * non-Android platforms (where the module isn't built) resolve to `null`
 * instead of throwing at import time.
 */
const native = Platform.OS === "android"
  ? requireOptionalNativeModule<{ isGranted(): boolean }>("AllFilesAccess")
  : null;

/**
 * Whether the app currently holds all-files access. Returns `true` on
 * platforms/versions without the concept (iOS, Android ≤10) so callers fall
 * back to their normal listing logic there.
 */
export function isAllFilesAccessGranted(): boolean {
  return native?.isGranted() ?? true;
}

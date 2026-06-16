package expo.modules.allfilesaccess

import android.os.Build
import android.os.Environment
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Exposes the real MANAGE_EXTERNAL_STORAGE ("all files access") grant state to
 * JS. There is no first-party Expo/RN JS API for this, and inferring it from a
 * directory listing is unreliable — the app can list Downloads via its scoped
 * media/legacy read permissions even when all-files access was never granted.
 */
class AllFilesAccessModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AllFilesAccess")

    // Synchronous: cheap OS check, called while rendering the archives screen.
    Function("isGranted") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Android 11+ : the dedicated all-files-access toggle.
        Environment.isExternalStorageManager()
      } else {
        // Android 10 and below have no MANAGE_EXTERNAL_STORAGE; raw external
        // reads are governed by READ_EXTERNAL_STORAGE, so let the listing be
        // the source of truth instead of gating behind a grant that can't exist.
        true
      }
    }
  }
}

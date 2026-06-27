package expo.modules.allfilesaccess

import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Exposes the real MANAGE_EXTERNAL_STORAGE ("all files access") grant state to
 * JS, plus a raw-Java file copy into shared storage.
 *
 * There is no first-party Expo/RN JS API for the grant state, and inferring it
 * from a directory listing is unreliable — the app can list Downloads via its
 * scoped media/legacy read permissions even when all-files access was never
 * granted.
 *
 * The copy exists because expo-file-system (both the new and legacy APIs)
 * refuses to create/write in Android shared storage even when the OS has granted
 * all-files access (it enforces its own scoped-storage guard, failing with
 * "Location isn't writable"). With the grant held, plain `java.io` works, so we
 * copy bytes ourselves — the same approach `react-native-zip-archive` uses to
 * extract into shared storage.
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

    // Copy a file into shared storage via raw java.io (honours the all-files
    // grant). `from`/`to` are raw absolute paths — NO `file://` scheme, already
    // decoded. Creates parent directories, then asks the media scanner to index
    // the result so it shows up in the gallery / file managers. Returns `to`.
    // Async so the byte copy runs off the JS thread.
    AsyncFunction("copyToPublicDir") { from: String, to: String ->
      val source = File(from)
      val dest = File(to)
      dest.parentFile?.mkdirs()
      source.inputStream().use { input ->
        dest.outputStream().use { output -> input.copyTo(output) }
      }

      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      MediaScannerConnection.scanFile(context, arrayOf(dest.absolutePath), null, null)

      dest.absolutePath
    }

    // Recursively index every file under `path` into MediaStore. Needed after
    // react-native-zip-archive's `unzip()`, which writes via raw java.io and so
    // leaves the extracted videos absent from MediaStore — invisible to the
    // media library until the OS happens to scan them, and invisible to OTHER
    // apps/packages entirely (e.g. a sibling dev/preview build). A scan inserts
    // them into the shared, world-readable media collections. `path` is a raw
    // absolute path — NO `file://` scheme, already decoded. Returns the number
    // of files submitted to the scanner. Async so the walk runs off the JS thread.
    AsyncFunction("scanFolder") { path: String ->
      val files = File(path).walkTopDown()
        .filter { it.isFile }
        .map { it.absolutePath }
        .toList()
      if (files.isNotEmpty()) {
        val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
        MediaScannerConnection.scanFile(context, files.toTypedArray(), null, null)
      }
      files.size
    }
  }
}

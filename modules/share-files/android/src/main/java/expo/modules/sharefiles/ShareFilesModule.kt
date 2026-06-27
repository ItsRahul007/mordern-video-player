package expo.modules.sharefiles

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Shares one or many files through the Android system share sheet.
 *
 * expo-sharing can only ever share a single file, so multi-select share isn't
 * possible through the first-party API. Here we build the intent ourselves:
 * `ACTION_SEND` for one file, `ACTION_SEND_MULTIPLE` for several. Each file is
 * exposed via a FileProvider content:// URI (raw `file://` URIs throw
 * `FileUriExposedException` on Android 7+), and the read grant is attached both
 * as a flag and through the intent's ClipData so it reliably covers every URI.
 */
class ShareFilesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareFiles")

    // `paths` are raw absolute paths — NO `file://` scheme, already decoded.
    // `mimeType` narrows the target apps (e.g. "video/*"); null falls back to a
    // permissive "*/*". Async so building URIs / touching disk stays off the JS
    // thread. Returns the number of files actually offered to the share sheet.
    AsyncFunction("shareFiles") { paths: List<String>, mimeType: String? ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val authority = context.packageName + ".sharefilesprovider"

      val uris = ArrayList<Uri>()
      for (path in paths) {
        val file = File(path)
        if (!file.exists()) continue
        uris.add(FileProvider.getUriForFile(context, authority, file))
      }
      if (uris.isEmpty()) throw NoShareableFilesException()

      val type = mimeType ?: "*/*"
      val sendIntent = if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).apply {
          putExtra(Intent.EXTRA_STREAM, uris[0])
          setType(type)
        }
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).apply {
          putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          setType(type)
        }
      }

      // ClipData makes the read grant apply to every URI on all OS versions,
      // not just the first EXTRA_STREAM entry.
      val clip = ClipData.newUri(context.contentResolver, "Shared files", uris[0])
      for (i in 1 until uris.size) clip.addItem(ClipData.Item(uris[i]))
      sendIntent.clipData = clip
      sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

      val chooser = Intent.createChooser(sendIntent, null).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      // Prefer launching from the current Activity so the sheet sits over the
      // app; fall back to the application context (needs NEW_TASK) if there's no
      // foreground Activity.
      val activity = appContext.currentActivity
      if (activity != null) {
        activity.startActivity(chooser)
      } else {
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
      }

      uris.size
    }
  }
}

private class NoShareableFilesException :
  CodedException("None of the selected files could be found on disk")

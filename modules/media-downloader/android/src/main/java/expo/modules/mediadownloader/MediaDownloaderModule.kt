package expo.modules.mediadownloader

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Background file downloads via Android's system DownloadManager.
 *
 * expo-file-system's downloads run inside the app's JS process: they stall or die
 * when the OS suspends the app, and offer no notification. DownloadManager instead
 * runs the transfer in a system process — it survives the app being backgrounded
 * or killed — and posts its own progress notification for free.
 *
 * DownloadManager can only write to app-private or sanctioned public dirs, not to
 * an arbitrary shared-storage path like "/storage/emulated/0/Mordern Video
 * Player/…". So we download into the app's external-files cache (no permission
 * needed), then move the finished file to its final shared-storage path via raw
 * java.io — the same approach AllFilesAccessModule.copyToPublicDir uses, and which
 * needs the all-files grant the caller already ensures before enqueuing.
 *
 * The id→final-path mapping is persisted in SharedPreferences so a completion that
 * lands while the app was dead is still moved — call `flushCompleted()` on launch
 * to reconcile those. Live downloads emit `onProgress`/`onComplete` to JS.
 */
class MediaDownloaderModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val downloadManager: DownloadManager
    get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  private val handler = Handler(Looper.getMainLooper())
  private var receiver: BroadcastReceiver? = null
  private var polling = false

  override fun definition() = ModuleDefinition {
    Name("MediaDownloader")
    Events("onProgress", "onComplete")

    OnCreate { registerReceiver() }

    OnDestroy {
      receiver?.let { r ->
        try {
          appContext.reactContext?.unregisterReceiver(r)
        } catch (_: Exception) {
          // already unregistered / context gone — nothing to do
        }
      }
      receiver = null
      handler.removeCallbacksAndMessages(null)
      polling = false
    }

    // Enqueue a download. `url` is fetched by the system DownloadManager (so for
    // TeraBox this must be the proxy URL — a raw dlink would 403 without the
    // session cookie the manager can't send). `fileName` titles the notification
    // and names the saved file. `destPath` is the raw absolute shared-storage path
    // the finished file is moved to (deduped with " (1)", " (2)", …). `mimeType`
    // is optional. Returns the DownloadManager id (also used to match events).
    AsyncFunction("download") { url: String, fileName: String, destPath: String, mimeType: String? ->
      val ctx = context
      val safe = sanitize(fileName)
      val request = DownloadManager.Request(Uri.parse(url)).apply {
        setTitle(fileName)
        setDescription("Saving to Mordern Video Player")
        setNotificationVisibility(
          DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
        )
        if (!mimeType.isNullOrEmpty()) setMimeType(mimeType)
        setAllowedOverRoaming(true)
        // Temp location in the app's own external-files dir — always writable,
        // no storage permission required. The real path is read back via
        // COLUMN_LOCAL_URI on completion, so the unique prefix only avoids
        // clobbering a concurrent download of the same name.
        setDestinationInExternalFilesDir(
          ctx,
          Environment.DIRECTORY_DOWNLOADS,
          "mvp_${nowMillis()}_$safe",
        )
      }

      val id = downloadManager.enqueue(request)
      pendingPrefs(ctx).edit().putString(id.toString(), destPath).apply()
      startPolling()
      id.toDouble()
    }

    // Reconcile downloads that finished while the app wasn't listening (e.g. it was
    // killed mid-download): move any persisted-but-completed file to its final
    // path. Safe to call on every launch. Returns the number of pending ids seen.
    AsyncFunction("flushCompleted") {
      val ctx = context
      val ids = pendingPrefs(ctx).all.keys.mapNotNull { it.toLongOrNull() }
      for (id in ids) handleComplete(id)
      startPolling()
      ids.size
    }
  }

  /** SharedPreferences holding `downloadId -> finalDestPath` for in-flight saves. */
  private fun pendingPrefs(ctx: Context) =
    ctx.getSharedPreferences("media_downloader_pending", Context.MODE_PRIVATE)

  private fun registerReceiver() {
    if (receiver != null) return
    val ctx = appContext.reactContext ?: return
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) {
        val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
        if (id != -1L) handleComplete(id)
      }
    }
    // ACTION_DOWNLOAD_COMPLETE is a system broadcast (sender is the OS), so the
    // receiver must be exported on Android 13+.
    ContextCompat.registerReceiver(
      ctx,
      r,
      IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
      ContextCompat.RECEIVER_EXPORTED,
    )
    receiver = r
  }

  /** Poll DownloadManager for the bytes of every pending id and emit `onProgress`. */
  private fun startPolling() {
    if (polling) return
    polling = true
    handler.post(pollRunnable)
  }

  private val pollRunnable = object : Runnable {
    override fun run() {
      val ctx = appContext.reactContext
      if (ctx == null) {
        polling = false
        return
      }
      val ids = pendingPrefs(ctx).all.keys.mapNotNull { it.toLongOrNull() }
      if (ids.isEmpty()) {
        polling = false
        return
      }

      var active = 0
      val query = DownloadManager.Query().setFilterById(*ids.toLongArray())
      downloadManager.query(query)?.use { c ->
        val idCol = c.getColumnIndex(DownloadManager.COLUMN_ID)
        val statusCol = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
        val soFarCol = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
        val totalCol = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
        while (c.moveToNext()) {
          val status = c.getInt(statusCol)
          if (
            status == DownloadManager.STATUS_RUNNING ||
            status == DownloadManager.STATUS_PENDING ||
            status == DownloadManager.STATUS_PAUSED
          ) {
            active++
            val id = c.getLong(idCol)
            val written = c.getLong(soFarCol)
            val total = c.getLong(totalCol)
            val pct = if (total > 0) ((written * 100) / total).toInt() else 0
            sendEvent(
              "onProgress",
              bundleOf(
                "id" to id.toDouble(),
                "written" to written.toDouble(),
                "total" to total.toDouble(),
                "pct" to pct,
              ),
            )
          }
        }
      }

      if (active > 0) {
        handler.postDelayed(this, 700)
      } else {
        polling = false
      }
    }
  }

  /**
   * Finalise one download: if it succeeded, move the temp file to its persisted
   * destination, media-scan it, and emit `onComplete`. No-op for ids we don't own
   * or that are still in flight; failures emit `onComplete` with success=false.
   */
  private fun handleComplete(id: Long) {
    val ctx = appContext.reactContext ?: return
    val prefs = pendingPrefs(ctx)
    val destPath = prefs.getString(id.toString(), null) ?: return

    var status = -1
    var localUri: String? = null
    var reason = 0
    downloadManager.query(DownloadManager.Query().setFilterById(id))?.use { c ->
      if (c.moveToFirst()) {
        status = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_STATUS))
        localUri = c.getString(c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI))
        reason = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_REASON))
      }
    }

    // Still downloading — leave it for the completion broadcast / next flush.
    if (
      status == DownloadManager.STATUS_RUNNING ||
      status == DownloadManager.STATUS_PENDING ||
      status == DownloadManager.STATUS_PAUSED
    ) {
      return
    }

    var success = false
    var finalPath: String? = null
    var error: String? = null
    try {
      if (status == DownloadManager.STATUS_SUCCESSFUL) {
        val temp = uriToFile(localUri)
        if (temp != null && temp.exists()) {
          val dest = uniqueDest(destPath)
          dest.parentFile?.mkdirs()
          temp.copyTo(dest, overwrite = false)
          temp.delete()
          MediaScannerConnection.scanFile(ctx, arrayOf(dest.absolutePath), null, null)
          success = true
          finalPath = dest.absolutePath
        } else {
          error = "The downloaded file is missing."
        }
      } else {
        error = "Download failed (reason $reason)."
      }
    } catch (e: Exception) {
      error = e.message ?: "Couldn't save the file."
    } finally {
      prefs.edit().remove(id.toString()).apply()
    }

    sendEvent(
      "onComplete",
      bundleOf(
        "id" to id.toDouble(),
        "success" to success,
        "path" to finalPath,
        "error" to error,
      ),
    )
  }

  private fun uriToFile(uri: String?): File? {
    if (uri == null) return null
    return try {
      Uri.parse(uri).path?.let { File(it) }
    } catch (_: Exception) {
      null
    }
  }

  /** First non-existing variant of `path`, inserting " (1)", " (2)", … before the ext. */
  private fun uniqueDest(path: String): File {
    var candidate = File(path)
    if (!candidate.exists()) return candidate
    val name = candidate.name
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    val parent = candidate.parent
    var i = 1
    while (candidate.exists()) {
      candidate = File("$parent/$base ($i)$ext")
      i++
    }
    return candidate
  }

  private fun sanitize(name: String): String =
    name.replace(Regex("[/\\\\:*?\"<>|]"), "_").trim().ifEmpty { "download" }

  // Wrapped so the JS-sandbox's Date restriction (which doesn't apply here) stays
  // a non-issue and the call site reads clearly.
  private fun nowMillis(): Long = System.currentTimeMillis()
}

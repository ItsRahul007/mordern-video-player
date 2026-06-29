import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** A removable event subscription (mirrors expo-modules-core's EventSubscription). */
export type Subscription = { remove(): void };

/** Live progress for an in-flight download. Bytes; `pct` is 0 until size is known. */
export type DownloadProgressEvent = {
  id: number;
  written: number;
  total: number;
  pct: number;
};

/** Terminal result for a download. On success `path` is the saved file. */
export type DownloadCompleteEvent = {
  id: number;
  success: boolean;
  path: string | null;
  error: string | null;
};

type MediaDownloaderModule = {
  download(
    url: string,
    fileName: string,
    destPath: string,
    mimeType: string | null,
  ): Promise<number>;
  flushCompleted(): Promise<number>;
  addListener(
    event: "onProgress",
    listener: (event: DownloadProgressEvent) => void,
  ): Subscription;
  addListener(
    event: "onComplete",
    listener: (event: DownloadCompleteEvent) => void,
  ): Subscription;
};

/**
 * Native bridge to Android's DownloadManager (see the Kotlin module). Optional so
 * iOS/web — where it isn't built — resolve to `null` instead of throwing at import.
 */
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<MediaDownloaderModule>("MediaDownloader")
    : null;

/**
 * Whether true background downloads (surviving app backgrounding, with a system
 * progress notification) are available. Android-only; callers fall back to a
 * foreground download elsewhere when this is false.
 */
export function isBackgroundDownloadAvailable(): boolean {
  return native != null;
}

/**
 * Enqueue a background download via the system DownloadManager. `url` is fetched
 * by the OS, so it must not need app-held cookies/headers. The finished file is
 * moved to `destPath` (a raw absolute shared-storage path), deduped if it exists.
 * Resolves to the download id, which matches the id on progress/complete events.
 * Android-only.
 */
export async function startBackgroundDownload(opts: {
  url: string;
  fileName: string;
  destPath: string;
  mimeType?: string | null;
}): Promise<number> {
  if (!native) {
    throw new Error("Background download is only available on Android");
  }
  return native.download(
    opts.url,
    opts.fileName,
    opts.destPath,
    opts.mimeType ?? null,
  );
}

/** Subscribe to byte-progress updates. Returns `null` (a no-op) off Android. */
export function addDownloadProgressListener(
  listener: (event: DownloadProgressEvent) => void,
): Subscription | null {
  return native?.addListener("onProgress", listener) ?? null;
}

/** Subscribe to download completions/failures. Returns `null` (a no-op) off Android. */
export function addDownloadCompleteListener(
  listener: (event: DownloadCompleteEvent) => void,
): Subscription | null {
  return native?.addListener("onComplete", listener) ?? null;
}

/**
 * Finalise any downloads that completed while the app wasn't listening (e.g. it
 * was killed mid-download) by moving them to their destinations. Call once on
 * launch / screen mount. No-op off Android; never throws.
 */
export async function flushCompletedDownloads(): Promise<void> {
  if (!native) return;
  try {
    await native.flushCompleted();
  } catch {
    // best-effort reconciliation
  }
}

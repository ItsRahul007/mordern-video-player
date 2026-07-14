import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { Icon } from "@/components/icon";
import { MessageSheet } from "@/components/message-sheet";
import { ThemedText } from "@/components/themed-text";
import { useMediaPermissions } from "@/hooks/use-permissions";
import {
  hasAllFilesAccess,
  useAllFilesAccess,
} from "@/hooks/use-storage-permission";
import { useTheme } from "@/hooks/use-theme";
import {
  TeraboxError,
  checkTeraboxOriginal,
  extractSurl,
  fetchShareInfo,
  formatSize,
  prepareTeraboxWatchUri,
  saveTeraboxFile,
  startTeraboxDownload,
  teraboxBackgroundDownloadAvailable,
  type TeraboxDownloadMode,
  type TeraboxFile,
  type TeraboxShare,
} from "@/lib/terabox";
import {
  addDownloadCompleteListener,
  addDownloadProgressListener,
  flushCompletedDownloads,
} from "@modules/media-downloader";

export default function TeraboxScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const { openSettings } = useAllFilesAccess();
  // A link shared into the app (TeraBox → Share → Video Player).
  const { sharedUrl } = useLocalSearchParams<{ sharedUrl?: string }>();

  const [url, setUrl] = useState(sharedUrl ?? "");
  const [fetching, setFetching] = useState(false);
  // Download source: "hls" is the fast transcoded stream (default); "original"
  // is the full-quality file but TeraBox throttles it hard for non-VIP accounts.
  const [downloadMode, setDownloadMode] = useState<TeraboxDownloadMode>("hls");
  // Which file is being prepared for online playback (resolving its stream).
  const [watchIndex, setWatchIndex] = useState<number | null>(null);
  // Set when the Worker reports its TeraBox cookie has expired (original mode).
  const [cookieExpired, setCookieExpired] = useState(false);

  // Android's DownloadManager gives real background downloads + a system progress
  // notification, but only for the single-URL "original" mode; HLS is fetched and
  // concatenated in-app (foreground). Elsewhere (iOS) everything is foreground.
  const bgAvailable = teraboxBackgroundDownloadAvailable(downloadMode);
  const [saving, setSaving] = useState(false);
  const [share, setShare] = useState<TeraboxShare | null>(null);
  // Per-file state for the foreground (iOS) download path — single-flight.
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [savedIndices, setSavedIndices] = useState<ReadonlySet<number>>(
    new Set(),
  );
  // Error shown in a bottom sheet (replaces system alerts).
  const [errorSheet, setErrorSheet] = useState<{
    title: string;
    message: string;
  } | null>(null);
  // The Android all-files permission prompt (shown as a bottom sheet).
  const [permissionSheet, setPermissionSheet] = useState(false);
  // Foreground download progress for the file currently saving (iOS path).
  const [dlProgress, setDlProgress] = useState<{
    index: number;
    written: number;
    total: number;
  } | null>(null);
  // Background (DownloadManager) progress, keyed by file index — many at once.
  const [bgProgress, setBgProgress] = useState<
    Record<number, { written: number; total: number; pct: number }>
  >({});

  const fetchingRef = useRef(false);
  const autoRan = useRef(false);
  // Throttle foreground progress state updates to whole-percent changes.
  const lastPct = useRef(-1);
  // Maps a live DownloadManager id back to the file index it's saving.
  const idToIndex = useRef<Map<number, number>>(new Map());

  // Build an onProgress callback for the file at `index`.
  const progressFor = useCallback(
    (index: number) => (written: number, total: number) => {
      const pct = total > 0 ? Math.floor((written / total) * 100) : -1;
      if (pct === lastPct.current) return;
      lastPct.current = pct;
      setDlProgress({ index, written, total });
    },
    [],
  );

  // Open the video for online playback. Resolves the fast transcoded HLS stream
  // on-device (writing a local .m3u8 whose segments stream straight from the CDN)
  // and hands the player its file URI; falls back to the throttled dlink.
  const onWatch = async (file: TeraboxFile, index: number) => {
    if (watchIndex !== null) return;
    setWatchIndex(index);
    try {
      const uri = await prepareTeraboxWatchUri(file);
      if (!uri) {
        setErrorSheet({
          title: "Can't play",
          message: "No playable URL for this file.",
        });
        return;
      }
      router.push({ pathname: "/player", params: { uri } });
    } catch (err) {
      console.warn("[terabox] watch failed:", err);
      setErrorSheet({
        title: "Can't play",
        message:
          err instanceof TeraboxError
            ? err.message
            : "Couldn't start playback. Please try again.",
      });
    } finally {
      setWatchIndex(null);
    }
  };

  // Preflight the "original" download against the Worker before starting, so an
  // expired server cookie surfaces as a clear warning instead of a broken file.
  // Returns whether the download may proceed. No-op for the "fast" (HLS) mode.
  const ensureOriginalOk = useCallback(
    async (file: TeraboxFile): Promise<boolean> => {
      if (downloadMode !== "original") return true;
      const check = await checkTeraboxOriginal(file);
      if (check.ok) {
        setCookieExpired(false);
        return true;
      }
      if (check.reason === "cookie_expired") {
        setCookieExpired(true);
        return false;
      }
      setErrorSheet({
        title: "Can't get original",
        message:
          check.reason === "no_proxy"
            ? "The download proxy isn't configured."
            : (check.message ?? "Couldn't resolve the original file. Try again."),
      });
      return false;
    },
    [downloadMode],
  );

  const runFetch = useCallback(async (link: string) => {
    const trimmed = link.trim();
    if (!trimmed || fetchingRef.current) return;
    fetchingRef.current = true;
    Keyboard.dismiss();
    setFetching(true);
    setShare(null);
    try {
      const surl = extractSurl(trimmed);
      if (!surl) {
        throw new TeraboxError("That doesn't look like a TeraBox share link.");
      }
      // Resolution happens in the proxy Worker (on the cookie's domain), so no
      // in-app TeraBox login is needed.
      const parsed = await fetchShareInfo(surl);
      setSavedIndices(new Set());
      setBgProgress({});
      idToIndex.current.clear();
      setShare(parsed);
    } catch (err) {
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn("[terabox] fetch failed:", detail);
      setErrorSheet({
        title: "Couldn't fetch files",
        message:
          err instanceof TeraboxError
            ? err.message
            : "Something went wrong. Please try again.",
      });
    } finally {
      fetchingRef.current = false;
      setFetching(false);
    }
  }, []);

  // Auto-fetch a link shared into the app.
  useEffect(() => {
    if (sharedUrl && !autoRan.current) {
      autoRan.current = true;
      void runFetch(sharedUrl);
    }
  }, [sharedUrl, runFetch]);

  // Subscribe to the background DownloadManager (Android) and reconcile any
  // downloads that finished while the screen wasn't mounted.
  useEffect(() => {
    if (!bgAvailable) return;
    const progress = addDownloadProgressListener((e) => {
      const index = idToIndex.current.get(e.id);
      if (index === undefined) return;
      setBgProgress((prev) => ({
        ...prev,
        [index]: { written: e.written, total: e.total, pct: e.pct },
      }));
    });
    const complete = addDownloadCompleteListener((e) => {
      const index = idToIndex.current.get(e.id);
      if (index === undefined) return;
      idToIndex.current.delete(e.id);
      setBgProgress((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      if (e.success) {
        setSavedIndices((prev) => new Set(prev).add(index));
      } else {
        setErrorSheet({
          title: "Save failed",
          message: e.error ?? "Couldn't save this file. Please try again.",
        });
      }
    });
    void flushCompletedDownloads();
    return () => {
      progress?.remove();
      complete?.remove();
    };
  }, [bgAvailable]);

  const onPaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setUrl(text.trim());
  };

  // Saving into the public "Mordern Video Player" folder uses the all-files
  // grant on Android; on iOS the media library permission covers it. Returns
  // whether saving may proceed (prompting for the missing grant otherwise).
  const ensurePermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      if (!hasAllFilesAccess()) {
        setPermissionSheet(true);
        return false;
      }
      return true;
    }
    if (!granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setErrorSheet({
          title: "Permission needed",
          message: "Allow access to your media library to save videos.",
        });
        return false;
      }
    }
    return true;
  }, [granted, requestPermission]);

  // Enqueue one file as a background download (Android). Non-blocking: progress
  // and completion arrive via the listeners above.
  const enqueueBackground = async (index: number) => {
    if (!share) return;
    try {
      const id = await startTeraboxDownload(share.files[index], downloadMode);
      idToIndex.current.set(id, index);
      setBgProgress((prev) => ({
        ...prev,
        [index]: { written: 0, total: 0, pct: 0 },
      }));
    } catch (err) {
      console.warn("[terabox] enqueue failed:", err);
      setErrorSheet({
        title: "Couldn't start download",
        message:
          err instanceof TeraboxError
            ? err.message
            : "Something went wrong. Please try again.",
      });
    }
  };

  // Download every file. On Android each is queued to the system DownloadManager
  // (background + notification); on iOS they're downloaded in-app, sequentially.
  const onSaveAll = async () => {
    if (!share) return;
    if (!(await ensurePermission())) return;
    // One cookie serves the whole share, so a single preflight covers all files.
    if (!(await ensureOriginalOk(share.files[0]))) return;

    if (bgAvailable) {
      for (const [index] of share.files.entries()) {
        if (savedIndices.has(index) || bgProgress[index]) continue;
        await enqueueBackground(index);
      }
      return;
    }

    if (saving || savingIndex !== null) return;
    setSaving(true);
    let saved = 0;
    const next = new Set(savedIndices);
    for (const [index, file] of share.files.entries()) {
      try {
        lastPct.current = -1;
        setSavingIndex(index);
        await saveTeraboxFile(file, downloadMode, progressFor(index));
        saved++;
        next.add(index);
      } catch (err) {
        console.warn("[terabox] save failed:", err);
      }
    }
    setSavingIndex(null);
    setDlProgress(null);
    setSavedIndices(next);
    setSaving(false);

    if (saved === 0) {
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save to your device. Please try again.",
      });
    } else if (saved < share.files.length) {
      setErrorSheet({
        title: "Partially saved",
        message: `Saved ${saved} of ${share.files.length} files. Tap the others to retry.`,
      });
    }
  };

  // Download a single file; marks it with a checkmark once saved.
  const saveOne = async (index: number) => {
    if (!share) return;

    if (bgAvailable) {
      if (savedIndices.has(index) || bgProgress[index]) return;
      if (!(await ensurePermission())) return;
      if (!(await ensureOriginalOk(share.files[index]))) return;
      await enqueueBackground(index);
      return;
    }

    if (saving || savingIndex !== null) return;
    if (!(await ensurePermission())) return;
    if (!(await ensureOriginalOk(share.files[index]))) return;
    setSavingIndex(index);
    lastPct.current = -1;
    try {
      await saveTeraboxFile(
        share.files[index],
        downloadMode,
        progressFor(index),
      );
      setSavedIndices((prev) => new Set(prev).add(index));
    } catch (err) {
      console.warn("[terabox] save failed:", err);
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save this file. Please try again.",
      });
    } finally {
      setSavingIndex(null);
      setDlProgress(null);
    }
  };

  const fileCount = share?.files.length ?? 0;
  // Every file saved → the "✅ Saved" button state (derived from both paths).
  const savedAll = fileCount > 0 && savedIndices.size === fileCount;

  // Whether file `index` is mid-download (either path).
  const isDownloading = (index: number) =>
    bgAvailable ? bgProgress[index] !== undefined : savingIndex === index;

  // Live progress for file `index`, or null if unknown/not downloading.
  const progressOf = (index: number) => {
    if (bgAvailable) {
      const p = bgProgress[index];
      return p && p.total > 0 ? p : null;
    }
    if (
      savingIndex === index &&
      dlProgress?.index === index &&
      dlProgress.total > 0
    ) {
      return {
        written: dlProgress.written,
        total: dlProgress.total,
        pct: Math.floor((dlProgress.written / dlProgress.total) * 100),
      };
    }
    return null;
  };

  // The foreground path is single-flight, so it locks the whole list while one
  // file saves. The background path runs files concurrently, so it never locks.
  const anyDownloading = bgAvailable
    ? Object.keys(bgProgress).length > 0
    : saving || savingIndex !== null;
  const listLocked = !bgAvailable && (saving || savingIndex !== null);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {/* Header */}
      <View className="flex-row items-center gap-2 px-2 py-1">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="p-2 active:opacity-70"
        >
          <Icon name="back" size={22} color={colors.text} />
        </Pressable>
        <ThemedText type="subtitle" className="flex-1">
          TeraBox Downloader
        </ThemedText>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pb-12 pt-2 gap-4"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-2">
          <ThemedText type="muted" className="px-1 uppercase">
            TeraBox share link
          </ThemedText>
          <View className="flex-row items-center gap-2">
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="https://terabox.com/s/…"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={() => runFetch(url)}
              selectionColor={colors.accent}
              style={{ color: colors.text }}
              className="flex-1 rounded-2xl bg-surface px-4 py-3.5"
            />
            <Pressable
              onPress={onPaste}
              hitSlop={6}
              className="rounded-2xl bg-surface px-4 py-3.5 active:opacity-70"
            >
              <Icon name="paste" size={20} color={colors.accent} />
            </Pressable>
          </View>
          <Pressable
            onPress={() => runFetch(url)}
            disabled={!url.trim() || fetching}
            style={{ backgroundColor: colors.accent }}
            className={`mt-1 flex-row items-center justify-center gap-2 rounded-full py-3.5 active:opacity-80 ${
              !url.trim() || fetching ? "opacity-50" : ""
            }`}
          >
            {fetching ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <ThemedText className="font-semibold text-white">
                Fetch files
              </ThemedText>
            )}
          </Pressable>
        </View>

        {share && (
          <View className="gap-3">
            {share.title && (
              <ThemedText type="muted" className="px-1">
                {share.title}
                {fileCount > 1 ? ` · ${fileCount} files` : ""}
              </ThemedText>
            )}

            {/* Download quality: Fast (transcoded HLS, unthrottled) vs Original
                (full quality, but throttled hard by TeraBox for non-VIP). */}
            <View className="gap-1.5">
              <ThemedText type="muted" className="px-1 uppercase">
                Download quality
              </ThemedText>
              <View className="flex-row gap-2 rounded-2xl bg-surface p-1">
                {(
                  [
                    { key: "hls", label: "Fast", sub: "streaming quality" },
                    { key: "original", label: "Original", sub: "full · slow" },
                  ] as const
                ).map((opt) => {
                  const active = downloadMode === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      onPress={() => setDownloadMode(opt.key)}
                      disabled={anyDownloading}
                      style={
                        active ? { backgroundColor: colors.accent } : undefined
                      }
                      className={`flex-1 items-center rounded-xl py-2 active:opacity-80 ${
                        anyDownloading ? "opacity-50" : ""
                      }`}
                    >
                      <ThemedText
                        className={`text-sm font-semibold ${active ? "text-white" : ""}`}
                        style={active ? undefined : { color: colors.text }}
                      >
                        {opt.label}
                      </ThemedText>
                      <ThemedText
                        className="text-xs"
                        style={{
                          color: active ? "#ffffffcc" : colors.textSecondary,
                        }}
                      >
                        {opt.sub}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {cookieExpired && (
              <View className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                <ThemedText type="small" style={{ color: colors.text }}>
                  ⚠️ TeraBox login expired. Update the{" "}
                  <ThemedText type="smallBold">TERABOX_COOKIE</ThemedText> secret
                  in the Worker, then try again. (Fast downloads still work.)
                </ThemedText>
              </View>
            )}

            <View className="gap-2">
              {share.files.map((file, i) => {
                const downloading = isDownloading(i);
                const prog = progressOf(i);
                const saved = savedIndices.has(i);
                return (
                  <View
                    key={`${file.fsId}-${i}`}
                    className="overflow-hidden rounded-2xl bg-surface"
                  >
                    <Image
                      source={
                        file.thumbnail ? { uri: file.thumbnail } : undefined
                      }
                      style={{ width: "100%", aspectRatio: 1 }}
                      contentFit="cover"
                      transition={150}
                    />
                    {/* Tap the preview to watch online (HLS resolved on-device). */}
                    <Pressable
                      onPress={() => onWatch(file, i)}
                      disabled={listLocked || watchIndex !== null}
                      className="absolute inset-0 items-center justify-center active:opacity-80"
                    >
                      <View className="h-14 w-14 items-center justify-center rounded-full bg-black/55">
                        {watchIndex === i ? (
                          <ActivityIndicator color="#ffffff" />
                        ) : (
                          <Icon name="play" size={26} color="#ffffff" />
                        )}
                      </View>
                    </Pressable>
                    {/* Filename, size and live progress — bottom-left. */}
                    <View className="absolute inset-x-0 bottom-0 flex-row items-end justify-between gap-2 p-2.5">
                      <View className="flex-1 rounded-xl bg-black/60 px-2.5 py-1.5">
                        <ThemedText
                          numberOfLines={1}
                          className="text-xs font-medium text-white"
                        >
                          {file.filename}
                        </ThemedText>
                        {prog ? (
                          <ThemedText className="text-xs text-white/80">
                            {formatSize(prog.written)} /{" "}
                            {formatSize(prog.total)} ({prog.pct}%)
                          </ThemedText>
                        ) : (
                          file.size > 0 && (
                            <ThemedText className="text-xs text-white/80">
                              {formatSize(file.size)}
                            </ThemedText>
                          )
                        )}
                      </View>
                      {/* Per-file download — only for multi-file shares. */}
                      {fileCount > 1 && (
                        <Pressable
                          onPress={() => saveOne(i)}
                          disabled={listLocked || downloading || saved}
                          hitSlop={8}
                          className="h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-80"
                        >
                          {downloading ? (
                            prog ? (
                              <ThemedText
                                type="small"
                                className="font-semibold text-white"
                              >
                                {prog.pct}%
                              </ThemedText>
                            ) : (
                              <ActivityIndicator color="#ffffff" />
                            )
                          ) : saved ? (
                            <Icon name="check" size={22} color="#4ade80" />
                          ) : (
                            <Icon name="save" size={22} color="#ffffff" />
                          )}
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
            <Pressable
              onPress={onSaveAll}
              disabled={listLocked || savedAll}
              style={{ backgroundColor: colors.accent }}
              className={`flex-row items-center justify-center gap-2 rounded-full py-3.5 active:opacity-80 ${
                listLocked ? "opacity-50" : ""
              }`}
            >
              {savedAll ? (
                <ThemedText className="font-semibold text-white">
                  ✅ Saved
                </ThemedText>
              ) : anyDownloading ? (
                <View className="flex-row items-center gap-2">
                  <ActivityIndicator color="#ffffff" />
                  <ThemedText className="font-semibold text-white">
                    {bgAvailable ? "Downloading…" : "Saving…"}
                  </ThemedText>
                </View>
              ) : (
                <>
                  <Icon name="save" size={20} color="#ffffff" />
                  <ThemedText className="font-semibold text-white">
                    Save {fileCount > 1 ? `all (${fileCount})` : ""}
                  </ThemedText>
                </>
              )}
            </Pressable>
          </View>
        )}

        <ThemedText type="muted" className="px-1 text-center leading-5">
          Saves to a “Mordern Video Player” folder.
          {bgAvailable
            ? " Downloads continue in the background — watch progress in your notifications."
            : ""}
          {"\n"}
          Tip: share a link straight from TeraBox, or paste a copied link above.
        </ThemedText>
      </ScrollView>

      <MessageSheet
        visible={errorSheet !== null}
        title={errorSheet?.title ?? ""}
        message={errorSheet?.message}
        onClose={() => setErrorSheet(null)}
      />

      <ConfirmSheet
        visible={permissionSheet}
        title="Allow file access"
        message={
          'To save into the "Mordern Video Player" folder, allow access to all files.'
        }
        confirmLabel="Open settings"
        onConfirm={() => {
          setPermissionSheet(false);
          void openSettings();
        }}
        onCancel={() => setPermissionSheet(false)}
      />
    </SafeAreaView>
  );
}

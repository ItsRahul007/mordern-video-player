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
import {
  InstagramWebView,
  type InstagramWebViewHandle,
} from "@/components/instagram-webview";
import { MessageSheet } from "@/components/message-sheet";
import { ThemedText } from "@/components/themed-text";
import { useMediaPermissions } from "@/hooks/use-permissions";
import {
  hasAllFilesAccess,
  useAllFilesAccess,
} from "@/hooks/use-storage-permission";
import { useTheme } from "@/hooks/use-theme";
import {
  formatSize,
  instagramBackgroundDownloadAvailable,
  InstagramError,
  type InstagramMedia,
  parseMediaInfoResponse,
  resolveShortcode,
  saveInstagramItem,
  shortcodeToMediaId,
  startInstagramDownload,
} from "@/lib/instagram";
import {
  addDownloadCompleteListener,
  addDownloadProgressListener,
  flushCompletedDownloads,
} from "@modules/media-downloader";

export default function InstagramScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const { openSettings } = useAllFilesAccess();
  // A link shared into the app (Instagram → Share → Video Player).
  const { sharedUrl } = useLocalSearchParams<{ sharedUrl?: string }>();

  // Android's DownloadManager gives real background downloads + a system progress
  // notification; elsewhere (iOS) we fall back to a foreground in-app download.
  const bgAvailable = instagramBackgroundDownloadAvailable();

  const webRef = useRef<InstagramWebViewHandle>(null);
  // null = still determining (initial page load), false = needs login.
  const [connected, setConnected] = useState<boolean | null>(null);

  const [url, setUrl] = useState(sharedUrl ?? "");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<InstagramMedia | null>(null);
  // Per-item state for the foreground (iOS) download path — single-flight.
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
  // Background (DownloadManager) progress, keyed by item index — many at once.
  const [bgProgress, setBgProgress] = useState<
    Record<number, { written: number; total: number; pct: number }>
  >({});

  const fetchingRef = useRef(false);
  const autoRan = useRef(false);
  // Maps a live DownloadManager id back to the item index it's saving.
  const idToIndex = useRef<Map<number, number>>(new Map());

  const onConnectedChange = useCallback((value: boolean) => {
    setConnected(value);
  }, []);

  const runFetch = useCallback(async (link: string) => {
    const trimmed = link.trim();
    if (!trimmed || fetchingRef.current || !webRef.current) return;
    fetchingRef.current = true;
    Keyboard.dismiss();
    setFetching(true);
    setMedia(null);
    try {
      const shortcode = await resolveShortcode(trimmed);
      const mediaId = shortcodeToMediaId(shortcode);
      if (!mediaId) {
        throw new InstagramError("That link doesn't look like a valid post.");
      }
      const body = await webRef.current.fetchMedia(mediaId);
      setSavedIndices(new Set());
      setBgProgress({});
      idToIndex.current.clear();
      setMedia(parseMediaInfoResponse(body, shortcode));
    } catch (err) {
      console.warn(
        "[instagram] fetch failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      setErrorSheet({
        title: "Couldn't fetch media",
        message:
          err instanceof InstagramError
            ? err.message
            : "Something went wrong. Please try again.",
      });
    } finally {
      fetchingRef.current = false;
      setFetching(false);
    }
  }, []);

  // Auto-fetch a shared link once the session is ready.
  useEffect(() => {
    if (connected === true && sharedUrl && !autoRan.current) {
      autoRan.current = true;
      void runFetch(sharedUrl);
    }
  }, [connected, sharedUrl, runFetch]);

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
          message: e.error ?? "Couldn't save this item. Please try again.",
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

  const baseName = (m: InstagramMedia) =>
    m.username ? `${m.username}_${m.shortcode}` : `instagram_${m.shortcode}`;

  const itemFileName = (m: InstagramMedia, index: number) =>
    m.items.length > 1 ? `${baseName(m)}_${index + 1}` : baseName(m);

  // Enqueue one item as a background download (Android). Non-blocking: progress
  // and completion arrive via the listeners above.
  const enqueueBackground = async (index: number) => {
    if (!media) return;
    try {
      const id = await startInstagramDownload(
        media.items[index],
        itemFileName(media, index),
      );
      idToIndex.current.set(id, index);
      setBgProgress((prev) => ({
        ...prev,
        [index]: { written: 0, total: 0, pct: 0 },
      }));
    } catch (err) {
      console.warn("[instagram] enqueue failed:", err);
      setErrorSheet({
        title: "Couldn't start download",
        message:
          err instanceof InstagramError
            ? err.message
            : "Something went wrong. Please try again.",
      });
    }
  };

  // Download every item. On Android each is queued to the system DownloadManager
  // (background + notification); on iOS they're downloaded in-app, sequentially.
  const onSaveAll = async () => {
    if (!media) return;
    if (!(await ensurePermission())) return;

    if (bgAvailable) {
      for (const [index] of media.items.entries()) {
        if (savedIndices.has(index) || bgProgress[index]) continue;
        await enqueueBackground(index);
      }
      return;
    }

    if (saving || savingIndex !== null) return;
    setSaving(true);
    let saved = 0;
    const next = new Set(savedIndices);
    for (const [index, item] of media.items.entries()) {
      try {
        await saveInstagramItem(item, itemFileName(media, index));
        saved++;
        next.add(index);
      } catch (err) {
        console.warn("[instagram] save failed:", err);
      }
    }
    setSavedIndices(next);
    setSaving(false);

    if (saved === 0) {
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save to your device. Please try again.",
      });
    } else if (saved < media.items.length) {
      setErrorSheet({
        title: "Partially saved",
        message: `Saved ${saved} of ${media.items.length} items. Tap the others to retry.`,
      });
    }
  };

  // Download a single item; marks it with a checkmark once saved.
  const saveOne = async (index: number) => {
    if (!media) return;

    if (bgAvailable) {
      if (savedIndices.has(index) || bgProgress[index]) return;
      if (!(await ensurePermission())) return;
      await enqueueBackground(index);
      return;
    }

    if (saving || savingIndex !== null) return;
    if (!(await ensurePermission())) return;
    setSavingIndex(index);
    try {
      await saveInstagramItem(media.items[index], itemFileName(media, index));
      setSavedIndices((prev) => new Set(prev).add(index));
    } catch (err) {
      console.warn("[instagram] save failed:", err);
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save this item. Please try again.",
      });
    } finally {
      setSavingIndex(null);
    }
  };

  const loginActive = connected === false;
  const itemCount = media?.items.length ?? 0;
  // Every item saved → the "✅ Saved" button state (derived from both paths).
  const savedAll = itemCount > 0 && savedIndices.size === itemCount;

  // Whether item `index` is mid-download (either path).
  const isDownloading = (index: number) =>
    bgAvailable ? bgProgress[index] !== undefined : savingIndex === index;

  // Live progress for item `index`, or null if unknown/not downloading.
  const progressOf = (index: number) => {
    if (!bgAvailable) return null;
    const p = bgProgress[index];
    return p && p.total > 0 ? p : null;
  };

  // The foreground path is single-flight, so it locks the whole list while one
  // item saves. The background path runs items concurrently, so it never locks.
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
          {loginActive ? "Connect Instagram" : "Instagram Downloader"}
        </ThemedText>
      </View>

      {loginActive && (
        <View className="bg-surface px-4 py-2.5">
          <ThemedText type="small" className="text-center leading-5 text-muted">
            Sign in to download. Use a throwaway account — automated access can
            get accounts restricted.
          </ThemedText>
        </View>
      )}

      {/* Downloader UI (only once connected) */}
      {connected === true && (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pb-12 pt-2 gap-4"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-2">
            <ThemedText type="muted" className="px-1 uppercase">
              Reel or post link
            </ThemedText>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="https://www.instagram.com/reel/…"
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
                  Fetch media
                </ThemedText>
              )}
            </Pressable>
          </View>

          {media && (
            <View className="gap-3">
              {media.username && (
                <ThemedText type="muted" className="px-1">
                  @{media.username}
                  {itemCount > 1 ? ` · ${itemCount} items` : ""}
                </ThemedText>
              )}
              <View className="gap-2">
                {media.items.map((item, i) => {
                  const downloading = isDownloading(i);
                  const prog = progressOf(i);
                  const saved = savedIndices.has(i);
                  return (
                    <View
                      key={`${item.url}-${i}`}
                      className="overflow-hidden rounded-2xl bg-surface"
                    >
                      <Image
                        source={
                          item.thumbnail ? { uri: item.thumbnail } : undefined
                        }
                        style={{ width: "100%", aspectRatio: 1 }}
                        contentFit="cover"
                        transition={150}
                      />
                      <View className="absolute left-2 top-2 flex-row items-center gap-1 rounded-full bg-black/60 px-2 py-1">
                        <Icon
                          name={item.type === "video" ? "play" : "image"}
                          size={12}
                          color="#ffffff"
                        />
                        <ThemedText
                          type="small"
                          className="font-semibold text-white"
                        >
                          {item.type === "video" ? "Video" : "Photo"}
                        </ThemedText>
                      </View>
                      {/* Live download progress — bottom-left, while saving. */}
                      {prog && (
                        <View className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2.5 py-1">
                          <ThemedText
                            type="small"
                            className="font-semibold text-white"
                          >
                            {formatSize(prog.written)} /{" "}
                            {formatSize(prog.total)} ({prog.pct}%)
                          </ThemedText>
                        </View>
                      )}
                      {/* Per-item download button — only for multi-item posts. */}
                      {itemCount > 1 && (
                        <Pressable
                          onPress={() => saveOne(i)}
                          disabled={listLocked || downloading || saved}
                          hitSlop={8}
                          className="absolute bottom-2 right-2 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-80"
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
                      Save {itemCount > 1 ? `all (${itemCount})` : ""}
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
            Tip: share a reel straight from Instagram, or paste a copied link
            above.
          </ThemedText>
        </ScrollView>
      )}

      {/* The WebView is always mounted: full-screen for login, hidden (but
          alive, to run fetches) once connected. */}
      <View
        style={
          loginActive
            ? { flex: 1 }
            : { position: "absolute", width: 1, height: 1, opacity: 0 }
        }
        pointerEvents={loginActive ? "auto" : "none"}
      >
        <InstagramWebView
          ref={webRef}
          onConnectedChange={onConnectedChange}
          style={{ flex: 1 }}
        />
      </View>

      {/* Initial connecting state, before we know if a session exists. */}
      {connected === null && (
        <View className="absolute inset-0 items-center justify-center gap-3 bg-background">
          <ActivityIndicator color={colors.accent} size="large" />
          <ThemedText type="muted">Connecting…</ThemedText>
        </View>
      )}

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

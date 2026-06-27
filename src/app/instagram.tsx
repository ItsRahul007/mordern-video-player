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
  InstagramError,
  type InstagramMedia,
  parseMediaInfoResponse,
  resolveShortcode,
  saveInstagramItem,
  shortcodeToMediaId,
} from "@/lib/instagram";

export default function InstagramScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const { openSettings } = useAllFilesAccess();
  // A link shared into the app (Instagram → Share → Video Player).
  const { sharedUrl } = useLocalSearchParams<{ sharedUrl?: string }>();

  const webRef = useRef<InstagramWebViewHandle>(null);
  // null = still determining (initial page load), false = needs login.
  const [connected, setConnected] = useState<boolean | null>(null);

  const [url, setUrl] = useState(sharedUrl ?? "");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<InstagramMedia | null>(null);
  // Per-item state for the download buttons shown on multi-item (carousel) posts.
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [savedIndices, setSavedIndices] = useState<ReadonlySet<number>>(
    new Set(),
  );
  // Whether every item has been saved (drives the "✅ Saved" button state).
  const [savedAll, setSavedAll] = useState(false);
  // Error shown in a bottom sheet (replaces system alerts).
  const [errorSheet, setErrorSheet] = useState<{
    title: string;
    message: string;
  } | null>(null);
  // The Android all-files permission prompt (shown as a bottom sheet).
  const [permissionSheet, setPermissionSheet] = useState(false);

  const fetchingRef = useRef(false);
  const autoRan = useRef(false);

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
      setSavedAll(false);
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

  // Download every item; the button then reflects "✅ Saved".
  const onSaveAll = async () => {
    if (!media || saving || savingIndex !== null) return;
    if (!(await ensurePermission())) return;

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

    if (saved === media.items.length) {
      setSavedAll(true);
    } else if (saved === 0) {
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save to your device. Please try again.",
      });
    } else {
      setErrorSheet({
        title: "Partially saved",
        message: `Saved ${saved} of ${media.items.length} items. Tap the others to retry.`,
      });
    }
  };

  // Download a single item from a multi-item post; marks it with a checkmark.
  const saveOne = async (index: number) => {
    if (!media || saving || savingIndex !== null) return;
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
                {media.items.map((item, i) => (
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
                    {/* Per-item download button — only for multi-item posts. */}
                    {itemCount > 1 && (
                      <Pressable
                        onPress={() => saveOne(i)}
                        disabled={saving || savingIndex !== null}
                        hitSlop={8}
                        className="absolute bottom-2 right-2 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-80"
                      >
                        {savingIndex === i ? (
                          <ActivityIndicator color="#ffffff" />
                        ) : savedIndices.has(i) ? (
                          <Icon name="check" size={22} color="#4ade80" />
                        ) : (
                          <Icon name="save" size={22} color="#ffffff" />
                        )}
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
              <Pressable
                onPress={onSaveAll}
                disabled={saving || savingIndex !== null || savedAll}
                style={{ backgroundColor: colors.accent }}
                className={`flex-row items-center justify-center gap-2 rounded-full py-3.5 active:opacity-80 ${
                  saving || savingIndex !== null ? "opacity-50" : ""
                }`}
              >
                {saving ? (
                  <ActivityIndicator color="#ffffff" />
                ) : savedAll ? (
                  <ThemedText className="font-semibold text-white">
                    ✅ Saved
                  </ThemedText>
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
            Saves to a “Mordern Video Player” folder. Tip: share a reel straight
            from Instagram, or paste a copied link above.
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
        message={'To save into the "Mordern Video Player" folder, allow access to all files.'}
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

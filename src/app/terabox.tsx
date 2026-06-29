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
  extractSurl,
  fetchShareInfo,
  formatSize,
  saveTeraboxFile,
  TeraboxError,
  type TeraboxFile,
  type TeraboxShare,
  teraboxStreamUrl,
} from "@/lib/terabox";

export default function TeraboxScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const { openSettings } = useAllFilesAccess();
  // A link shared into the app (TeraBox → Share → Video Player).
  const { sharedUrl } = useLocalSearchParams<{ sharedUrl?: string }>();

  const [url, setUrl] = useState(sharedUrl ?? "");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [share, setShare] = useState<TeraboxShare | null>(null);
  // Per-file state for the download buttons on multi-file shares.
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [savedIndices, setSavedIndices] = useState<ReadonlySet<number>>(
    new Set(),
  );
  // Whether every file has been saved (drives the "✅ Saved" button state).
  const [savedAll, setSavedAll] = useState(false);
  // Error shown in a bottom sheet (replaces system alerts).
  const [errorSheet, setErrorSheet] = useState<{
    title: string;
    message: string;
  } | null>(null);
  // The Android all-files permission prompt (shown as a bottom sheet).
  const [permissionSheet, setPermissionSheet] = useState(false);
  // Download progress for the file currently saving: { index, written, total }.
  const [dlProgress, setDlProgress] = useState<{
    index: number;
    written: number;
    total: number;
  } | null>(null);

  const fetchingRef = useRef(false);
  const autoRan = useRef(false);
  // Throttle progress state updates to whole-percent changes.
  const lastPct = useRef(-1);

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

  // Open the video for online playback — streamed through the proxy Worker.
  const onWatch = (file: TeraboxFile) => {
    const uri = teraboxStreamUrl(file);
    if (!uri) {
      setErrorSheet({
        title: "Can't play",
        message: "No playable URL for this file.",
      });
      return;
    }
    router.push({ pathname: "/player", params: { uri } });
  };

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
      setSavedAll(false);
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

  // Download every file; the button then reflects "✅ Saved".
  const onSaveAll = async () => {
    if (!share || saving || savingIndex !== null) return;
    if (!(await ensurePermission())) return;

    setSaving(true);
    let saved = 0;
    const next = new Set(savedIndices);
    for (const [index, file] of share.files.entries()) {
      try {
        lastPct.current = -1;
        setSavingIndex(index);
        await saveTeraboxFile(file, progressFor(index));
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

    if (saved === share.files.length) {
      setSavedAll(true);
    } else if (saved === 0) {
      setErrorSheet({
        title: "Save failed",
        message: "Couldn't save to your device. Please try again.",
      });
    } else {
      setErrorSheet({
        title: "Partially saved",
        message: `Saved ${saved} of ${share.files.length} files. Tap the others to retry.`,
      });
    }
  };

  // Download a single file from a multi-file share; marks it with a checkmark.
  const saveOne = async (index: number) => {
    if (!share || saving || savingIndex !== null) return;
    if (!(await ensurePermission())) return;

    setSavingIndex(index);
    lastPct.current = -1;
    try {
      await saveTeraboxFile(share.files[index], progressFor(index));
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
            <View className="gap-2">
              {share.files.map((file, i) => (
                <View
                  key={`${file.fsId}-${i}`}
                  className="flex-row items-center gap-3 overflow-hidden rounded-2xl bg-surface p-2.5"
                >
                  <View className="h-16 w-16 overflow-hidden rounded-xl bg-black/20">
                    <Image
                      source={
                        file.thumbnail ? { uri: file.thumbnail } : undefined
                      }
                      style={{ width: "100%", height: "100%" }}
                      contentFit="cover"
                      transition={150}
                    />
                  </View>
                  <View className="flex-1 gap-1">
                    <ThemedText numberOfLines={2} className="text-sm">
                      {file.filename}
                    </ThemedText>
                    {savingIndex === i &&
                    dlProgress?.index === i &&
                    dlProgress.total > 0 ? (
                      <ThemedText type="muted" className="text-xs">
                        {formatSize(dlProgress.written)} /{" "}
                        {formatSize(dlProgress.total)} (
                        {Math.floor((dlProgress.written / dlProgress.total) * 100)}%)
                      </ThemedText>
                    ) : (
                      file.size > 0 && (
                        <ThemedText type="muted" className="text-xs">
                          {formatSize(file.size)}
                        </ThemedText>
                      )
                    )}
                  </View>
                  {/* Actions: watch online + save. */}
                  <View className="flex-row items-center gap-1">
                    <Pressable
                      onPress={() => onWatch(file)}
                      disabled={saving || savingIndex !== null}
                      hitSlop={6}
                      className="h-11 w-11 items-center justify-center rounded-full bg-black/10 active:opacity-80"
                    >
                      <Icon name="play" size={20} color={colors.accent} />
                    </Pressable>
                    <Pressable
                      onPress={() => saveOne(i)}
                      disabled={saving || savingIndex !== null}
                      hitSlop={6}
                      className="h-11 w-11 items-center justify-center rounded-full bg-black/10 active:opacity-80"
                    >
                      {savingIndex === i ? (
                        dlProgress?.index === i && dlProgress.total > 0 ? (
                          <ThemedText
                            type="small"
                            className="font-semibold"
                            style={{ color: colors.accent }}
                          >
                            {Math.floor((dlProgress.written / dlProgress.total) * 100)}%
                          </ThemedText>
                        ) : (
                          <ActivityIndicator color={colors.accent} />
                        )
                      ) : savedIndices.has(i) ? (
                        <Icon name="check" size={22} color="#4ade80" />
                      ) : (
                        <Icon name="save" size={22} color={colors.accent} />
                      )}
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
            {fileCount > 1 && (
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
                      Save all ({fileCount})
                    </ThemedText>
                  </>
                )}
              </Pressable>
            )}
          </View>
        )}

        <ThemedText type="muted" className="px-1 text-center leading-5">
          Saves to a “Mordern Video Player” folder. Tip: share a link straight
          from TeraBox, or paste a copied link above.
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

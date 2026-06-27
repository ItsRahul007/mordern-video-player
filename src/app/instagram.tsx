import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import {
  InstagramWebView,
  type InstagramWebViewHandle,
} from "@/components/instagram-webview";
import { ThemedText } from "@/components/themed-text";
import { useMediaPermissions } from "@/hooks/use-permissions";
import { useTheme } from "@/hooks/use-theme";
import {
  InstagramError,
  type InstagramMedia,
  parseMediaInfoResponse,
  resolveShortcode,
  saveInstagramVideo,
  shortcodeToMediaId,
} from "@/lib/instagram";

export default function InstagramScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();

  const webRef = useRef<InstagramWebViewHandle>(null);
  // null = still determining (initial page load), false = needs login.
  const [connected, setConnected] = useState<boolean | null>(null);

  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<InstagramMedia | null>(null);

  const onConnectedChange = useCallback((value: boolean) => {
    setConnected(value);
  }, []);

  const onFetch = async () => {
    if (!url.trim() || fetching || !webRef.current) return;
    Keyboard.dismiss();
    setFetching(true);
    setMedia(null);
    try {
      const shortcode = await resolveShortcode(url);
      const mediaId = shortcodeToMediaId(shortcode);
      if (!mediaId) {
        throw new InstagramError("That link doesn't look like a valid post.");
      }
      const body = await webRef.current.fetchMedia(mediaId);
      setMedia(parseMediaInfoResponse(body, shortcode));
    } catch (err) {
      console.warn(
        "[instagram] fetch failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      Alert.alert(
        "Couldn't fetch video",
        err instanceof InstagramError
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setFetching(false);
    }
  };

  const onSave = async () => {
    if (!media || saving) return;
    if (!granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert(
          "Permission needed",
          "Allow access to your media library to save videos.",
        );
        return;
      }
    }

    setSaving(true);
    const base = media.username
      ? `${media.username}_${media.shortcode}`
      : `instagram_${media.shortcode}`;
    let saved = 0;
    for (const [index, video] of media.videos.entries()) {
      try {
        const name = media.videos.length > 1 ? `${base}_${index + 1}` : base;
        await saveInstagramVideo(video, name);
        saved++;
      } catch (err) {
        console.warn("[instagram] save failed:", err);
      }
    }
    setSaving(false);

    if (saved === 0) {
      Alert.alert("Save failed", "Couldn't save the video to your gallery.");
      return;
    }
    setMedia(null);
    setUrl("");
    Alert.alert(
      saved === media.videos.length ? "Saved" : "Partially saved",
      `Saved ${saved} video${saved === 1 ? "" : "s"} to your gallery.`,
    );
  };

  const loginActive = connected === false;

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
            Sign in to download videos. Use a throwaway account — automated
            access can get accounts restricted.
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
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="https://www.instagram.com/reel/…"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={onFetch}
              selectionColor={colors.accent}
              style={{ color: colors.text }}
              className="rounded-2xl bg-surface px-4 py-3.5"
            />
            <Pressable
              onPress={onFetch}
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
                  Fetch video
                </ThemedText>
              )}
            </Pressable>
          </View>

          {media && (
            <View className="gap-3">
              {media.username && (
                <ThemedText type="muted" className="px-1">
                  @{media.username}
                  {media.videos.length > 1
                    ? ` · ${media.videos.length} videos`
                    : ""}
                </ThemedText>
              )}
              <View className="gap-2">
                {media.videos.map((video, i) => (
                  <View
                    key={`${video.url}-${i}`}
                    className="overflow-hidden rounded-2xl bg-surface"
                  >
                    <Image
                      source={
                        video.thumbnail ? { uri: video.thumbnail } : undefined
                      }
                      style={{ width: "100%", aspectRatio: 1 }}
                      contentFit="cover"
                      transition={150}
                    />
                  </View>
                ))}
              </View>
              <Pressable
                onPress={onSave}
                disabled={saving}
                style={{ backgroundColor: colors.accent }}
                className={`flex-row items-center justify-center gap-2 rounded-full py-3.5 active:opacity-80 ${
                  saving ? "opacity-50" : ""
                }`}
              >
                {saving ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <>
                    <Icon name="save" size={20} color="#ffffff" />
                    <ThemedText className="font-semibold text-white">
                      Save {media.videos.length > 1 ? "all videos" : "video"} to
                      gallery
                    </ThemedText>
                  </>
                )}
              </Pressable>
            </View>
          )}

          <ThemedText type="muted" className="px-1 text-center leading-5">
            Long-press the field above to paste a link copied from the Instagram
            app.
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
    </SafeAreaView>
  );
}

import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useVideoPlayer, VideoView } from "expo-video";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { saveStatus, type StatusType } from "@/lib/whatsapp-status";

/**
 * Full-screen preview for a single WhatsApp status with a Save action. Kept
 * separate from the main player ([app/player.tsx]) because that screen is bound
 * to a media-library album/playlist and can't take a raw file URI.
 */
export default function StatusViewerScreen() {
  const router = useRouter();
  const { uri, type, name } = useLocalSearchParams<{
    uri: string;
    type: StatusType;
    name: string;
  }>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const isVideo = type === "video";
  const player = useVideoPlayer(isVideo ? uri : null, (p) => {
    p.loop = true;
    p.play();
  });

  const onSave = async () => {
    console.log(`[status] viewer save: ${name}`);
    setSaving(true);
    try {
      await saveStatus({ uri, name, type, size: null, modificationTime: 0 });
      setSaved(true);
    } catch (e) {
      console.warn(
        "[status] save FAILED:",
        name,
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      );
      Alert.alert("Save failed", "Could not save this status.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="flex-1 bg-black">
      <StatusBar style="light" />

      {isVideo ? (
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="contain"
          nativeControls
          allowsPictureInPicture
        />
      ) : (
        <Image
          source={uri}
          style={{ flex: 1 }}
          contentFit="contain"
          transition={150}
        />
      )}

      <SafeAreaView
        edges={["top"]}
        className="absolute left-0 right-0 top-0 flex-row items-center justify-between px-2 py-1"
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="rounded-full bg-black/40 p-2 active:opacity-70"
        >
          <Icon name="back" size={24} color="#ffffff" />
        </Pressable>
        <ThemedText
          numberOfLines={1}
          className="mx-2 flex-1 text-white"
          type="small"
        >
          {name}
        </ThemedText>
      </SafeAreaView>

      <SafeAreaView
        edges={["bottom"]}
        className="absolute bottom-4 left-0 right-0 items-center"
        pointerEvents="box-none"
      >
        <Pressable
          onPress={onSave}
          disabled={saving || saved}
          className="flex-row items-center gap-2 rounded-full bg-accent px-6 py-3.5 active:opacity-80"
        >
          {saving ? (
            <ActivityIndicator color="#ffffff" />
          ) : saved ? null : (
            <Icon name="save" size={22} color="#ffffff" />
          )}
          <ThemedText className="font-semibold text-white">
            {saving ? "Saving…" : saved ? "✅ Saved status" : "Save status"}
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { VideoThumbnail } from "@/components/video-thumbnail";
import { usePlaybackEntry } from "@/hooks/use-playback";
import { useTheme } from "@/hooks/use-theme";
import { formatDuration } from "@/lib/format";
import { getVideoDuration, type VideoAsset } from "@/lib/media";

/**
 * Media-library metadata sometimes reports a 0 duration even though the file
 * plays fine. When that happens, probe the actual file via expo-video as a
 * fallback so the row still shows a real duration.
 */
function useResolvedDuration(video: VideoAsset): number {
  const [duration, setDuration] = useState(video.duration);

  useEffect(() => {
    setDuration(video.duration);
    if (video.duration > 0) return;

    let active = true;
    getVideoDuration(video.uri).then((resolved) => {
      if (active && resolved) setDuration(resolved);
    });
    return () => {
      active = false;
    };
  }, [video.id, video.uri, video.duration]);

  return duration;
}

type VideoRowProps = {
  video: VideoAsset;
  onPress: () => void;
  onLongPress?: () => void;
  selectionActive?: boolean;
  selected?: boolean;
};

export function VideoRow({
  video,
  onPress,
  onLongPress,
  selectionActive = false,
  selected = false,
}: VideoRowProps) {
  const { colors } = useTheme();
  const entry = usePlaybackEntry(video.id);
  const duration = useResolvedDuration(video);
  const fraction = entry
    ? entry.completed
      ? 1
      : Math.min(1, Math.max(0, entry.position / (duration || 1)))
    : 0;

  const completedPercent = Math.round(fraction * 100);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      className={`flex-row items-center gap-3 rounded-2xl p-2.5 active:opacity-80 ${
        selected ? "bg-accent/20" : "bg-surface"
      }`}
    >
      <View className="aspect-video w-28 overflow-hidden rounded-xl">
        <VideoThumbnail uri={video.uri} seed={video.id} />

        {entry?.completed && (
          <View className="absolute left-1 top-1 rounded-full bg-accent p-0.5">
            <Icon name="check" size={11} color="#ffffff" />
          </View>
        )}

        <View className="absolute bottom-1 right-1 rounded bg-black/65 px-1 py-0.5">
          <ThemedText className="text-sm font-semibold text-white">
            {formatDuration(duration)}
          </ThemedText>
        </View>

        {fraction > 0 ? (
          <View className="absolute bottom-0 left-0 right-0 h-1">
            <View
              className="h-full rounded-r bg-blue-500"
              style={{ width: `${completedPercent}%` }}
            />
          </View>
        ) : null}
      </View>

      <View className="flex-1">
        <ThemedText type="small" numberOfLines={2} className="font-semibold">
          {video.filename}
        </ThemedText>
        {entry && (
          <ThemedText type="muted" className="mt-1">
            {entry.completed ? "Watched" : `${completedPercent}% watched`}
          </ThemedText>
        )}
      </View>

      {selectionActive && (
        <View
          className="h-6 w-6 items-center justify-center rounded-full border-2"
          style={{
            borderColor: selected ? colors.accent : colors.textSecondary,
            backgroundColor: selected ? colors.accent : "transparent",
          }}
        >
          {selected && <Icon name="check" size={14} color="#ffffff" />}
        </View>
      )}
    </Pressable>
  );
}

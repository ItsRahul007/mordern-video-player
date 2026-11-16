import { Image } from "expo-image";
import { memo, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { VideoThumbnail } from "@/components/video-thumbnail";
import { useTheme } from "@/hooks/use-theme";
import type { GalleryMediaType } from "@/lib/gallery";
import { formatDuration } from "@/lib/format";

type MediaThumbProps = {
  id: string;
  uri: string | null;
  mediaType: GalleryMediaType;
  /** "cover" for grid tiles, "contain" for full-screen posters. */
  fit?: "cover" | "contain";
  /** Fade-in duration (ms) once the image has loaded. */
  transition?: number;
};

/**
 * Still for an image or video. Images load straight from their URI (expo-image
 * decodes at view size). For videos on Android we first let expo-image (Glide)
 * pull a frame from the file — fast and parallel — and fall back to the app's
 * serial, disk-cached thumbnail generator if that fails.
 */
export function MediaThumb({
  id,
  uri,
  mediaType,
  fit = "cover",
  transition = 120,
}: MediaThumbProps) {
  const { colors } = useTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const tryImage =
    !!uri && (mediaType === "image" || (Platform.OS === "android" && !imageFailed));

  if (mediaType === "video" && (!tryImage || imageFailed)) {
    return <VideoThumbnail uri={uri} seed={id} />;
  }

  return (
    <View
      className="h-full w-full"
      style={{ backgroundColor: fit === "cover" ? colors.backgroundElement : "transparent" }}
    >
      {tryImage && (
        <Image
          source={{ uri: uri as string }}
          recyclingKey={id}
          style={StyleSheet.absoluteFill}
          contentFit={fit}
          cachePolicy="memory-disk"
          transition={transition}
          onError={() => setImageFailed(true)}
        />
      )}
    </View>
  );
}

type MediaTileProps = {
  id: string;
  uri: string;
  mediaType: GalleryMediaType;
  duration: number;
  size: number;
  /** Small tiles (zoomed-out grid): no duration text, smaller badges. */
  compact?: boolean;
  selectionActive: boolean;
  selected: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
};

/** Square grid cell with a video duration pill and a selection overlay. */
export const MediaTile = memo(function MediaTile({
  id,
  uri,
  mediaType,
  duration,
  size,
  compact = false,
  selectionActive,
  selected,
  onPress,
  onLongPress,
}: MediaTileProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => onPress(id)}
      onLongPress={() => onLongPress(id)}
      delayLongPress={250}
      style={{ width: size, height: size }}
      className="active:opacity-80"
    >
      <View
        className="h-full w-full overflow-hidden"
        style={
          selected
            ? compact
              ? { opacity: 0.55 }
              : { transform: [{ scale: 0.86 }], borderRadius: 12 }
            : undefined
        }
      >
        <MediaThumb id={id} uri={uri} mediaType={mediaType} />

        {mediaType === "video" &&
          (compact ? (
            <View className="absolute bottom-0.5 right-0.5 rounded-full bg-black/55 p-0.5">
              <Icon name="play" size={8} color="#ffffff" />
            </View>
          ) : (
            <View className="absolute bottom-1 right-1 flex-row items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5">
              <Icon name="play" size={10} color="#ffffff" />
              {duration > 0 && (
                <ThemedText className="text-[11px] font-semibold text-white">
                  {formatDuration(duration)}
                </ThemedText>
              )}
            </View>
          ))}
      </View>

      {selectionActive && (
        <View
          className={`absolute items-center justify-center rounded-full border-2 ${
            compact ? "left-0.5 top-0.5 h-3.5 w-3.5" : "left-1.5 top-1.5 h-5 w-5"
          }`}
          style={{
            borderColor: selected ? colors.accent : "#ffffff",
            backgroundColor: selected ? colors.accent : "rgba(0,0,0,0.25)",
          }}
        >
          {selected && <Icon name="check" size={compact ? 8 : 12} color="#ffffff" />}
        </View>
      )}
    </Pressable>
  );
});

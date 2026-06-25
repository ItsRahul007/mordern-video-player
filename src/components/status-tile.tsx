import { Pressable, View } from "react-native";

import { Icon } from "@/components/icon";
import { VideoThumbnail } from "@/components/video-thumbnail";
import { useTheme } from "@/hooks/use-theme";
import type { StatusFile } from "@/lib/whatsapp-status";

type StatusTileProps = {
  status: StatusFile;
  /** Square side length in px (computed from the grid width by the screen). */
  size: number;
  onPress: () => void;
  onLongPress?: () => void;
  selectionActive?: boolean;
  selected?: boolean;
};

/**
 * Square grid tile for one WhatsApp status. {@link VideoThumbnail} renders a
 * frame for both images and videos (expo-image decodes a local video's first
 * frame), with a gradient placeholder while it loads. Videos get a play badge.
 */
export function StatusTile({
  status,
  size,
  onPress,
  onLongPress,
  selectionActive = false,
  selected = false,
}: StatusTileProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      style={{ width: size, height: size }}
      className="overflow-hidden rounded-xl active:opacity-80"
    >
      <VideoThumbnail uri={status.uri} seed={status.name} />

      {status.type === "video" && !selectionActive && (
        <View className="absolute inset-0 items-center justify-center">
          <Icon name="playCircle" size={36} color="rgba(255,255,255,0.95)" />
        </View>
      )}

      {selectionActive && (
        <>
          <View className="absolute inset-0 bg-black/30" />
          <View
            className="absolute right-1.5 top-1.5 h-6 w-6 items-center justify-center rounded-full border-2"
            style={{
              borderColor: selected ? colors.accent : "#ffffff",
              backgroundColor: selected ? colors.accent : "transparent",
            }}
          >
            {selected && <Icon name="check" size={14} color="#ffffff" />}
          </View>
        </>
      )}
    </Pressable>
  );
}

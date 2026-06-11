import { Pressable, View } from "react-native";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { VideoThumbnail } from "@/components/video-thumbnail";
import { useTheme } from "@/hooks/use-theme";
import type { VideoFolder } from "@/lib/media";

type FolderCardProps = {
  folder: VideoFolder;
  onPress: () => void;
  onLongPress?: () => void;
  selectionActive?: boolean;
  selected?: boolean;
};

export function FolderCard({
  folder,
  onPress,
  onLongPress,
  selectionActive = false,
  selected = false,
}: FolderCardProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      className={`flex-row items-center gap-3 rounded-2xl p-2.5 active:opacity-80 ${
        selected ? "bg-accent/20" : "bg-surface"
      }`}
    >
      <View className="h-16 w-24 overflow-hidden rounded-xl">
        <VideoThumbnail uri={folder.coverUri} seed={folder.id} />
      </View>
      <View className="flex-1">
        <ThemedText type="small" numberOfLines={1} className="font-semibold">
          {folder.title}
        </ThemedText>
        <ThemedText type="muted" className="mt-0.5">
          {folder.count} video{folder.count === 1 ? "" : "s"}
        </ThemedText>
      </View>
      {selectionActive ? (
        <View
          className="h-6 w-6 items-center justify-center rounded-full border-2"
          style={{
            borderColor: selected ? colors.accent : colors.textSecondary,
            backgroundColor: selected ? colors.accent : "transparent",
          }}
        >
          {selected && <Icon name="check" size={14} color="#ffffff" />}
        </View>
      ) : (
        <Icon name="chevronRight" size={16} color={colors.textSecondary} />
      )}
    </Pressable>
  );
}

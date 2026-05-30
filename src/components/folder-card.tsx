import { Pressable, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { VideoThumbnail } from '@/components/video-thumbnail';
import type { VideoFolder } from '@/lib/media';
import { useTheme } from '@/hooks/use-theme';

type FolderCardProps = {
  folder: VideoFolder;
  onPress: () => void;
};

export function FolderCard({ folder, onPress }: FolderCardProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl bg-surface p-2.5 active:opacity-80">
      <View className="h-16 w-24 overflow-hidden rounded-xl">
        <VideoThumbnail uri={folder.coverUri} seed={folder.id} />
      </View>
      <View className="flex-1">
        <ThemedText type="small" numberOfLines={1} className="font-semibold">
          {folder.title}
        </ThemedText>
        <ThemedText type="muted" className="mt-0.5">
          {folder.count} video{folder.count === 1 ? '' : 's'}
        </ThemedText>
      </View>
      <Icon name="chevronRight" size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

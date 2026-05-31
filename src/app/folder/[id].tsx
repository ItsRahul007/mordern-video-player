import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import { SortOptionsList } from "@/components/sort-options-list";
import { ThemedText } from "@/components/themed-text";
import { VideoRow } from "@/components/video-row";
import { useTheme } from "@/hooks/use-theme";
import { useFolderVideos } from "@/hooks/use-video-folders";
import { sortVideos, type SortOption } from "@/lib/media";
import { useSort } from "@/providers/sort-provider";

export default function FolderScreen() {
  const router = useRouter();
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { colors } = useTheme();
  const { sort, setSort } = useSort();
  const { data: videos, isLoading } = useFolderVideos(id);
  const [filterOpen, setFilterOpen] = useState(false);

  const sortedVideos = useMemo(
    () => (videos ? sortVideos(videos, sort) : undefined),
    [videos, sort],
  );

  const pickSort = (option: SortOption) => {
    setSort(option);
    setFilterOpen(false);
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {/* Custom header to match the app's look. */}
      <View className="flex-row items-center gap-2 px-2 py-1">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="p-2 active:opacity-70"
        >
          <Icon name="back" size={22} color={colors.text} />
        </Pressable>
        <ThemedText type="subtitle" numberOfLines={1} className="flex-1">
          {title ?? "Folder"}
        </ThemedText>
        <Pressable
          onPress={() => setFilterOpen(true)}
          hitSlop={10}
          className="p-2 active:opacity-70"
        >
          <Icon name="filter" size={22} color={colors.text} />
        </Pressable>
      </View>

      <FlatList
        data={sortedVideos}
        keyExtractor={(item) => item.id}
        contentContainerClassName="gap-2.5 px-4 pb-8 pt-1"
        renderItem={({ item }) => (
          <VideoRow
            video={item}
            onPress={() =>
              router.push({
                pathname: "/player",
                params: { albumId: id, id: item.id },
              })
            }
          />
        )}
        ListEmptyComponent={
          isLoading ? (
            <View className="mt-24 items-center">
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : (
            <View className="mt-24 items-center px-8">
              <ThemedText type="muted">No videos in this folder.</ThemedText>
            </View>
          )
        }
      />

      {/* Sort filter sheet */}
      <Modal
        visible={filterOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterOpen(false)}
      >
        <Pressable
          className="flex-1 justify-end bg-black/50"
          onPress={() => setFilterOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="rounded-t-3xl bg-background px-4 pb-10 pt-3"
          >
            <View className="mb-3 items-center">
              <View className="h-1 w-10 rounded-full bg-surface-2" />
            </View>
            <ThemedText type="subtitle" className="mb-3 px-1 text-white">
              Sort by
            </ThemedText>
            <SortOptionsList value={sort} onChange={pickSort} />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Modal,
  Pressable,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { Icon } from "@/components/icon";
import { SortOptionsList } from "@/components/sort-options-list";
import { ThemedText } from "@/components/themed-text";
import { VideoRow } from "@/components/video-row";
import { usePlaybackEntries } from "@/hooks/use-playback";
import { useSelection } from "@/hooks/use-selection";
import { useTheme } from "@/hooks/use-theme";
import { useFolderVideos, videoKeys } from "@/hooks/use-video-folders";
import { deleteVideos, sortVideos, type VideoAsset } from "@/lib/media";
import { useSort } from "@/providers/sort-provider";

export default function FolderScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { colors } = useTheme();
  const { sort, setSort } = useSort();
  const { data: videos, isLoading } = useFolderVideos(id);
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const selection = useSelection();
  const entries = usePlaybackEntries();

  // Hardware back exits selection mode first (before leaving the screen).
  const { active: selectionActive, clear: clearSelection } = selection;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (selectionActive) {
          clearSelection();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [selectionActive, clearSelection]),
  );

  const sortedVideos = useMemo(
    () => (videos ? sortVideos(videos, sort) : undefined),
    [videos, sort],
  );

  // The most recently watched video in this folder (for the resume FAB).
  const lastWatched = useMemo<VideoAsset | undefined>(() => {
    if (!sortedVideos) return undefined;
    let best: VideoAsset | undefined;
    let bestTime = -1;
    for (const video of sortedVideos) {
      const entry = entries[video.id];
      if (entry && entry.updatedAt > bestTime) {
        bestTime = entry.updatedAt;
        best = video;
      }
    }
    return best;
  }, [sortedVideos, entries]);

  const openPlayer = (videoId: string) =>
    router.push({ pathname: "/player", params: { albumId: id, id: videoId } });

  const onRowPress = (videoId: string) => {
    if (selection.active) selection.toggle(videoId);
    else openPlayer(videoId);
  };

  const confirmDelete = async () => {
    setConfirmOpen(false);
    try {
      await deleteVideos([...selection.selectedIds]);
      selection.clear();
      await queryClient.invalidateQueries({
        queryKey: videoKeys.folder(id),
      });
      await queryClient.invalidateQueries({
        queryKey: videoKeys.folders,
      });
    } catch {
      // User cancelled the system delete dialog, or it failed.
    }
  };

  // Resume FAB: play the last-watched video (or the first if none watched yet).
  const onPlayPress = () => {
    const target = lastWatched ?? sortedVideos?.[0];
    if (target) openPlayer(target.id);
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {/* Header — swaps to a selection bar while items are selected. */}
      {selection.active ? (
        <View className="flex-row items-center gap-2 px-2 py-1">
          <Pressable
            onPress={selection.clear}
            hitSlop={10}
            className="p-2 active:opacity-70"
          >
            <Icon name="xmark" size={22} color={colors.text} />
          </Pressable>
          <ThemedText type="subtitle" className="flex-1">
            {selection.count} selected
          </ThemedText>
          <Pressable
            onPress={() => setConfirmOpen(true)}
            hitSlop={10}
            className="p-2 active:opacity-70"
          >
            <Icon name="trash" size={22} color="#ef4444" />
          </Pressable>
        </View>
      ) : (
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
      )}

      <FlatList
        data={sortedVideos}
        keyExtractor={(item) => item.id}
        // Re-render rows when the selection changes (otherwise the checkmark
        // never updates, since the data array itself is unchanged).
        extraData={selection.selectedIds}
        contentContainerClassName="gap-1.5 px-4 pb-28 pt-1"
        renderItem={({ item }) => (
          <VideoRow
            video={item}
            onPress={() => onRowPress(item.id)}
            onLongPress={() => selection.toggle(item.id)}
            selectionActive={selection.active}
            selected={selection.isSelected(item.id)}
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

      {/* Resume / play FAB */}
      {!selection.active && !!sortedVideos?.length && (
        <Pressable
          onPress={onPlayPress}
          className="absolute bottom-6 right-6 h-16 w-16 items-center justify-center rounded-full bg-blue-500 active:opacity-80"
          style={{
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 3 },
            elevation: 6,
          }}
        >
          <Icon name="play" size={26} color="#ffffff" />
        </Pressable>
      )}

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
            className="rounded-t-3xl px-2 pb-10 pt-3"
            style={{ backgroundColor: colors.background }}
          >
            <View className="mb-4 items-center">
              <View
                className="h-1 w-10 rounded-full"
                style={{ backgroundColor: colors.backgroundSelected }}
              />
            </View>
            <View className="mb-4 flex-row items-center justify-between px-1">
              <ThemedText type="subtitle">Sort by</ThemedText>
              <Pressable
                onPress={() => setFilterOpen(false)}
                hitSlop={10}
                className="active:opacity-70"
              >
                <Icon name="xmark" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <SortOptionsList
              value={sort}
              onChange={(option) => {
                setSort(option);
                setFilterOpen(false);
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      <ConfirmSheet
        visible={confirmOpen}
        title={`Delete ${selection.count} video${selection.count === 1 ? "" : "s"}?`}
        message="The selected videos will be permanently deleted from this device."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </SafeAreaView>
  );
}

import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { FolderCard } from "@/components/folder-card";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useMediaPermissions } from "@/hooks/use-permissions";
import { useSelection } from "@/hooks/use-selection";
import { useTheme } from "@/hooks/use-theme";
import { useVideoFolders, videoKeys } from "@/hooks/use-video-folders";
import { deleteFolders } from "@/lib/media";

export default function FoldersScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const {
    data: folders,
    isLoading,
    isRefetching,
    refetch,
  } = useVideoFolders(granted);
  const selection = useSelection();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Hardware back exits folder-selection mode first.
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

  const confirmDelete = async () => {
    setConfirmOpen(false);
    try {
      await deleteFolders([...selection.selectedIds]);
      selection.clear();
      await queryClient.invalidateQueries({ queryKey: videoKeys.folders });
    } catch {
      // User cancelled the system dialog, or it failed.
    }
  };

  const header = selection.active ? (
    <View className="flex-row items-center gap-2 px-2 pb-3 pt-2">
      <Pressable
        onPress={selection.clear}
        hitSlop={10}
        className="p-2 active:opacity-70"
      >
        <Icon name="xmark" size={24} color={colors.text} />
      </Pressable>
      <ThemedText type="subtitle" className="flex-1">
        {selection.count} selected
      </ThemedText>
      <Pressable
        onPress={() => setConfirmOpen(true)}
        hitSlop={10}
        className="p-2 active:opacity-70"
      >
        <Icon name="trash" size={24} color="#ef4444" />
      </Pressable>
    </View>
  ) : (
    <View className="flex-row items-start justify-between px-4 pb-3 pt-2">
      <View className="flex-1">
        <ThemedText type="title">Library</ThemedText>
        <ThemedText type="muted" className="mt-1">
          {granted
            ? `${folders?.length ?? 0} folder${folders?.length === 1 ? "" : "s"}`
            : "Your videos"}
        </ThemedText>
      </View>
      <View className="mt-1 flex-row items-center gap-1 gap-x-2">
        {/* WhatsApp statuses + zip files live in shared storage; Android only. */}
        {Platform.OS === "android" && (
          <>
            <Pressable
              onPress={() => router.push("/status-saver")}
              hitSlop={10}
              className="p-1 active:opacity-70"
            >
              <Icon name="whatsapp" size={24} color={colors.text} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/archives")}
              hitSlop={10}
              className="p-1 active:opacity-70"
            >
              <Icon name="archive" size={24} color={colors.text} />
            </Pressable>
          </>
        )}
        <Pressable
          onPress={() => router.push("/settings")}
          hitSlop={10}
          className="p-1 active:opacity-70"
        >
          <Icon name="settings" size={24} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );

  if (!granted) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
        {header}
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Icon name="lock" size={56} color={colors.textSecondary} />
          <ThemedText type="subtitle" className="text-center">
            Access your videos
          </ThemedText>
          <ThemedText type="muted" className="text-center">
            Grant access to your media library to browse the video folders on
            this device.
          </ThemedText>
          <Pressable
            onPress={requestPermission}
            className="mt-2 rounded-full bg-accent px-6 py-3 active:opacity-80"
          >
            <ThemedText className="font-semibold text-accent-foreground">
              Grant access
            </ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <FlatList
        data={folders}
        keyExtractor={(item) => item.id}
        // Re-render cards when the selection changes so the checkmark updates.
        extraData={selection.selectedIds}
        ListHeaderComponent={header}
        contentContainerClassName="gap-2.5 px-4 pb-8"
        renderItem={({ item }) => (
          <FolderCard
            folder={item}
            selectionActive={selection.active}
            selected={selection.isSelected(item.id)}
            onLongPress={() => selection.toggle(item.id)}
            onPress={() => {
              if (selection.active) {
                selection.toggle(item.id);
              } else {
                router.push({
                  pathname: "/folder/[id]",
                  params: { id: item.id, title: item.title },
                });
              }
            }}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? (
            <View className="mt-24 items-center">
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : (
            <View className="mt-24 items-center gap-3 px-8">
              <Icon name="library" size={48} color={colors.textSecondary} />
              <ThemedText type="muted" className="text-center">
                No video folders found on this device.
              </ThemedText>
            </View>
          )
        }
      />

      <ConfirmSheet
        visible={confirmOpen}
        title={`Delete ${selection.count} folder${selection.count === 1 ? "" : "s"}?`}
        message="The videos in the selected folders will be permanently deleted from this device."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </SafeAreaView>
  );
}

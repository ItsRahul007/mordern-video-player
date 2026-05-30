import { Icon } from "@/components/icon";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FolderCard } from "@/components/folder-card";
import { ThemedText } from "@/components/themed-text";
import { useMediaPermissions } from "@/hooks/use-permissions";
import { useTheme } from "@/hooks/use-theme";
import { useVideoFolders } from "@/hooks/use-video-folders";

export default function FoldersScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { granted, canAskAgain, requestPermission } = useMediaPermissions();
  const {
    data: folders,
    isLoading,
    isRefetching,
    refetch,
  } = useVideoFolders(granted);

  const header = (
    <View className="flex-row items-start justify-between px-4 pb-3 pt-2">
      <View className="flex-1">
        <ThemedText type="title">Library</ThemedText>
        <ThemedText type="muted" className="mt-1">
          {granted
            ? `${folders?.length ?? 0} folder${folders?.length === 1 ? "" : "s"}`
            : "Your videos"}
        </ThemedText>
      </View>
      <Pressable
        onPress={() => router.push("/settings")}
        hitSlop={10}
        className="mt-1 p-1 active:opacity-70"
      >
        <Icon name="settings" size={24} color={colors.text} />
      </Pressable>
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
              {canAskAgain ? "Grant access" : "Open settings"}
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
        ListHeaderComponent={header}
        contentContainerClassName="gap-2.5 px-4 pb-8"
        renderItem={({ item }) => (
          <FolderCard
            folder={item}
            onPress={() =>
              router.push({
                pathname: "/folder/[id]",
                params: { id: item.id, title: item.title },
              })
            }
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
    </SafeAreaView>
  );
}

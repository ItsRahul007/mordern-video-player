import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { GalleryBrowser } from "@/components/gallery/gallery-browser";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

/** One gallery album: the photo + video timeline scoped to that folder. */
export default function AlbumScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: colors.background }} edges={["top"]}>
      <GalleryBrowser
        albumId={id}
        enabled={!!id}
        emptyText="This album is empty."
        renderHeader={({ openSearch }) => (
          <View className="flex-row items-center gap-2 px-2 pb-2 pt-1">
            <Pressable onPress={() => router.back()} hitSlop={10} className="p-2 active:opacity-70">
              <Icon name="back" size={22} color={colors.text} />
            </Pressable>
            <ThemedText type="subtitle" numberOfLines={1} className="flex-1">
              {title ?? "Album"}
            </ThemedText>
            <Pressable
              onPress={openSearch}
              hitSlop={10}
              accessibilityLabel="Search this album"
              className="p-2 active:opacity-70"
            >
              <Icon name="search" size={22} color={colors.text} />
            </Pressable>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

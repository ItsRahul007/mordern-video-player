import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AlbumCard } from "@/components/gallery/album-card";
import { GalleryBrowser } from "@/components/gallery/gallery-browser";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useGalleryAlbums, useGalleryLibrarySync } from "@/hooks/use-gallery";
import { useMediaPermissions } from "@/hooks/use-permissions";
import { useTheme } from "@/hooks/use-theme";
import type { GalleryAlbum } from "@/lib/gallery";

type Segment = "photos" | "albums";

function SegmentedControl({
  value,
  onChange,
}: {
  value: Segment;
  onChange: (value: Segment) => void;
}) {
  const { colors } = useTheme();
  const options: { value: Segment; label: string }[] = [
    { value: "photos", label: "Photos" },
    { value: "albums", label: "Albums" },
  ];
  return (
    <View
      className="flex-row rounded-full p-1"
      style={{ backgroundColor: colors.backgroundElement }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            className="rounded-full px-4 py-1.5"
            style={active ? { backgroundColor: colors.background } : undefined}
          >
            <ThemedText
              type="small"
              className={active ? "font-semibold" : ""}
              style={{ color: active ? colors.text : colors.textSecondary }}
            >
              {o.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

function AlbumsView({ header }: { header: React.ReactNode }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const { data: albums, isLoading, isRefetching, refetch } = useGalleryAlbums();
  const gap = 14;
  const cardWidth = Math.floor((width - 16 * 2 - gap) / 2);

  const openAlbum = useCallback(
    (album: GalleryAlbum) =>
      router.push({
        pathname: "/album/[id]",
        params: { id: album.id, title: album.title },
      }),
    [router],
  );

  return (
    <>
      {header}
      <FlatList
        data={albums}
        keyExtractor={(a) => a.id}
        numColumns={2}
        columnWrapperStyle={{ gap, paddingHorizontal: 16 }}
        contentContainerStyle={{ gap: 18, paddingTop: 8, paddingBottom: 24 }}
        renderItem={({ item }) => (
          <AlbumCard album={item} width={cardWidth} onPress={openAlbum} />
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
            <View className="mt-24 items-center px-8">
              <ThemedText type="muted">No albums found.</ThemedText>
            </View>
          )
        }
      />
    </>
  );
}

export default function GalleryScreen() {
  const { colors } = useTheme();
  const { granted, requestPermission } = useMediaPermissions();
  const [segment, setSegment] = useState<Segment>("photos");
  useGalleryLibrarySync(granted);

  const titleRow = (
    <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
      <ThemedText type="title">Gallery</ThemedText>
      {granted && <SegmentedControl value={segment} onChange={setSegment} />}
    </View>
  );

  if (!granted) {
    return (
      <SafeAreaView className="flex-1" style={{ backgroundColor: colors.background }} edges={["top"]}>
        {titleRow}
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Icon name="gallery" size={56} color={colors.textSecondary} />
          <ThemedText type="subtitle" className="text-center">
            Access your photos & videos
          </ThemedText>
          <ThemedText type="muted" className="text-center">
            Grant access to your media library to browse every photo and video on this device.
          </ThemedText>
          <Pressable
            onPress={requestPermission}
            className="mt-2 rounded-full px-6 py-3 active:opacity-80"
            style={{ backgroundColor: colors.accent }}
          >
            <ThemedText className="font-semibold text-white">Grant access</ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: colors.background }} edges={["top"]}>
      {segment === "photos" ? (
        <GalleryBrowser enabled={granted} renderHeader={() => titleRow} />
      ) : (
        <AlbumsView header={titleRow} />
      )}
    </SafeAreaView>
  );
}

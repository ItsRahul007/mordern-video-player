import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { AlbumCard } from "@/components/gallery/album-card";
import { SkeletonBlock, useSkeletonClock } from "@/components/gallery/skeleton";
import { useTabBarInset } from "@/components/gallery/tab-bar";
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

/** Placeholder album cards (cover + title + count), same size as the real ones. */
function AlbumsSkeleton({
  cardWidth,
  gap,
  clock,
}: {
  cardWidth: number;
  gap: number;
  clock: SharedValue<number>;
}) {
  return (
    <View className="flex-row flex-wrap px-4" style={{ columnGap: gap, rowGap: 18 }}>
      {Array.from({ length: 6 }, (_, i) => {
        const phase = Math.floor(i / 2) * 0.15;
        return (
          <View key={i} style={{ width: cardWidth }}>
            <SkeletonBlock
              clock={clock}
              phase={phase}
              style={{ width: cardWidth, height: cardWidth, borderRadius: 16 }}
            />
            <SkeletonBlock
              clock={clock}
              phase={phase + 0.05}
              style={{ width: cardWidth * 0.6, height: 12, borderRadius: 6, marginTop: 10 }}
            />
            <SkeletonBlock
              clock={clock}
              phase={phase + 0.08}
              style={{ width: cardWidth * 0.4, height: 10, borderRadius: 5, marginTop: 6 }}
            />
          </View>
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
  const clock = useSkeletonClock();
  const tabBarInset = useTabBarInset();
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
        contentContainerStyle={{ gap: 18, paddingTop: 8, paddingBottom: 24 + tabBarInset }}
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
            <AlbumsSkeleton cardWidth={cardWidth} gap={gap} clock={clock} />
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
  const { permission, granted, requestPermission } = useMediaPermissions();
  const tabBarInset = useTabBarInset();
  // On a cold start the permission is unknown for a moment — that's loading,
  // not "denied", so don't flash the grant-access screen.
  const checking = permission == null;
  const [segment, setSegment] = useState<Segment>("photos");
  useGalleryLibrarySync(granted);

  const titleRow = (onSearch?: () => void) => (
    <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
      <ThemedText type="title">Gallery</ThemedText>
      {(granted || checking) && (
        <View className="flex-row items-center gap-2">
          {onSearch && (
            <Pressable
              onPress={onSearch}
              hitSlop={8}
              accessibilityLabel="Search photos and videos"
              className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
              style={{ backgroundColor: colors.backgroundElement }}
            >
              <Icon name="search" size={20} color={colors.text} />
            </Pressable>
          )}
          <SegmentedControl value={segment} onChange={setSegment} />
        </View>
      )}
    </View>
  );

  if (!granted && !checking) {
    return (
      <SafeAreaView className="flex-1" style={{ backgroundColor: colors.background }} edges={["top"]}>
        {titleRow()}
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
        <GalleryBrowser
          enabled={granted}
          loading={checking}
          bottomInset={tabBarInset}
          renderHeader={({ openSearch }) => titleRow(openSearch)}
        />
      ) : (
        <AlbumsView header={titleRow()} />
      )}
    </SafeAreaView>
  );
}

import { useIsFocused, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { AlbumCard } from "@/components/gallery/album-card";
import { SkeletonBlock, useSkeletonClock } from "@/components/gallery/skeleton";
import { useTabBarInset } from "@/components/gallery/tab-bar";
import { settlePager } from "@/components/gallery/tab-pager";
import { TabSwipe } from "@/components/gallery/tab-swipe";
import { GalleryBrowser } from "@/components/gallery/gallery-browser";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import {
  useGalleryAlbums,
  useGalleryLibrarySync,
  usePrefetchAlbums,
} from "@/hooks/use-gallery";
import { useMediaPermissions } from "@/hooks/use-permissions";
import { useTheme } from "@/hooks/use-theme";
import type { GalleryAlbum } from "@/lib/gallery";

type Segment = "photos" | "albums";

/** Build the Albums view this long after the Gallery tab is opened (after
 *  its data has been prefetched). */
const ALBUMS_WARM_MS = 2500;

/** Width of one option in the Photos/Albums switch (dp). */
const SEG_W = 78;
const SEG_H = 32;
const SEG_PAD = 4;
const SEGMENTS: { value: Segment; label: string }[] = [
  { value: "photos", label: "Photos" },
  { value: "albums", label: "Albums" },
];

/**
 * Photos / Albums switch. The pill slides with the same eased glide as the
 * tab pager, and each label crossfades between its resting and selected
 * look as the pill arrives — driven by one position (0 = Photos, 1 = Albums).
 */
function SegmentedControl({
  position,
  value,
  onChange,
}: {
  position: SharedValue<number>;
  value: Segment;
  onChange: (value: Segment) => void;
}) {
  const { colors } = useTheme();
  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * SEG_W }],
  }));
  return (
    <View
      className="flex-row rounded-full"
      style={{ padding: SEG_PAD, backgroundColor: colors.backgroundElement }}
    >
      <Animated.View
        pointerEvents="none"
        className="absolute rounded-full"
        style={[
          {
            top: SEG_PAD,
            left: SEG_PAD,
            width: SEG_W,
            height: SEG_H,
            backgroundColor: colors.background,
          },
          pillStyle,
        ]}
      />
      {SEGMENTS.map((o, index) => (
        <SegmentLabel
          key={o.value}
          index={index}
          label={o.label}
          selected={o.value === value}
          position={position}
          onPress={() => onChange(o.value)}
        />
      ))}
    </View>
  );
}

function SegmentLabel({
  index,
  label,
  selected,
  position,
  onPress,
}: {
  index: number;
  label: string;
  selected: boolean;
  position: SharedValue<number>;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  // Read `position` inside each style so Reanimated tracks it.
  const on = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.abs(position.get() - index)),
  }));
  const off = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.abs(position.get() - index)),
  }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      style={{ width: SEG_W, height: SEG_H }}
      className="items-center justify-center"
    >
      <Animated.View style={off}>
        <ThemedText type="small" style={{ color: colors.textSecondary }}>
          {label}
        </ThemedText>
      </Animated.View>
      <Animated.View className="absolute" style={on}>
        <ThemedText
          type="small"
          className="font-semibold"
          style={{ color: colors.text }}
        >
          {label}
        </ThemedText>
      </Animated.View>
    </Pressable>
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
    <View
      className="flex-row flex-wrap px-4"
      style={{ columnGap: gap, rowGap: 18 }}
    >
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
              style={{
                width: cardWidth * 0.6,
                height: 12,
                borderRadius: 6,
                marginTop: 10,
              }}
            />
            <SkeletonBlock
              clock={clock}
              phase={phase + 0.08}
              style={{
                width: cardWidth * 0.4,
                height: 10,
                borderRadius: 5,
                marginTop: 6,
              }}
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
      <TabSwipe>
        <FlatList
          data={albums}
          keyExtractor={(a) => a.id}
          numColumns={2}
          columnWrapperStyle={{ gap, paddingHorizontal: 16 }}
          contentContainerStyle={{
            gap: 18,
            paddingTop: 8,
            paddingBottom: 24 + tabBarInset,
          }}
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
      </TabSwipe>
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
  // 0 = Photos, 1 = Albums; drives the switch's pill and the view crossfade.
  const segPos = useSharedValue(0);
  // Albums is built in the background shortly after the Gallery appears
  // (its data is prefetched from Home), so the first switch is instant too.
  const [albumsMounted, setAlbumsMounted] = useState(false);
  // Only while the Gallery tab is actually showing (the pager mounts this
  // screen in the background at start-up — nothing album-related runs then).
  const focused = useIsFocused();
  usePrefetchAlbums(granted && focused && segment === "photos");
  useEffect(() => {
    if (!granted || !focused || albumsMounted) return;
    const t = setTimeout(() => setAlbumsMounted(true), ALBUMS_WARM_MS);
    return () => clearTimeout(t);
  }, [granted, focused, albumsMounted]);
  const changeSegment = useCallback(
    (next: Segment) => {
      setSegment(next);
      if (next === "albums") setAlbumsMounted(true);
      segPos.set(settlePager(segPos.get(), next === "albums" ? 1 : 0));
    },
    [segPos],
  );
  // Pure crossfade (no slide): each view carries its own copy of the
  // header, and the copies line up exactly — sliding them made the title and
  // switch appear doubled mid-transition.
  const photosStyle = useAnimatedStyle(() => ({ opacity: 1 - segPos.get() }));
  const albumsStyle = useAnimatedStyle(() => ({ opacity: segPos.get() }));
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
          <SegmentedControl
            position={segPos}
            value={segment}
            onChange={changeSegment}
          />
        </View>
      )}
    </View>
  );

  if (!granted && !checking) {
    return (
      <SafeAreaView
        className="flex-1"
        style={{ backgroundColor: colors.background }}
        edges={["top"]}
      >
        {titleRow()}
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Icon name="gallery" size={56} color={colors.textSecondary} />
          <ThemedText type="subtitle" className="text-center">
            Access your photos & videos
          </ThemedText>
          <ThemedText type="muted" className="text-center">
            Grant access to your media library to browse every photo and video
            on this device.
          </ThemedText>
          <Pressable
            onPress={requestPermission}
            className="mt-2 rounded-full px-6 py-3 active:opacity-80"
            style={{ backgroundColor: colors.accent }}
          >
            <ThemedText className="font-semibold text-white">
              Grant access
            </ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1"
      style={{ backgroundColor: colors.background }}
      edges={["top"]}
    >
      {/* Both views stay mounted once built, so switching is a crossfade
          between ready screens rather than a rebuild. The wrapper keeps the
          stacked (absolute) views below the safe-area padding. */}
      <View style={{ flex: 1 }}>
        <Animated.View
          style={[StyleSheet.absoluteFill, photosStyle]}
          pointerEvents={segment === "photos" ? "auto" : "none"}
        >
          <GalleryBrowser
            enabled={granted}
            loading={checking}
            bottomInset={tabBarInset}
            swipeTo="/"
            renderHeader={({ openSearch }) => titleRow(openSearch)}
          />
        </Animated.View>
        {albumsMounted && (
          <Animated.View
            style={[StyleSheet.absoluteFill, albumsStyle]}
            pointerEvents={segment === "albums" ? "auto" : "none"}
          >
            <AlbumsView header={titleRow()} />
          </Animated.View>
        )}
      </View>
    </SafeAreaView>
  );
}

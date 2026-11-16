import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type ViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { MediaThumb } from "@/components/gallery/media-tile";
import { ZoomableImage } from "@/components/gallery/zoomable-image";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { galleryKeys, useGalleryItems } from "@/hooks/use-gallery";
import { useTheme } from "@/hooks/use-theme";
import { videoKeys } from "@/hooks/use-video-folders";
import { formatBytes, formatDuration } from "@/lib/format";
import {
  deleteGalleryItems,
  galleryItemSize,
  shareGalleryItems,
  type GalleryFilter,
  type GalleryItem,
} from "@/lib/gallery";

/**
 * Full-screen gallery viewer: swipe through the same list the grid showed
 * (same query cache, so it pages in more items as you go). Images display
 * contained; videos show a poster with a Play button that hands off to the
 * main player.
 */
export default function ViewerScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{
    filter: GalleryFilter;
    albumId?: string;
    /** Asset id of the tapped item (authoritative). */
    id?: string;
    /** Its position in the grid, used only as a fallback. */
    index?: string;
  }>();
  const albumId = params.albumId || undefined;
  const { items, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useGalleryItems(params.filter ?? "all", albumId);

  // Locate the tapped item by id so a list refresh can't open the wrong one.
  const [initialIndex] = useState(() => {
    const byId = params.id ? items.findIndex((m) => m.id === params.id) : -1;
    if (byId >= 0) return byId;
    return Math.min(
      Number(params.index ?? 0) || 0,
      Math.max(items.length - 1, 0),
    );
  });
  const [current, setCurrent] = useState(initialIndex);
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const item: GalleryItem | undefined = items[current];

  // Must stay referentially stable — FlatList throws if it changes.
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<GalleryItem>[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setCurrent(first.index);
    },
    [],
  );

  const openVideo = useCallback(
    (video: GalleryItem) => {
      router.push({
        pathname: "/player",
        params: albumId ? { albumId, id: video.id } : { uri: video.uri },
      });
    },
    [router, albumId],
  );

  const onShare = async () => {
    if (!item) return;
    try {
      await shareGalleryItems([item]);
    } catch (err) {
      console.warn("[viewer] share failed:", err);
    }
  };

  const confirmDelete = async () => {
    setConfirmOpen(false);
    if (!item) return;
    try {
      await deleteGalleryItems([item.id]);
      setZoomed(false); // the zoomed page unmounts without reporting
      await queryClient.invalidateQueries({ queryKey: galleryKeys.all });
      await queryClient.invalidateQueries({ queryKey: videoKeys.folders });
      if (items.length <= 1) router.back();
      else setCurrent((i) => Math.min(i, items.length - 2));
    } catch {
      // Cancelled or failed.
    }
  };

  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const renderItem = ({
    item: media,
    index,
  }: {
    item: GalleryItem;
    index: number;
  }) =>
    media.mediaType === "image" ? (
      <ZoomableImage
        uri={media.uri}
        recyclingKey={media.id}
        width={width}
        height={height}
        key={index === current ? media.id : `${media.id}-idle`}
        onZoomChange={setZoomed}
        onSingleTap={toggleChrome}
      />
    ) : (
      <Pressable onPress={toggleChrome} style={{ width, height }}>
        {
          <View
            style={{ width, height }}
            className="items-center justify-center"
          >
            {/* Fill the screen and let the decoded frame pick its own shape:
              media-store width/height ignore the video's rotation flag, so
              portrait clips would otherwise be drawn as landscape. */}
            <View style={{ width, height }}>
              <MediaThumb
                id={media.id}
                uri={media.uri}
                mediaType="video"
                fit="contain"
              />
            </View>
            <Pressable
              onPress={() => openVideo(media)}
              className="absolute h-20 w-20 items-center justify-center rounded-full bg-black/55 active:opacity-80"
            >
              <Icon name="play" size={36} color="#ffffff" />
            </Pressable>
          </View>
        }
      </Pressable>
    );

  return (
    <View className="flex-1 bg-black">
      <StatusBar style="light" hidden={!chrome} />

      {items.length > 0 && (
        <FlatList
          data={items}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          horizontal
          pagingEnabled
          // A zoomed photo pans instead of paging.
          scrollEnabled={!zoomed}
          extraData={current}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({
            length: width,
            offset: width * index,
            index,
          })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          onEndReachedThreshold={3}
        />
      )}

      {chrome && (
        <>
          <SafeAreaView
            edges={["top"]}
            className="absolute left-0 right-0 top-0 flex-row items-center bg-black/40 px-2 py-1"
          >
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              className="p-2 active:opacity-70"
            >
              <Icon name="back" size={24} color="#ffffff" />
            </Pressable>
            <View className="mx-1 flex-1">
              <ThemedText numberOfLines={1} type="small" className="text-white">
                {item?.filename ?? ""}
              </ThemedText>
              {!!item?.creationTime && (
                <ThemedText className="text-xs text-white/70">
                  {new Date(item.creationTime).toLocaleString()}
                </ThemedText>
              )}
            </View>
          </SafeAreaView>

          <SafeAreaView
            edges={["bottom"]}
            className="absolute bottom-0 left-0 right-0 flex-row items-center justify-around bg-black/40 py-2"
          >
            {Platform.OS === "android" && (
              <ViewerAction icon="share" label="Share" onPress={onShare} />
            )}
            <ViewerAction
              icon="info"
              label="Info"
              onPress={() => setInfoOpen(true)}
            />
            <ViewerAction
              icon="trash"
              label="Delete"
              onPress={() => setConfirmOpen(true)}
            />
          </SafeAreaView>
        </>
      )}

      <InfoSheet
        item={infoOpen ? item : undefined}
        onClose={() => setInfoOpen(false)}
      />

      <ConfirmSheet
        visible={confirmOpen}
        title={`Delete this ${item?.mediaType === "video" ? "video" : "photo"}?`}
        message="It will be permanently deleted from this device."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </View>
  );
}

function ViewerAction({
  icon,
  label,
  onPress,
}: {
  icon: "share" | "info" | "trash";
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      className="items-center gap-1 px-4 py-1 active:opacity-70"
    >
      <Icon
        name={icon}
        size={22}
        color={icon === "trash" ? "#f87171" : "#ffffff"}
      />
      <ThemedText className="text-xs text-white">{label}</ThemedText>
    </Pressable>
  );
}

function InfoSheet({
  item,
  onClose,
}: {
  item?: GalleryItem;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const size = useMemo(() => (item ? galleryItemSize(item.uri) : null), [item]);

  const rows: [string, string][] = item
    ? [
        ["Name", item.filename],
        ["Type", item.mediaType === "video" ? "Video" : "Photo"],
        [
          "Date",
          item.creationTime
            ? new Date(item.creationTime).toLocaleString()
            : "Unknown",
        ],
        [
          "Resolution",
          item.width && item.height
            ? `${item.width} × ${item.height}`
            : "Unknown",
        ],
        ...(item.mediaType === "video" && item.duration > 0
          ? ([["Duration", formatDuration(item.duration)]] as [
              string,
              string,
            ][])
          : []),
        ["Size", size != null ? formatBytes(size) : "Unknown"],
        ["Path", item.uri.replace(/^file:\/\//, "")],
      ]
    : [];

  return (
    <Modal
      visible={!!item}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-3xl px-5 pb-10 pt-3"
          style={{ backgroundColor: colors.background }}
        >
          <View className="mb-4 items-center">
            <View
              className="h-1 w-10 rounded-full"
              style={{ backgroundColor: colors.backgroundSelected }}
            />
          </View>
          <ThemedText type="subtitle" className="mb-3">
            Details
          </ThemedText>
          {rows.map(([label, value]) => (
            <View key={label} className="flex-row gap-4 py-2">
              <ThemedText type="muted" className="w-24">
                {label}
              </ThemedText>
              <ThemedText type="small" className="flex-1" selectable>
                {value}
              </ThemedText>
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

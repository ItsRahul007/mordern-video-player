import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { MediaThumb, MediaTile } from "@/components/gallery/media-tile";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import {
  buildTimeline,
  type GalleryItem,
  type TimelineGrouping,
  type TimelineRow,
} from "@/lib/gallery";

const GAP = 2;
const MONTH_HEADER_HEIGHT = 48;
const GROUP_HEADER_HEIGHT = 34;

/** Columns per row at each zoom step: 3 (most zoomed in) … 15 (most zoomed out). */
export const GRID_ZOOM_LEVELS = [3, 4, 5, 7, 9, 12, 15] as const;

/** Sub-grouping under each month, by density: days → weeks → months only. */
function groupingFor(columns: number): TimelineGrouping {
  if (columns <= 4) return "day";
  if (columns <= 7) return "week";
  return "month";
}

/** Above this many columns tiles are tiny: no duration text, one hit target per row. */
const COMPACT_FROM = 7;

/** Visual scale limits while pinching (the grid follows the fingers within these). */
const MIN_VISUAL = 0.35;
const MAX_VISUAL = 2.5;
const SPRING = { damping: 22, stiffness: 240, mass: 0.6 };

/**
 * Pick the zoom level after a pinch: the level whose column count best
 * matches what the fingers asked for (columns ÷ scale). Any deliberate pinch
 * moves at least one step.
 */
function targetLevel(level: number, scale: number): number {
  const wanted = GRID_ZOOM_LEVELS[level] / scale;
  let best = level;
  let bestDist = Infinity;
  GRID_ZOOM_LEVELS.forEach((cols, i) => {
    const dist = Math.abs(Math.log(cols / wanted));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  if (best === level) {
    if (scale < 0.88) best = level + 1;
    else if (scale > 1.14) best = level - 1;
  }
  return Math.min(GRID_ZOOM_LEVELS.length - 1, Math.max(0, best));
}

type Layout = {
  columns: number;
  rows: TimelineRow[];
  /** offsets[i] = top of row i; offsets[rows.length] = content height. */
  offsets: number[];
  tileSize: number;
  rowHeight: number;
};

function computeLayout(items: GalleryItem[], columns: number, width: number): Layout {
  const rows = buildTimeline(items, columns, groupingFor(columns));
  const tileSize = (width - GAP * (columns - 1)) / columns;
  const rowHeight = tileSize + GAP;
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  rows.forEach((row, i) => {
    const h =
      row.kind === "month"
        ? MONTH_HEADER_HEIGHT
        : row.kind === "group"
          ? GROUP_HEADER_HEIGHT
          : rowHeight;
    offsets[i + 1] = offsets[i] + h;
  });
  return { columns, rows, offsets, tileSize, rowHeight };
}

/** Index of the row containing content offset `y` (binary search). */
function rowAt(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

type MediaGridProps = {
  items: GalleryItem[];
  isLoading: boolean;
  isRefreshing: boolean;
  isFetchingMore: boolean;
  onRefresh: () => void;
  onEndReached: () => void;
  emptyText: string;
  selectedIds: ReadonlySet<string>;
  onPressItem: (item: GalleryItem, index: number) => void;
  onLongPressItem: (item: GalleryItem) => void;
};

/**
 * Timeline grid with sticky month headers and day/week sub-headers.
 *
 * Pinch zoom works like a photos app: while the fingers move, the grid just
 * scales under them (a UI-thread transform — no React work), and on release
 * it switches to the closest column count once, keeping the photo under the
 * fingers in place, then settles from the pinched size.
 */
export function MediaGrid({
  items,
  isLoading,
  isRefreshing,
  isFetchingMore,
  onRefresh,
  onEndReached,
  emptyText,
  selectedIds,
  onPressItem,
  onLongPressItem,
}: MediaGridProps) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<TimelineRow>>(null);

  // Default is the most zoomed-in level (3 per row).
  const [zoomLevel, setZoomLevel] = useState(0);
  const layout = useMemo(
    () => computeLayout(items, GRID_ZOOM_LEVELS[zoomLevel], width),
    [items, zoomLevel, width],
  );
  const { rows, offsets, tileSize, rowHeight, columns } = layout;
  const compact = columns >= COMPACT_FROM;

  const getItemLayout = useCallback(
    (_: ArrayLike<TimelineRow> | null | undefined, index: number) => ({
      length: offsets[index + 1] - offsets[index],
      offset: offsets[index],
      index,
    }),
    [offsets],
  );

  const stickyIndices = useMemo(
    () => rows.flatMap((row, i) => (row.kind === "month" ? [i] : [])),
    [rows],
  );

  // --- Scroll tracking (for anchoring) --------------------------------------
  // Shared values (not refs) so the React Compiler accepts reading them from
  // the pinch's end handler.
  const scrollY = useSharedValue(0);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.set(e.nativeEvent.contentOffset.y);
    },
    [scrollY],
  );

  // --- Pinch ----------------------------------------------------------------
  const [pinching, setPinching] = useState(false);
  const viewHeight = useSharedValue(0);
  const visualScale = useSharedValue(1);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  // Scroll offset to apply once the new layout has rendered.
  const pendingScroll = useSharedValue<number | null>(null);

  const settle = useCallback(
    (from: number) => {
      visualScale.set(from);
      visualScale.set(withSpring(1, SPRING));
    },
    [visualScale],
  );

  const commitPinch = useCallback(
    (scale: number, fx: number, fy: number) => {
      setPinching(false);
      const next = targetLevel(zoomLevel, scale);
      if (next === zoomLevel) {
        settle(scale);
        return;
      }
      // Cheap (one pass over the items); computed here so the scroll target
      // is known before the new layout renders.
      const nextLayout = computeLayout(items, GRID_ZOOM_LEVELS[next], width);

      // The photo under the fingers, and where in its row they were.
      const contentY = scrollY.get() + fy;
      let r = rowAt(offsets, contentY);
      while (r < rows.length && rows[r].kind !== "row") r++;
      const row = rows[r];
      if (row && row.kind === "row") {
        const col = Math.min(row.items.length - 1, Math.floor(fx / (tileSize + GAP)));
        const itemIndex = row.startIndex + Math.max(0, col);
        const within = Math.min(1, Math.max(0, (contentY - offsets[r]) / rowHeight));
        const nr = nextLayout.rows.findIndex(
          (x) =>
            x.kind === "row" &&
            itemIndex >= x.startIndex &&
            itemIndex < x.startIndex + x.items.length,
        );
        if (nr >= 0) {
          pendingScroll.set(
            Math.max(0, nextLayout.offsets[nr] + within * nextLayout.rowHeight - fy),
          );
        }
      }

      // Start the new layout at the size the old tiles had under the fingers,
      // then spring to rest — so the change reads as one continuous zoom.
      settle((tileSize * scale) / nextLayout.tileSize);
      setZoomLevel(next);
    },
    [zoomLevel, items, width, offsets, rows, tileSize, rowHeight, settle, scrollY, pendingScroll],
  );

  const onContentSizeChange = useCallback(() => {
    const y = pendingScroll.get();
    if (y == null) return;
    pendingScroll.set(null);
    listRef.current?.scrollToOffset({ offset: y, animated: false });
  }, [pendingScroll]);

  const native = Gesture.Native();
  const pinch = Gesture.Pinch()
    .simultaneousWithExternalGesture(native)
    .onStart((e) => {
      focalX.set(e.focalX);
      focalY.set(e.focalY);
      scheduleOnRN(setPinching, true);
    })
    .onUpdate((e) => {
      visualScale.set(Math.min(MAX_VISUAL, Math.max(MIN_VISUAL, e.scale)));
    })
    .onEnd(() => {
      scheduleOnRN(commitPinch, visualScale.get(), focalX.get(), focalY.get());
    })
    .onFinalize((_e, success) => {
      if (!success) {
        visualScale.set(withTiming(1, { duration: 150 }));
        scheduleOnRN(setPinching, false);
      }
    });

  // Scale around the pinch point.
  const zoomStyle = useAnimatedStyle(() => {
    const dx = focalX.get() - width / 2;
    const dy = focalY.get() - viewHeight.get() / 2;
    return {
      transform: [
        { translateX: dx },
        { translateY: dy },
        { scale: visualScale.get() },
        { translateX: -dx },
        { translateY: -dy },
      ],
    };
  });

  // --- Rendering ------------------------------------------------------------
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, i) => map.set(item.id, i));
    return map;
  }, [items]);

  const selectionActive = selectedIds.size > 0;

  const handlePress = useCallback(
    (id: string) => {
      const index = indexById.get(id);
      if (index !== undefined) onPressItem(items[index], index);
    },
    [indexById, items, onPressItem],
  );
  const handleLongPress = useCallback(
    (id: string) => {
      const index = indexById.get(id);
      if (index !== undefined) onLongPressItem(items[index]);
    },
    [indexById, items, onLongPressItem],
  );

  const renderItem = ({ item: row }: { item: TimelineRow }) => {
    if (row.kind === "month") {
      return (
        <View
          className="flex-row items-center justify-between px-4"
          style={{ height: MONTH_HEADER_HEIGHT, backgroundColor: colors.background }}
        >
          <ThemedText type="smallBold" className="text-lg">
            {row.title}
          </ThemedText>
          <ThemedText type="muted" className="text-xs">
            {row.count}
          </ThemedText>
        </View>
      );
    }
    if (row.kind === "group") {
      return (
        <View className="justify-center px-4" style={{ height: GROUP_HEADER_HEIGHT }}>
          <ThemedText type="small" style={{ color: colors.textSecondary }}>
            {row.title}
          </ThemedText>
        </View>
      );
    }
    if (compact) {
      return (
        <CompactRow
          items={row.items}
          tileSize={tileSize}
          rowHeight={rowHeight}
          selectedIds={selectedIds}
          selectionActive={selectionActive}
          onPress={handlePress}
          onLongPress={handleLongPress}
        />
      );
    }
    return (
      <View className="flex-row" style={{ gap: GAP, height: rowHeight, paddingBottom: GAP }}>
        {row.items.map((media) => (
          <MediaTile
            key={media.id}
            id={media.id}
            uri={media.uri}
            mediaType={media.mediaType}
            duration={media.duration}
            size={tileSize}
            selectionActive={selectionActive}
            selected={selectedIds.has(media.id)}
            onPress={handlePress}
            onLongPress={handleLongPress}
          />
        ))}
      </View>
    );
  };

  return (
    <GestureDetector gesture={pinch}>
      <Animated.View
        style={[{ flex: 1 }, zoomStyle]}
        onLayout={(e) => {
          viewHeight.set(e.nativeEvent.layout.height);
        }}
      >
        <GestureDetector gesture={native}>
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => row.key}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            extraData={selectedIds}
            stickyHeaderIndices={stickyIndices}
            // Two fingers on the grid mean zoom, not scroll.
            scrollEnabled={!pinching}
            onScroll={onScroll}
            scrollEventThrottle={32}
            onContentSizeChange={onContentSizeChange}
            onEndReached={onEndReached}
            onEndReachedThreshold={1.5}
            initialNumToRender={12}
            maxToRenderPerBatch={compact ? 6 : 8}
            updateCellsBatchingPeriod={30}
            windowSize={compact ? 5 : 9}
            // Must be explicitly false: FlatList defaults it to true on Android, and
            // on Fabric that crashes ("addViewAt: failed to insert view … index N")
            // when combined with sticky headers.
            removeClippedSubviews={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={onRefresh}
                tintColor={colors.textSecondary}
              />
            }
            ListFooterComponent={
              isFetchingMore ? (
                <View className="py-6">
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              isLoading ? (
                <View className="mt-24 items-center">
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              ) : (
                <View className="mt-24 items-center px-8">
                  <ThemedText type="muted" className="text-center">
                    {emptyText}
                  </ThemedText>
                </View>
              )
            }
          />
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * A row of tiny tiles with a single touch target (the tapped tile is worked
 * out from the touch position). At 9–15 columns this renders far fewer views
 * than one Pressable per tile, which keeps zoom changes and scrolling smooth.
 */
const CompactRow = memo(function CompactRow({
  items,
  tileSize,
  rowHeight,
  selectedIds,
  selectionActive,
  onPress,
  onLongPress,
}: {
  items: GalleryItem[];
  tileSize: number;
  rowHeight: number;
  selectedIds: ReadonlySet<string>;
  selectionActive: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
}) {
  const { colors } = useTheme();
  const hit = (e: GestureResponderEvent) =>
    items[Math.min(items.length - 1, Math.floor(e.nativeEvent.locationX / (tileSize + GAP)))];

  return (
    <Pressable
      onPress={(e) => {
        const item = hit(e);
        if (item) onPress(item.id);
      }}
      onLongPress={(e) => {
        const item = hit(e);
        if (item) onLongPress(item.id);
      }}
      delayLongPress={250}
      className="flex-row"
      style={{ gap: GAP, height: rowHeight, paddingBottom: GAP }}
    >
      {items.map((media) => {
        const selected = selectedIds.has(media.id);
        return (
          <View
            key={media.id}
            style={{ width: tileSize, height: tileSize, opacity: selected ? 0.5 : 1 }}
          >
            <MediaThumb id={media.id} uri={media.uri} mediaType={media.mediaType} />
            {media.mediaType === "video" && (
              <View className="absolute bottom-0.5 right-0.5 rounded-full bg-black/55 p-0.5">
                <Icon name="play" size={7} color="#ffffff" />
              </View>
            )}
            {selectionActive && selected && (
              <View
                className="absolute left-0.5 top-0.5 h-3 w-3 items-center justify-center rounded-full"
                style={{ backgroundColor: colors.accent }}
              >
                <Icon name="check" size={7} color="#ffffff" />
              </View>
            )}
          </View>
        );
      })}
    </Pressable>
  );
});

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  scrollTo,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { MediaThumb } from "@/components/gallery/media-tile";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { formatDuration } from "@/lib/format";
import { buildTimeline, type GalleryItem, type TimelineGrouping } from "@/lib/gallery";

const GAP = 2;
const MONTH_HEADER_HEIGHT = 48;
const GROUP_HEADER_HEIGHT = 34;

/** Columns per row at each zoom step: 3 (most zoomed in) … 15 (most zoomed out). */
export const GRID_ZOOM_LEVELS = [3, 4, 5, 7, 9, 12, 15] as const;
const LAST_LEVEL = GRID_ZOOM_LEVELS.length - 1;

/** Sub-grouping under each month, by density: days → weeks → months only. */
function groupingFor(columns: number): TimelineGrouping {
  if (columns <= 4) return "day";
  if (columns <= 7) return "week";
  return "month";
}

/** A level plus its immediate neighbours (the levels a pinch can reach first). */
function withNeighbours(level: number): number[] {
  return [level - 1, level, level + 1].filter((l) => l >= 0 && l <= LAST_LEVEL);
}

/** Release past this much of a transition completes it; otherwise it springs back. */
const COMMIT_AT = 0.4;
const SETTLE_MS = 200;

// ---------------------------------------------------------------------------
// Layout: absolute position of every tile and header at one zoom level.

type Header = {
  key: string;
  kind: "month" | "group";
  title: string;
  count: number;
  y: number;
};

type LevelLayout = {
  columns: number;
  tileSize: number;
  /** Per item index (same order as `items`). */
  x: number[];
  y: number[];
  headers: Header[];
  height: number;
};

function computeLevel(items: GalleryItem[], columns: number, width: number): LevelLayout {
  const tileSize = (width - GAP * (columns - 1)) / columns;
  const x = new Array<number>(items.length);
  const y = new Array<number>(items.length);
  const headers: Header[] = [];
  let cursor = 0;
  for (const row of buildTimeline(items, columns, groupingFor(columns))) {
    if (row.kind === "row") {
      row.items.forEach((_, c) => {
        x[row.startIndex + c] = c * (tileSize + GAP);
        y[row.startIndex + c] = cursor;
      });
      cursor += tileSize + GAP;
    } else {
      headers.push({ key: row.key, kind: row.kind, title: row.title, count: row.count, y: cursor });
      cursor += row.kind === "month" ? MONTH_HEADER_HEIGHT : GROUP_HEADER_HEIGHT;
    }
  }
  return { columns, tileSize, x, y, headers, height: cursor + 24 };
}

/** First index whose y is ≥ `value` (y is non-decreasing by index). */
function lowerBound(ys: number[], value: number): number {
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index range [start, end) of tiles overlapping content band [top, bottom]. */
function rangeFor(layout: LevelLayout, top: number, bottom: number): [number, number] {
  const start = lowerBound(layout.y, top - layout.tileSize);
  const end = lowerBound(layout.y, bottom + 1);
  return [start, end];
}

/** Worklet: tile index at content point (x, y) for a level, or -1. */
function hitTest(xs: number[], ys: number[], size: number, px: number, py: number): number {
  "worklet";
  // Binary search for the first tile whose row reaches py.
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] + size < py) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= ys.length) return -1;
  const rowY = ys[lo];
  if (py < rowY) return lo; // in a header gap: use the next tile
  for (let i = lo; i < ys.length && ys[i] === rowY; i++) {
    if (px >= xs[i] && px < xs[i] + size) return i;
  }
  return lo;
}

// ---------------------------------------------------------------------------

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
 * Timeline grid that reflows live while you pinch: every tile slides and
 * resizes from its place at the current column count to its place at the
 * next one, driven frame-by-frame by the fingers (UI thread). Keep pinching
 * to walk through several levels in one gesture; release completes or
 * springs back. The photo under the fingers stays under them throughout.
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
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  // Layouts for every zoom level (cheap: one pass over the items each).
  const layouts = useMemo(
    () => GRID_ZOOM_LEVELS.map((cols) => computeLevel(items, cols, width)),
    [items, width],
  );
  // The positional data, copied to the UI thread for the tile animations.
  // Set in an effect (not derived) so every mounted tile's animated style is
  // re-evaluated as soon as new positions land; the version also tells the
  // scroll reaction to refresh which tiles are mounted.
  const geometry = useSharedValue<{ x: number[]; y: number[]; s: number }[]>([]);
  const geometryVersion = useSharedValue(0);
  useEffect(() => {
    geometry.set(layouts.map((l) => ({ x: l.x, y: l.y, s: l.tileSize })));
    geometryVersion.set(geometryVersion.get() + 1);
  }, [layouts, geometry, geometryVersion]);

  // Committed zoom level (JS) — default is the most zoomed in (3 per row).
  const [level, setLevel] = useState(0);
  const layout = layouts[level];

  // Transition state (UI thread): tiles sit at lerp(from, to, progress).
  const fromLevel = useSharedValue(0);
  const toLevel = useSharedValue(0);
  const progress = useSharedValue(0);
  const transitioning = useSharedValue(false);

  const scrollY = useSharedValue(0);
  const viewHeight = useSharedValue(0);
  const [viewportH, setViewportH] = useState(0);

  // Anchor: the tile under the fingers, and where on it they are.
  const anchorIndex = useSharedValue(0);
  const anchorRel = useSharedValue(0);
  const anchorScreenY = useSharedValue(0);

  // Which levels' headers are mounted (more than one mid-transition), and
  // the mounted tile index range.
  // Neighbouring levels are kept mounted at rest (invisible) so a pinch
  // never has to build anything when it starts.
  const [activeLevels, setActiveLevels] = useState<number[]>(() => withNeighbours(0));
  // Start with roughly the first screen and a half mounted.
  const [range, setRange] = useState<[number, number]>(() => rangeFor(layouts[0], 0, 1400));
  const [pinching, setPinching] = useState(false);
  // Scroll lock while two fingers are down (UI thread, see the pinch).
  const scrollLocked = useSharedValue(false);
  const scrollProps = useAnimatedProps(() => ({ scrollEnabled: !scrollLocked.get() }));

  // --- Mounted range --------------------------------------------------------
  const computeRange = useCallback(
    (levels: number[], anchor: number | null, screenY: number, rel: number) => {
      const h = viewHeight.get() || 900;
      let start = Number.MAX_SAFE_INTEGER;
      let end = 0;
      for (const l of levels) {
        const lay = layouts[l];
        // Scroll position this level will have (anchored), or the current one.
        const top =
          anchor != null && lay.y[anchor] !== undefined
            ? lay.y[anchor] + rel * lay.tileSize - screenY
            : scrollY.get();
        const buffer = levels.length > 1 ? 0 : h * 0.5;
        const [s, e] = rangeFor(lay, top - buffer, top + h + buffer);
        start = Math.min(start, s);
        end = Math.max(end, e);
      }
      return [Math.min(start, end), end] as [number, number];
    },
    [layouts, scrollY, viewHeight],
  );

  /**
   * Tiles to keep mounted at rest for `lvl`: its own visible band (plus half
   * a screen each way) AND what each neighbouring level would show around the
   * same spot — so the tiles a pinch needs are already there when it starts.
   */
  const restingRange = useCallback(
    (lvl: number): [number, number] => {
      const h = viewHeight.get() || 900;
      const top = scrollY.get();
      const lay = layouts[lvl];
      let [start, end] = rangeFor(lay, top - h * 0.5, top + h * 1.5);
      const centre = Math.min(lowerBound(lay.y, top + h / 2), Math.max(0, lay.y.length - 1));
      for (const n of withNeighbours(lvl)) {
        if (n === lvl) continue;
        const nl = layouts[n];
        if (nl.y[centre] === undefined) continue;
        const t = nl.y[centre] + nl.tileSize / 2 - h / 2;
        const [s, e] = rangeFor(nl, t, t + h);
        start = Math.min(start, s);
        end = Math.max(end, e);
      }
      return [Math.min(start, end), end];
    },
    [layouts, scrollY, viewHeight],
  );

  const refreshRestingRange = useCallback(() => {
    const next = restingRange(level);
    setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
    if (next[1] >= items.length - layout.columns * 4) onEndReached();
  }, [restingRange, level, items.length, layout.columns, onEndReached]);

  // Re-evaluate the mounted range every quarter screen of scrolling, and
  // whenever the layouts change (new page loaded, rotation).
  useAnimatedReaction(
    () =>
      Math.floor(scrollY.get() / Math.max(1, viewHeight.get() * 0.25)) * 100000 +
      geometryVersion.get(),
    (key, prev) => {
      if (key !== prev && !transitioning.get()) scheduleOnRN(refreshRestingRange);
    },
  );

  // --- Pinch transition -------------------------------------------------------
  const beginTransition = useCallback(
    (anchor: number, screenY: number, rel: number) => {
      setPinching(true);
      // Usually already covered by the resting range; only grow if needed
      // (never shrink mid-gesture — that would unmount visible tiles).
      const [s, e] = computeRange(withNeighbours(level), anchor, screenY, rel);
      setRange((prev) =>
        s >= prev[0] && e <= prev[1] ? prev : [Math.min(prev[0], s), Math.max(prev[1], e)],
      );
    },
    [level, computeRange],
  );

  // Walked past a level mid-pinch: mount the next neighbour too.
  const extendTransition = useCallback(
    (newFrom: number) => {
      const levels = withNeighbours(newFrom);
      setActiveLevels((prev) => Array.from(new Set([...prev, ...levels])));
      setRange((prev) => {
        const [s, e] = computeRange(
          levels,
          anchorIndex.get(),
          anchorScreenY.get(),
          anchorRel.get(),
        );
        return [Math.min(prev[0], s), Math.max(prev[1], e)];
      });
    },
    [computeRange, anchorIndex, anchorScreenY, anchorRel],
  );

  const finishTransition = useCallback(
    (finalLevel: number) => {
      setPinching(false);
      scrollLocked.set(false);
      setLevel(finalLevel);
      setActiveLevels(withNeighbours(finalLevel));
      setRange(restingRange(finalLevel));
    },
    [restingRange, scrollLocked],
  );

  // Keep the anchor tile under the fingers as the layout changes.
  useAnimatedReaction(
    () =>
      transitioning.get() ? progress.get() + fromLevel.get() * 10 + toLevel.get() * 100 : -1,
    (key) => {
      if (key < 0) return;
      const g = geometry.get();
      const a = g[fromLevel.get()];
      const b = g[toLevel.get()];
      const i = anchorIndex.get();
      if (!a || !b || a.y[i] === undefined || b.y[i] === undefined) return;
      const p = progress.get();
      const size = a.s + (b.s - a.s) * p;
      const tileY = a.y[i] + (b.y[i] - a.y[i]) * p;
      const target = Math.max(0, tileY + anchorRel.get() * size - anchorScreenY.get());
      scrollTo(scrollRef, 0, target, false);
    },
  );

  const pinchBase = useSharedValue(1);
  const native = Gesture.Native();

  // Lock scrolling (and pull-to-refresh) the instant a second finger lands,
  // on the UI thread — waiting for the pinch to activate, or for a React
  // re-render, lets the list start scrolling/refreshing first.
  const unlockIfIdle = () => {
    "worklet";
    if (transitioning.get()) return; // finishTransition unlocks
    scrollLocked.set(false);
    scheduleOnRN(setPinching, false);
  };

  const pinch = Gesture.Pinch()
    .simultaneousWithExternalGesture(native)
    .onTouchesDown((e) => {
      if (e.numberOfTouches >= 2) {
        scrollLocked.set(true);
        scheduleOnRN(setPinching, true);
      }
    })
    .onStart((e) => {
      const g = geometry.get();
      const cur = g[fromLevel.get()];
      if (!cur) return;
      const cy = scrollY.get() + e.focalY;
      const hit = hitTest(cur.x, cur.y, cur.s, e.focalX, cy);
      if (hit < 0) return;
      anchorIndex.set(hit);
      anchorRel.set(Math.min(1, Math.max(0, (cy - cur.y[hit]) / cur.s)));
      anchorScreenY.set(e.focalY);
      pinchBase.set(e.scale);
      toLevel.set(fromLevel.get());
      progress.set(0);
      transitioning.set(true);
      scheduleOnRN(beginTransition, hit, e.focalY, anchorRel.get());
    })
    .onUpdate((e) => {
      if (!transitioning.get() || e.numberOfPointers < 2) return;
      const from = fromLevel.get();
      const s = e.scale / pinchBase.get();
      // Fingers together → zoom out (more columns); apart → zoom in.
      const target = s < 1 ? Math.min(from + 1, LAST_LEVEL) : Math.max(from - 1, 0);
      if (target === from) {
        progress.set(0);
        return;
      }
      if (toLevel.get() !== target) toLevel.set(target);
      // Progress = how far the tiles have grown/shrunk toward the target size.
      const full = GRID_ZOOM_LEVELS[from] / GRID_ZOOM_LEVELS[target];
      const p = Math.min(1, Math.max(0, (s - 1) / (full - 1)));
      if (p >= 1) {
        // Reached the next level mid-pinch: make it the new base and continue.
        fromLevel.set(target);
        pinchBase.set(e.scale);
        progress.set(0);
        scheduleOnRN(extendTransition, target);
        return;
      }
      progress.set(p);
    })
    .onEnd(() => {
      if (!transitioning.get()) return;
      const complete = progress.get() >= COMMIT_AT && toLevel.get() !== fromLevel.get();
      progress.set(
        withTiming(complete ? 1 : 0, { duration: SETTLE_MS }, (finished) => {
          if (!finished) return;
          const final = complete ? toLevel.get() : fromLevel.get();
          fromLevel.set(final);
          toLevel.set(final);
          progress.set(0);
          transitioning.set(false);
          scheduleOnRN(finishTransition, final);
        }),
      );
    })
    .onFinalize((_e, success) => {
      if (!transitioning.get()) {
        // Two fingers went down but never became a pinch.
        unlockIfIdle();
        return;
      }
      if (success) return;
      // Cancelled before it ever became a pinch: drop back to rest.
      const final = fromLevel.get();
      toLevel.set(final);
      progress.set(0);
      transitioning.set(false);
      scheduleOnRN(finishTransition, final);
    });

  // Taps / long-presses are resolved from the touch point (tiles have no
  // touch handlers of their own — far fewer views to mount and animate).
  const pressAt = useCallback(
    (index: number, long: boolean) => {
      const item = items[index];
      if (!item) return;
      if (long) onLongPressItem(item);
      else onPressItem(item, index);
    },
    [items, onPressItem, onLongPressItem],
  );
  const resolvePress = (px: number, py: number, long: boolean) => {
    "worklet";
    if (transitioning.get()) return;
    const cur = geometry.get()[fromLevel.get()];
    if (!cur) return;
    const cy = scrollY.get() + py;
    const i = hitTest(cur.x, cur.y, cur.s, px, cy);
    // Only a press actually on a tile counts (not a header or the gutter).
    if (i < 0 || cy < cur.y[i] || cy > cur.y[i] + cur.s) return;
    scheduleOnRN(pressAt, i, long);
  };
  const tap = Gesture.Tap()
    .maxDistance(10)
    .simultaneousWithExternalGesture(native)
    .onEnd((e, success) => {
      if (success) resolvePress(e.x, e.y, false);
    });
  const longPress = Gesture.LongPress()
    .minDuration(250)
    .maxDistance(10)
    .simultaneousWithExternalGesture(native)
    .onStart((e) => {
      resolvePress(e.x, e.y, true);
    });
  const gestures = Gesture.Simultaneous(pinch, Gesture.Exclusive(longPress, tap));

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.set(e.contentOffset.y);
    },
  });

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      viewHeight.set(e.nativeEvent.layout.height);
      setViewportH(e.nativeEvent.layout.height);
    },
    [viewHeight],
  );

  // --- Sticky month (current scroll position, committed level) --------------
  const [stickyMonth, setStickyMonth] = useState<Header | null>(null);
  const updateSticky = useCallback(
    (y: number) => {
      let current: Header | null = null;
      for (const h of layout.headers) {
        if (h.kind !== "month") continue;
        if (h.y <= y) current = h;
        else break;
      }
      setStickyMonth((prev) => (prev?.key === current?.key ? prev : current));
    },
    [layout.headers],
  );
  useAnimatedReaction(
    () => Math.floor(scrollY.get() / 8),
    (bucket, prev) => {
      if (bucket !== prev) scheduleOnRN(updateSticky, scrollY.get());
    },
  );

  // --- Render -----------------------------------------------------------------
  const selectionActive = selectedIds.size > 0;
  const contentHeight = Math.max(...activeLevels.map((l) => layouts[l].height), viewportH);
  const mounted = items.slice(range[0], range[1]);

  if (items.length === 0) {
    return (
      <View className="flex-1">
        {isLoading ? (
          <View className="mt-24 items-center">
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : (
          <View className="mt-24 items-center px-8">
            <ThemedText type="muted" className="text-center">
              {emptyText}
            </ThemedText>
          </View>
        )}
      </View>
    );
  }

  return (
    <GestureDetector gesture={gestures}>
      <View className="flex-1" onLayout={onLayout}>
        <GestureDetector gesture={native}>
          <Animated.ScrollView
            ref={scrollRef}
            onScroll={onScroll}
            scrollEventThrottle={16}
            // Two fingers on the grid mean zoom, not scroll.
            animatedProps={scrollProps}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={onRefresh}
                // Two fingers mean zoom: never start a refresh then.
                enabled={!pinching}
                // Start the spinner below the pinned month bar, not under it.
                progressViewOffset={MONTH_HEADER_HEIGHT}
                tintColor={colors.textSecondary}
              />
            }
          >
            <View style={{ height: contentHeight + (isFetchingMore ? 60 : 0) }}>
              {activeLevels.map((l) => (
                <LevelHeaders
                  key={`headers-${l}`}
                  level={l}
                  headers={layouts[l].headers}
                  fromLevel={fromLevel}
                  toLevel={toLevel}
                  progress={progress}
                  background={colors.background}
                  secondary={colors.textSecondary}
                />
              ))}
              {mounted.map((item, k) => (
                <GridTile
                  key={item.id}
                  item={item}
                  index={range[0] + k}
                  baseSize={layout.tileSize}
                  geometry={geometry}
                  fromLevel={fromLevel}
                  toLevel={toLevel}
                  progress={progress}
                  selected={selectedIds.has(item.id)}
                  selectionActive={selectionActive}
                  accent={colors.accent}
                />
              ))}
              {isFetchingMore && (
                <View
                  className="absolute left-0 right-0 items-center"
                  style={{ top: contentHeight }}
                >
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              )}
            </View>
          </Animated.ScrollView>
        </GestureDetector>

        {stickyMonth && (
          <View
            pointerEvents="none"
            className="absolute left-0 right-0 top-0 flex-row items-center justify-between px-4"
            style={{ height: MONTH_HEADER_HEIGHT, backgroundColor: colors.background }}
          >
            <ThemedText type="smallBold" className="text-lg">
              {stickyMonth.title}
            </ThemedText>
            <ThemedText type="muted" className="text-xs">
              {stickyMonth.count}
            </ThemedText>
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------

type Geometry = SharedValue<{ x: number[]; y: number[]; s: number }[]>;

/**
 * One thumbnail, absolutely positioned. Its spot and size are interpolated
 * on the UI thread between the "from" and "to" zoom levels. It's laid out at
 * `baseSize` and scaled from its top-left corner, so a transition never
 * triggers layout — only transforms.
 */
const GridTile = memo(function GridTile({
  item,
  index,
  baseSize,
  geometry,
  fromLevel,
  toLevel,
  progress,
  selected,
  selectionActive,
  accent,
}: {
  item: GalleryItem;
  index: number;
  baseSize: number;
  geometry: Geometry;
  fromLevel: SharedValue<number>;
  toLevel: SharedValue<number>;
  progress: SharedValue<number>;
  selected: boolean;
  selectionActive: boolean;
  accent: string;
}) {
  const style = useAnimatedStyle(() => {
    const g = geometry.get();
    const a = g[fromLevel.get()];
    const b = g[toLevel.get()];
    if (!a || !b || a.x[index] === undefined || b.x[index] === undefined) {
      return { opacity: 0 };
    }
    const p = progress.get();
    const x = a.x[index] + (b.x[index] - a.x[index]) * p;
    const y = a.y[index] + (b.y[index] - a.y[index]) * p;
    const size = a.s + (b.s - a.s) * p;
    return {
      opacity: 1,
      transform: [{ translateX: x }, { translateY: y }, { scale: size / baseSize }],
    };
  });

  const showDuration = item.mediaType === "video" && baseSize >= 90 && item.duration > 0;
  const small = baseSize < 60;

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: baseSize,
          height: baseSize,
          transformOrigin: "left top",
        },
        style,
      ]}
    >
      <View
        className="h-full w-full overflow-hidden"
        style={selected ? { transform: [{ scale: 0.86 }], borderRadius: 10 } : undefined}
      >
        <MediaThumb id={item.id} uri={item.uri} mediaType={item.mediaType} />
        {item.mediaType === "video" &&
          (showDuration ? (
            <View className="absolute bottom-1 right-1 flex-row items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5">
              <Icon name="play" size={10} color="#ffffff" />
              <ThemedText className="text-[11px] font-semibold text-white">
                {formatDuration(item.duration)}
              </ThemedText>
            </View>
          ) : (
            <View className="absolute bottom-0.5 right-0.5 rounded-full bg-black/55 p-0.5">
              <Icon name="play" size={small ? 7 : 10} color="#ffffff" />
            </View>
          ))}
      </View>
      {selectionActive && (
        <View
          className="absolute left-1 top-1 items-center justify-center rounded-full border-2"
          style={{
            width: small ? 12 : 20,
            height: small ? 12 : 20,
            borderColor: selected ? accent : "#ffffff",
            backgroundColor: selected ? accent : "rgba(0,0,0,0.25)",
          }}
        >
          {selected && <Icon name="check" size={small ? 7 : 12} color="#ffffff" />}
        </View>
      )}
    </Animated.View>
  );
});

/**
 * Month and day/week labels for one zoom level. Mid-transition both levels'
 * labels are mounted and crossfade (the outgoing level fades out as the
 * incoming one fades in), since grouping differs between levels.
 */
const LevelHeaders = memo(function LevelHeaders({
  level,
  headers,
  fromLevel,
  toLevel,
  progress,
  background,
  secondary,
}: {
  level: number;
  headers: Header[];
  fromLevel: SharedValue<number>;
  toLevel: SharedValue<number>;
  progress: SharedValue<number>;
  background: string;
  secondary: string;
}) {
  const style = useAnimatedStyle(() => {
    const from = fromLevel.get();
    const to = toLevel.get();
    const p = progress.get();
    let opacity = 0;
    if (level === from && level === to) opacity = 1;
    else if (level === from) opacity = 1 - p;
    else if (level === to) opacity = p;
    return { opacity };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, right: 0, top: 0 }, style]}
    >
      {headers.map((h) =>
        h.kind === "month" ? (
          <View
            key={h.key}
            className="absolute left-0 right-0 flex-row items-center justify-between px-4"
            style={{ top: h.y, height: MONTH_HEADER_HEIGHT, backgroundColor: background }}
          >
            <ThemedText type="smallBold" className="text-lg">
              {h.title}
            </ThemedText>
            <ThemedText type="muted" className="text-xs">
              {h.count}
            </ThemedText>
          </View>
        ) : (
          <View
            key={h.key}
            className="absolute left-0 right-0 justify-center px-4"
            style={{ top: h.y, height: GROUP_HEADER_HEIGHT }}
          >
            <ThemedText type="small" style={{ color: secondary }}>
              {h.title}
            </ThemedText>
          </View>
        ),
      )}
    </Animated.View>
  );
});

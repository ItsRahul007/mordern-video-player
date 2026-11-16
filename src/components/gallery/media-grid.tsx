import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  scrollTo,
  useAnimatedProps,
  useFrameCallback,
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
import { SkeletonBlock, useSkeletonClock } from "@/components/gallery/skeleton";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { formatDuration } from "@/lib/format";
import { buildTimeline, type GalleryItem, type TimelineGrouping } from "@/lib/gallery";

const GAP = 2;
/** Space under the last row. */
const BOTTOM_PADDING = 24;
/** Placeholder rows shown at the bottom while the next page loads. */
const FOOTER_ROWS = 2;
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

/**
 * Extra screens of tiles kept mounted above and below the viewport at rest.
 * Dense levels show hundreds of tiles per screen, so they get a thin margin.
 */
function bufferFor(columns: number): number {
  return columns >= 9 ? 0.15 : 0.5;
}

/** A level plus its immediate neighbours (the levels a pinch can reach first). */
function withNeighbours(level: number): number[] {
  return [level - 1, level, level + 1].filter((l) => l >= 0 && l <= LAST_LEVEL);
}

/** Hold this long on a tile to start selecting (and drag-selecting). */
const LONG_PRESS_MS = 250;
/** Drag-select auto-scrolls when the finger is this close to an edge (dp)… */
const AUTO_SCROLL_EDGE = 90;
/** …but only after the finger has moved this far since the hold began (dp). */
const AUTO_SCROLL_ARM = 16;
/** …at up to this many dp per frame. */
const AUTO_SCROLL_SPEED = 18;

/** While drag-selecting, React's selection state is synced at most this often (ms). */
const DRAG_SYNC_MS = 80;

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
  /** Index of the first item under this header (its items are start…start+count). */
  start: number;
};

type LevelLayout = {
  columns: number;
  tileSize: number;
  /** Per item index (same order as `items`). */
  x: Float64Array;
  y: Float64Array;
  headers: Header[];
  height: number;
};

function computeLevel(items: GalleryItem[], columns: number, width: number): LevelLayout {
  const tileSize = (width - GAP * (columns - 1)) / columns;
  // Typed arrays: copied to the UI thread as one block instead of element
  // by element (tens of thousands of numbers across all zoom levels).
  const x = new Float64Array(items.length);
  const y = new Float64Array(items.length);
  const headers: Header[] = [];
  let pending: Header[] = [];
  let cursor = 0;
  for (const row of buildTimeline(items, columns, groupingFor(columns))) {
    if (row.kind === "row") {
      // Headers come right before their first row.
      for (const h of pending) h.start = row.startIndex;
      pending = [];
      row.items.forEach((_, c) => {
        x[row.startIndex + c] = c * (tileSize + GAP);
        y[row.startIndex + c] = cursor;
      });
      cursor += tileSize + GAP;
    } else {
      const header: Header = {
        key: row.key,
        kind: row.kind,
        title: row.title,
        count: row.count,
        y: cursor,
        start: 0,
      };
      headers.push(header);
      pending.push(header);
      cursor += row.kind === "month" ? MONTH_HEADER_HEIGHT : GROUP_HEADER_HEIGHT;
    }
  }
  return { columns, tileSize, x, y, headers, height: cursor + BOTTOM_PADDING };
}

/** First index whose y is ≥ `value` (y is non-decreasing by index). */
function lowerBound(ys: Float64Array, value: number): number {
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

/**
 * Only the labels around the mounted tiles (like the tiles themselves) —
 * mounting every label in the library per zoom level is hundreds of views.
 */
function headersNear(layout: LevelLayout, range: [number, number]): Header[] {
  const [start, end] = range;
  if (end <= start || layout.y.length === 0) return [];
  const top = (layout.y[start] ?? 0) - MONTH_HEADER_HEIGHT - GROUP_HEADER_HEIGHT;
  const bottom = (layout.y[Math.min(end, layout.y.length) - 1] ?? 0) + layout.tileSize;
  return layout.headers.filter((h) => h.y >= top && h.y <= bottom);
}

/** Worklet: tile index at content point (x, y) for a level, or -1. */
function hitTest(xs: Float64Array, ys: Float64Array, size: number, px: number, py: number): number {
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
  /** Replace the selection (long-press, drag-select, select-a-group). */
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /** Reports the column count whenever the zoom level settles. */
  onColumnsChange?: (columns: number) => void;
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
  onSelectionChange,
  onColumnsChange,
}: MediaGridProps) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const skeletonClock = useSkeletonClock();

  // Layouts for every zoom level (cheap: one pass over the items each).
  const layouts = useMemo(
    () => GRID_ZOOM_LEVELS.map((cols) => computeLevel(items, cols, width)),
    [items, width],
  );
  // The positional data, copied to the UI thread for the tile animations.
  // Set in an effect (not derived) so every mounted tile's animated style is
  // re-evaluated as soon as new positions land; the version also tells the
  // scroll reaction to refresh which tiles are mounted.
  const geometry = useSharedValue<{ x: Float64Array; y: Float64Array; s: number }[]>([]);
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
        const buffer = levels.length > 1 ? 0 : h * bufferFor(lay.columns);
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
      const buf = h * bufferFor(lay.columns);
      let [start, end] = rangeFor(lay, top - buf, top + h + buf);
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
    // Ask for more ~2 screens ahead (in rows of the current size), so dense
    // zoomed-out grids don't fill in a few rows at a time.
    const rowsPerScreen = Math.ceil((viewHeight.get() || 900) / (layout.tileSize + GAP));
    if (next[1] >= items.length - layout.columns * rowsPerScreen * 2) onEndReached();
  }, [restingRange, level, items.length, layout.columns, layout.tileSize, viewHeight, onEndReached]);

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
      onColumnsChange?.(GRID_ZOOM_LEVELS[finalLevel]);
      setActiveLevels(withNeighbours(finalLevel));
      setRange(restingRange(finalLevel));
    },
    [restingRange, scrollLocked, onColumnsChange],
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

  // Taps are resolved from the touch point (tiles have no touch handlers of
  // their own — far fewer views to mount and animate).
  const selectionActive = selectedIds.size > 0;

  const pressAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) onPressItem(item, index);
    },
    [items, onPressItem],
  );

  /** Select every item under a header — or unselect them if all already are. */
  const toggleGroup = useCallback(
    (h: Header) => {
      const ids = items.slice(h.start, h.start + h.count).map((i) => i.id);
      const all = ids.every((id) => selectedIds.has(id));
      const next = new Set(selectedIds);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      onSelectionChange(next);
    },
    [items, selectedIds, onSelectionChange],
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

  /** A tap that missed the tiles: in selection mode, a date label toggles its group. */
  const pressHeader = useCallback(
    (contentY: number, screenY: number) => {
      if (!selectionActive) return;
      if (screenY < MONTH_HEADER_HEIGHT && stickyMonth) {
        toggleGroup(stickyMonth);
        return;
      }
      for (const h of layout.headers) {
        const height = h.kind === "month" ? MONTH_HEADER_HEIGHT : GROUP_HEADER_HEIGHT;
        if (contentY >= h.y && contentY < h.y + height) {
          toggleGroup(h);
          return;
        }
      }
    },
    [selectionActive, stickyMonth, layout.headers, toggleGroup],
  );

  /** Worklet: tile index under a screen point at the committed level (-1 if none). */
  const tileAt = (px: number, py: number, sy: number, exact: boolean) => {
    "worklet";
    const cur = geometry.get()[fromLevel.get()];
    if (!cur) return -1;
    const cy = sy + py;
    const i = hitTest(cur.x, cur.y, cur.s, px, cy);
    if (i < 0) return -1;
    // Forgive the thin gutter between rows; a press on a date label still misses.
    if (exact && (cy < cur.y[i] - GAP - 1 || cy > cur.y[i] + cur.s + GAP + 1)) return -1;
    return i;
  };

  const resolvePress = (px: number, py: number) => {
    "worklet";
    if (transitioning.get()) return;
    const sy = scrollY.get();
    // The pinned month bar covers the top of the grid.
    const i = py < MONTH_HEADER_HEIGHT ? -1 : tileAt(px, py, sy, true);
    if (i >= 0) scheduleOnRN(pressAt, i);
    else scheduleOnRN(pressHeader, sy + py, py);
  };

  const tap = Gesture.Tap()
    .maxDistance(10)
    .simultaneousWithExternalGesture(native)
    .onEnd((e, success) => {
      if (success) resolvePress(e.x, e.y);
    });

  // --- Drag-select ------------------------------------------------------------
  // Hold a tile, then (without lifting) drag: everything between it and the
  // finger is selected — or unselected, if the held tile was selected. Near
  // the top/bottom edge the grid auto-scrolls to keep extending.
  // Drag state lives in shared values (not React state) so every caller —
  // gesture callbacks and the auto-scroll frame loop — sees it immediately.
  const dragBase = useSharedValue<string[]>([]);
  const dragAnchor = useSharedValue(-1);
  const dragSelects = useSharedValue(true);

  /** Selection = `base` with every item between `anchor` and `to` (un)selected. */
  const applyDrag = useCallback(
    (base: Iterable<string>, anchor: number, select: boolean, to: number) => {
      const next = new Set(base);
      const lo = Math.min(anchor, to);
      const hi = Math.max(anchor, to);
      for (let i = lo; i <= hi; i++) {
        const id = items[i]?.id;
        if (!id) continue;
        if (select) next.add(id);
        else next.delete(id);
      }
      onSelectionChange(next);
    },
    [items, onSelectionChange],
  );

  // Later drag moves read the session from shared values. (Values written
  // from JS reach the UI runtime asynchronously, so the first move — in
  // beginDrag — uses its own locals instead of reading them back.)
  const updateDrag = useCallback(
    (to: number) => {
      const anchor = dragAnchor.get();
      if (anchor < 0) return;
      applyDrag(dragBase.get(), anchor, dragSelects.get(), to);
    },
    [applyDrag, dragAnchor, dragBase, dragSelects],
  );

  /** True once a drag session's anchor/mode have reached the UI thread. */
  const dragLive = useSharedValue(false);
  const lastPush = useSharedValue(0);
  /** Send the drag target to React at most every DRAG_SYNC_MS (tiles already
   *  show it instantly on the UI thread); the release always sends the last. */
  const pushDrag = (i: number) => {
    "worklet";
    const now = Date.now();
    if (now - lastPush.get() < DRAG_SYNC_MS) return;
    lastPush.set(now);
    scheduleOnRN(updateDrag, i);
  };

  const dragging = useSharedValue(false);
  /** Auto-scroll only arms once the finger has really moved after the hold,
   *  so holding a tile near an edge never scrolls by itself. */
  const dragArmed = useSharedValue(false);
  const dragStartX = useSharedValue(0);
  const dragStartY = useSharedValue(0);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragLast = useSharedValue(-1);
  const maxScroll = useSharedValue(0);

  const autoScroll = useFrameCallback(() => {
    if (!dragging.get() || !dragArmed.get()) return;
    const h = viewHeight.get();
    const y = dragY.get();
    const top = MONTH_HEADER_HEIGHT + AUTO_SCROLL_EDGE;
    let v = 0;
    if (y < top) v = -Math.min(1, (top - y) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_SPEED;
    else if (y > h - AUTO_SCROLL_EDGE)
      v = Math.min(1, (y - (h - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_SPEED;
    if (v === 0) return;
    const cur = scrollY.get();
    const next = Math.min(maxScroll.get(), Math.max(0, cur + v));
    if (next === cur) return;
    scrollTo(scrollRef, 0, next, false);
    scrollY.set(next);
    // Content moved under a still finger: extend to whatever is there now.
    const i = tileAt(dragX.get(), y, next, false);
    if (i >= 0 && i !== dragLast.get()) {
      dragLast.set(i);
      pushDrag(i);
    }
  }, false);

  const beginDrag = useCallback(
    (index: number) => {
      const id = items[index]?.id;
      if (!id) return;
      const base = [...selectedIds];
      const select = !selectedIds.has(id);
      dragBase.set(base);
      dragAnchor.set(index);
      dragSelects.set(select);
      dragLive.set(true);
      applyDrag(base, index, select, index);
      autoScroll.setActive(true);
    },
    [items, selectedIds, applyDrag, autoScroll, dragBase, dragAnchor, dragSelects, dragLive],
  );
  /** Release: apply the exact final range, then hand the visuals back to React. */
  const endDrag = useCallback(
    (last: number) => {
      updateDrag(last);
      dragLive.set(false);
      dragAnchor.set(-1);
      autoScroll.setActive(false);
    },
    [updateDrag, autoScroll, dragAnchor, dragLive],
  );

  const dragSelect = Gesture.Pan()
    .activateAfterLongPress(LONG_PRESS_MS)
    .simultaneousWithExternalGesture(native)
    .onStart((e) => {
      if (transitioning.get() || e.y < MONTH_HEADER_HEIGHT) return;
      const i = tileAt(e.x, e.y, scrollY.get(), true);
      if (i < 0) return;
      dragging.set(true);
      dragArmed.set(false);
      dragStartX.set(e.x);
      dragStartY.set(e.y);
      scrollLocked.set(true); // the drag selects; it must not scroll the list
      dragX.set(e.x);
      dragY.set(e.y);
      dragLast.set(i);
      lastPush.set(0);
      scheduleOnRN(beginDrag, i);
    })
    .onUpdate((e) => {
      if (!dragging.get()) return;
      dragX.set(e.x);
      dragY.set(e.y);
      if (
        !dragArmed.get() &&
        Math.hypot(e.x - dragStartX.get(), e.y - dragStartY.get()) > AUTO_SCROLL_ARM
      ) {
        dragArmed.set(true);
      }
      const i = tileAt(e.x, e.y, scrollY.get(), false);
      if (i >= 0 && i !== dragLast.get()) {
        dragLast.set(i);
        pushDrag(i);
      }
    })
    .onFinalize(() => {
      if (!dragging.get()) return;
      dragging.set(false);
      scrollLocked.set(false);
      scheduleOnRN(endDrag, dragLast.get());
    });

  const gestures = Gesture.Simultaneous(pinch, Gesture.Exclusive(dragSelect, tap));

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

  // --- Render -----------------------------------------------------------------
  const contentHeight = Math.max(...activeLevels.map((l) => layouts[l].height), viewportH);
  const mounted = items.slice(range[0], range[1]);

  // Shared values the tiles read to draw an in-progress drag instantly.
  const dragVisual = useMemo(
    () => ({ live: dragLive, anchor: dragAnchor, to: dragLast, select: dragSelects }),
    [dragLive, dragAnchor, dragLast, dragSelects],
  );

  // How far drag-select auto-scroll may go.
  useEffect(() => {
    maxScroll.set(Math.max(0, contentHeight - viewportH));
  }, [contentHeight, viewportH, maxScroll]);

  // Labels near the mounted tiles, per active level (stable until the range moves).
  const nearHeaders = useMemo(
    () => new Map(activeLevels.map((l) => [l, headersNear(layouts[l], range)])),
    [activeLevels, layouts, range],
  );

  // Checkbox state for every mounted date label while selecting.
  const headerStates = useMemo(() => {
    if (!selectionActive) return null;
    const states = new Map<string, CheckState>();
    for (const l of activeLevels) {
      for (const h of layouts[l].headers) {
        if (states.has(h.key)) continue;
        let n = 0;
        for (let i = h.start; i < h.start + h.count; i++) {
          if (items[i] && selectedIds.has(items[i].id)) n++;
        }
        states.set(h.key, n === 0 ? "none" : n === h.count ? "all" : "some");
      }
    }
    return states;
  }, [selectionActive, activeLevels, layouts, items, selectedIds]);

  if (items.length === 0) {
    return (
      <View className="flex-1">
        {isLoading ? (
          <GridSkeleton
            columns={layout.columns}
            tileSize={layout.tileSize}
            clock={skeletonClock}
          />
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
            <View
              style={{
                height: contentHeight + (isFetchingMore ? FOOTER_ROWS * (layout.tileSize + GAP) : 0),
              }}
            >
              {activeLevels.map((l) => (
                <LevelHeaders
                  key={`headers-${l}`}
                  level={l}
                  headers={nearHeaders.get(l) ?? []}
                  fromLevel={fromLevel}
                  toLevel={toLevel}
                  progress={progress}
                  background={colors.background}
                  secondary={colors.textSecondary}
                  accent={colors.accent}
                  states={headerStates}
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
                  drag={dragVisual}
                />
              ))}
              {isFetchingMore && (
                // Next page on its way: placeholder rows at the current tile size.
                <View
                  className="absolute left-0 right-0"
                  style={{ top: layout.height - BOTTOM_PADDING }}
                >
                  {Array.from({ length: FOOTER_ROWS }, (_, r) => (
                    <SkeletonRow
                      key={r}
                      columns={layout.columns}
                      tileSize={layout.tileSize}
                      clock={skeletonClock}
                      phase={r * 0.12}
                    />
                  ))}
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
            <View className="flex-row items-center gap-3">
              <ThemedText type="muted" className="text-xs">
                {stickyMonth.count}
              </ThemedText>
              {headerStates && (
                <GroupCheck state={headerStates.get(stickyMonth.key) ?? "none"} accent={colors.accent} />
              )}
            </View>
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------

type Geometry = SharedValue<{ x: Float64Array; y: Float64Array; s: number }[]>;

/** In-progress drag-select, shared with every tile for instant feedback. */
type DragVisual = {
  live: SharedValue<boolean>;
  anchor: SharedValue<number>;
  to: SharedValue<number>;
  select: SharedValue<boolean>;
};

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
  drag,
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
  drag: DragVisual;
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

  // Selected look, decided on the UI thread: inside an in-progress drag the
  // range wins (instant feedback); otherwise React's selection state.
  const isSelected = () => {
    "worklet";
    if (drag.live.get()) {
      const a = drag.anchor.get();
      const t = drag.to.get();
      if (a >= 0 && index >= Math.min(a, t) && index <= Math.max(a, t)) {
        return drag.select.get();
      }
    }
    return selected;
  };
  const innerStyle = useAnimatedStyle(() => {
    const on = isSelected();
    return {
      transform: [{ scale: withTiming(on ? 0.86 : 1, { duration: 90 }) }],
      borderRadius: on ? 10 : 0,
    };
  });
  const checkStyle = useAnimatedStyle(() => {
    const on = isSelected();
    return {
      borderColor: on ? accent : "#ffffff",
      backgroundColor: on ? accent : "rgba(0,0,0,0.25)",
    };
  });
  const tickStyle = useAnimatedStyle(() => ({ opacity: isSelected() ? 1 : 0 }));

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
      <Animated.View className="h-full w-full overflow-hidden" style={innerStyle}>
        <MediaThumb
          id={item.id}
          uri={item.uri}
          mediaType={item.mediaType}
          // Hundreds of tiny tiles fading in at once is wasted work.
          transition={small ? 0 : 100}
        />
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
      </Animated.View>
      {selectionActive && (
        <Animated.View
          className="absolute left-1 top-1 items-center justify-center rounded-full border-2"
          style={[{ width: small ? 12 : 20, height: small ? 12 : 20 }, checkStyle]}
        >
          <Animated.View style={tickStyle}>
            <Icon name="check" size={small ? 7 : 12} color="#ffffff" />
          </Animated.View>
        </Animated.View>
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
  accent,
  states,
}: {
  level: number;
  headers: Header[];
  fromLevel: SharedValue<number>;
  toLevel: SharedValue<number>;
  progress: SharedValue<number>;
  background: string;
  secondary: string;
  accent: string;
  /** Checkbox state per header key while selecting; null otherwise. */
  states: Map<string, CheckState> | null;
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
            <View className="flex-row items-center gap-3">
              <ThemedText type="muted" className="text-xs">
                {h.count}
              </ThemedText>
              {states && <GroupCheck state={states.get(h.key) ?? "none"} accent={accent} />}
            </View>
          </View>
        ) : (
          <View
            key={h.key}
            className="absolute left-0 right-0 flex-row items-center justify-between px-4"
            style={{ top: h.y, height: GROUP_HEADER_HEIGHT }}
          >
            <ThemedText type="small" style={{ color: secondary }}>
              {h.title}
            </ThemedText>
            {states && <GroupCheck state={states.get(h.key) ?? "none"} accent={accent} />}
          </View>
        ),
      )}
    </Animated.View>
  );
});

type CheckState = "none" | "some" | "all";

/** Round checkbox for a date label: empty, partly selected (dash), or all. */
function GroupCheck({ state, accent }: { state: CheckState; accent: string }) {
  const filled = state !== "none";
  return (
    <View
      className="h-[22px] w-[22px] items-center justify-center rounded-full border-2"
      style={{
        borderColor: filled ? accent : "#9ca3af",
        backgroundColor: filled ? accent : "transparent",
      }}
    >
      {state === "all" && <Icon name="check" size={13} color="#ffffff" />}
      {state === "some" && <View className="h-[2px] w-[10px] rounded-full bg-white" />}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Skeletons — laid out exactly like the real grid at the current zoom level.

function SkeletonRow({
  columns,
  tileSize,
  clock,
  phase,
}: {
  columns: number;
  tileSize: number;
  clock: SharedValue<number>;
  phase: number;
}) {
  return (
    <View className="flex-row" style={{ gap: GAP, marginBottom: GAP }}>
      {Array.from({ length: columns }, (_, c) => (
        <SkeletonBlock
          key={c}
          clock={clock}
          // A slight left-to-right lag inside the row, on top of the row's own.
          phase={phase + c * 0.015}
          style={{ width: tileSize, height: tileSize }}
        />
      ))}
    </View>
  );
}

/**
 * First-load placeholder: month and day/week labels with rows of tiles, using
 * the same column count, tile size and grouping as the grid will have — so
 * nothing jumps when the photos arrive. Rows are phase-shifted so the pulse
 * travels down the screen as a wave.
 */
function GridSkeleton({
  columns,
  tileSize,
  clock,
}: {
  columns: number;
  tileSize: number;
  clock: SharedValue<number>;
}) {
  const grouping = groupingFor(columns);
  const screen = 1400; // enough to fill any phone screen
  const rowH = tileSize + GAP;
  // A believable mix of short and long groups.
  const groupRows = [1, 2, 1, 3, 2];
  const blocks: React.ReactNode[] = [];
  let y = 0;
  let row = 0;
  let g = 0;
  const label = (key: string, width: number, height: number, top: number) => (
    <SkeletonBlock
      key={key}
      clock={clock}
      phase={(top / rowH) * 0.12}
      style={{ width, height, borderRadius: height / 2 }}
    />
  );

  // Month label.
  blocks.push(
    <View
      key="month"
      className="flex-row items-center justify-between px-4"
      style={{ height: MONTH_HEADER_HEIGHT }}
    >
      {label("m-title", 110, 16, y)}
      {label("m-count", 24, 10, y)}
    </View>,
  );
  y += MONTH_HEADER_HEIGHT;

  while (y < screen) {
    if (grouping !== "month") {
      blocks.push(
        <View key={`g-${g}`} className="justify-center px-4" style={{ height: GROUP_HEADER_HEIGHT }}>
          {label(`g-${g}-t`, grouping === "day" ? 92 : 78, 11, y)}
        </View>,
      );
      y += GROUP_HEADER_HEIGHT;
    }
    const rows = grouping === "month" ? Math.ceil((screen - y) / rowH) : groupRows[g % groupRows.length];
    for (let r = 0; r < rows && y < screen; r++) {
      blocks.push(
        <SkeletonRow
          key={`r-${row}`}
          columns={columns}
          tileSize={tileSize}
          clock={clock}
          phase={(y / rowH) * 0.12}
        />,
      );
      y += rowH;
      row++;
    }
    g++;
  }

  return (
    <View className="flex-1 overflow-hidden" pointerEvents="none">
      {blocks}
    </View>
  );
}

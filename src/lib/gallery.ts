/**
 * Data layer for the Gallery tab: every image *and* video on the device, read
 * page-by-page with expo-media-library's v56 Query API. Unlike the video
 * library (lib/media.ts), a gallery can hold tens of thousands of items, so we
 * never load an album in full — `exeForMetadata()` reads a page of cheap
 * media-store rows and we only resolve URIs for that page.
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { File } from "expo-file-system";
import { Platform } from "react-native";
import {
  Album,
  Asset,
  AssetField,
  MediaType,
  Query,
  type AssetMetadata,
} from "expo-media-library";

import { fileUriToPath, shareFiles } from "@modules/share-files";

export type GalleryMediaType = "image" | "video";

/** Which media types a gallery list shows. */
export type GalleryFilter = "all" | "image" | "video";

export type GalleryItem = {
  id: string;
  /** Displayable / playable URI (file:// on Android, ph:// on iOS). */
  uri: string;
  mediaType: GalleryMediaType;
  filename: string;
  width: number;
  height: number;
  /** Duration in seconds (0 for images). */
  duration: number;
  /** Milliseconds since epoch (0 when unknown). */
  creationTime: number;
};

export type GalleryAlbum = {
  id: string;
  title: string;
  imageCount: number;
  videoCount: number;
  /** URI + type of the newest item, used for the cover. */
  coverUri: string | null;
  coverType: GalleryMediaType;
  coverId: string | null;
};

/**
 * Items fetched per page where paging applies (iOS — Android displays the
 * whole index at once). Scales with the grid density: about 10 rows of the
 * current zoom, so 30 at 3 per row and 150 at 15 per row.
 */
export function galleryPageSize(columns: number): number {
  return Math.max(30, columns * 10);
}

function baseQuery(filter: GalleryFilter, albumId?: string): Query {
  let query = new Query();
  query =
    filter === "all"
      ? query.within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
      : query.eq(
          AssetField.MEDIA_TYPE,
          filter === "image" ? MediaType.IMAGE : MediaType.VIDEO,
        );
  if (albumId) query = query.album(new Album(albumId));
  return query;
}

/**
 * The date a gallery shows for an item: when it was taken, else when the file
 * was last modified. On Android a large share of media (WhatsApp images,
 * downloads, copied backups) has no DATE_TAKEN at all, so sorting by it alone
 * would dump all of those into an undated pile at the end of the timeline.
 */
function effectiveTime(meta: AssetMetadata): number {
  return meta.creationTime ?? meta.modificationTime ?? 0;
}

/** Cheap, path-less entry for every item in a list, newest first. */
export type GalleryIndexEntry = Omit<GalleryItem, "uri">;

/**
 * Read the metadata index for a whole list in one query, sorted newest first
 * by `effectiveTime`. The media-library Query API can only sort on a single
 * column (no "taken, else modified"), so the ordering happens here. Metadata
 * rows don't resolve file paths, so this stays fast even for large libraries;
 * URIs are resolved page by page in `resolveGalleryPage`.
 */
export async function getGalleryIndex(
  filter: GalleryFilter,
  albumId?: string,
): Promise<GalleryIndexEntry[]> {
  const rows = await baseQuery(filter, albumId).exeForMetadata();
  return rows
    .map((meta): GalleryIndexEntry => {
      const isVideo = meta.mediaType === MediaType.VIDEO;
      return {
        id: meta.id,
        mediaType: isVideo ? "video" : "image",
        filename: meta.filename ?? "Untitled",
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        // media-library reports durations in milliseconds.
        duration: isVideo ? (meta.duration ?? 0) / 1000 : 0,
        creationTime: effectiveTime(meta),
      };
    })
    .sort((a, b) => b.creationTime - a.creationTime);
}

/** Resolve URIs for a slice of the index. Unreadable assets are dropped. */
export async function resolveGalleryPage(
  entries: GalleryIndexEntry[],
): Promise<GalleryItem[]> {
  const items = await Promise.all(
    entries.map(async (entry): Promise<GalleryItem | null> => {
      try {
        const uri = await new Asset(entry.id).getUri();
        return { ...entry, uri };
      } catch {
        // Removed mid-scan or unreadable — skip rather than fail the page.
        return null;
      }
    }),
  );
  return items.filter((item): item is GalleryItem => item !== null);
}

/** Every album holding at least one image or video, biggest first. */
export async function getGalleryAlbums(): Promise<GalleryAlbum[]> {
  const albums = await Album.getAll();

  const results = await Promise.all(
    albums.map(async (album): Promise<GalleryAlbum | null> => {
      try {
        // Metadata rows are cheap (no path resolution), so counting this way is fine.
        const rows = await baseQuery("all", album.id).exeForMetadata();
        if (rows.length === 0) return null;
        let videoCount = 0;
        let cover = rows[0];
        for (const row of rows) {
          if (row.mediaType === MediaType.VIDEO) videoCount++;
          if (effectiveTime(row) > effectiveTime(cover)) cover = row;
        }
        const [title, coverUri] = await Promise.all([
          album.getTitle(),
          new Asset(cover.id).getUri().catch(() => null),
        ]);
        return {
          id: album.id,
          title,
          imageCount: rows.length - videoCount,
          videoCount,
          coverUri,
          coverType: cover.mediaType === MediaType.VIDEO ? "video" : "image",
          coverId: cover.id,
        };
      } catch {
        return null;
      }
    }),
  );

  return results
    .filter((a): a is GalleryAlbum => a !== null)
    .sort((a, b) => b.imageCount + b.videoCount - (a.imageCount + a.videoCount));
}

/** Delete items from the device (the OS shows its own confirmation on Android 11+). */
export async function deleteGalleryItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Asset.delete(ids.map((id) => new Asset(id)));
}

/**
 * Share items through the system share sheet (Android, file:// only). The MIME
 * type narrows target apps: image/* or video/* when uniform, otherwise any.
 */
export async function shareGalleryItems(items: GalleryItem[]): Promise<number> {
  // Display URIs may be content:// — sharing needs real file paths.
  const resolved = await Promise.all(
    items.map(async (i) => ({ item: i, uri: await resolveFileUri(i).catch(() => null) })),
  );
  const shareable = resolved.filter(
    (r): r is { item: GalleryItem; uri: string } => !!r.uri && r.uri.startsWith("file://"),
  );
  if (shareable.length === 0) throw new Error("These items can't be shared.");
  const types = new Set(shareable.map((r) => r.item.mediaType));
  const mime =
    types.size === 1 ? (types.has("image") ? "image/*" : "video/*") : "*/*";
  return shareFiles(shareable.map((r) => fileUriToPath(r.uri)), mime);
}

/**
 * The item's file:// URI (needed for sharing, file size, showing the path).
 * Gallery items on Android display from their content:// id, so the real
 * path is only looked up on demand.
 */
export async function resolveFileUri(item: GalleryItem): Promise<string> {
  if (item.uri.startsWith("file://")) return item.uri;
  return new Asset(item.id).getUri();
}

/**
 * Android only: every asset id is already a MediaStore content:// URI, which
 * expo-image (Glide) and expo-video load directly. Using it as the display
 * URI skips one native path lookup per item — so the whole index is
 * displayable at once — and lets Glide serve small tiles from Android's
 * pre-generated MediaStore thumbnails instead of decoding full-size files.
 */
export const IDS_ARE_URIS = Platform.OS === "android";

export function indexToItems(index: GalleryIndexEntry[]): GalleryItem[] {
  return index.map((entry) => ({ ...entry, uri: entry.id }));
}

/** File size in bytes, or null when unavailable. */
export function galleryItemSize(uri: string): number | null {
  try {
    return new File(uri).size ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Timeline grouping

export type TimelineRow =
  | { kind: "month"; key: string; title: string; count: number }
  /** Sub-header under a month: a day or a week, depending on zoom. */
  | { kind: "group"; key: string; title: string; count: number }
  | { kind: "row"; key: string; items: GalleryItem[]; startIndex: number };


/** How the timeline is sub-grouped under each month. */
export type TimelineGrouping = "day" | "week" | "month";

const DAY_MS = 24 * 60 * 60 * 1000;

// Formatting dates is slow on Hermes — formatters are created once, and
// labels are only formatted once per group (never per item).
let formatters: {
  month: Intl.DateTimeFormat;
  monthYear: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  shortMonth: Intl.DateTimeFormat;
} | null = null;
function fmt() {
  formatters ??= {
    month: new Intl.DateTimeFormat(undefined, { month: "long" }),
    monthYear: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }),
    day: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }),
    shortMonth: new Intl.DateTimeFormat(undefined, { month: "short" }),
  };
  return formatters;
}

/**
 * Local calendar parts for every item, computed once per item list (cached)
 * and shared by all zoom levels. Groups are then compared by plain numbers.
 */
type DateParts = {
  /** year*12 + month, or -1 when the date is unknown. */
  month: Int32Array;
  /** year*10000 + month*100 + day, or -1. */
  day: Int32Array;
  /** Monday-of-week as year*10000 + month*100 + day, or -1. */
  week: Int32Array;
};
const partsCache = new WeakMap<GalleryItem[], DateParts>();

function dateParts(items: GalleryItem[]): DateParts {
  const cached = partsCache.get(items);
  if (cached) return cached;
  const n = items.length;
  const parts: DateParts = {
    month: new Int32Array(n),
    day: new Int32Array(n),
    week: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const t = items[i].creationTime;
    if (!t) {
      parts.month[i] = parts.day[i] = parts.week[i] = -1;
      continue;
    }
    const d = new Date(t);
    const y = d.getFullYear();
    const m = d.getMonth();
    const dd = d.getDate();
    parts.month[i] = y * 12 + m;
    parts.day[i] = y * 10000 + m * 100 + dd;
    const ws = new Date(y, m, dd - ((d.getDay() + 6) % 7)); // Monday
    parts.week[i] = ws.getFullYear() * 10000 + ws.getMonth() * 100 + ws.getDate();
  }
  partsCache.set(items, parts);
  return parts;
}

function dayKeyToDate(key: number): Date {
  return new Date(Math.floor(key / 10000), Math.floor(key / 100) % 100, key % 100);
}

function monthTitle(key: number, now: Date): string {
  if (key < 0) return "Unknown date";
  const y = Math.floor(key / 12);
  const date = new Date(y, key % 12, 1);
  return y === now.getFullYear() ? fmt().month.format(date) : fmt().monthYear.format(date);
}

function dayTitle(key: number, now: Date): string {
  if (key < 0) return "Unknown date";
  const date = dayKeyToDate(key);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() === today) return "Today";
  if (date.getTime() === today - DAY_MS) return "Yesterday";
  return fmt().day.format(date);
}

/** Week label, clipped to the month it's listed under ("16 – 22 Nov"). */
function weekTitle(weekKey: number, monthKey: number, now: Date): string {
  if (weekKey < 0) return "Unknown date";
  const start = dayKeyToDate(weekKey);
  const nowMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  if (start.getTime() === nowMonday.getTime()) return "This week";
  if (start.getTime() === nowMonday.getTime() - 7 * DAY_MS) return "Last week";
  const y = Math.floor(monthKey / 12);
  const m = monthKey % 12;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const from = start.getMonth() === m ? start.getDate() : 1;
  const to = end.getMonth() === m ? end.getDate() : new Date(y, m + 1, 0).getDate();
  const month = fmt().shortMonth.format(new Date(y, m, 1));
  return from === to ? `${from} ${month}` : `${from} – ${to} ${month}`;
}

/** Index just past the run (from `start`, before `end`) sharing keys[start]. */
function runEnd(keys: Int32Array, start: number, end: number): number {
  const key = keys[start];
  let j = start + 1;
  while (j < end && keys[j] === key) j++;
  return j;
}

/**
 * Flatten items (already newest-first) into month headers, optional day/week
 * sub-headers, and rows of `columns` tiles, so one list can render a
 * sectioned grid with sticky month headers. `startIndex` is the index of the
 * row's first item in the flat `items` list.
 */
export function buildTimeline(
  items: GalleryItem[],
  columns: number,
  grouping: TimelineGrouping,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const now = new Date();
  const parts = dateParts(items);
  // Keep keys unique even if a group ever appears in two separate runs.
  const seen = new Map<string, number>();
  const uniqueKey = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const pushTiles = (from: number, to: number) => {
    for (let k = from; k < to; k += columns) {
      rows.push({
        kind: "row",
        key: `r-${items[k].id}`,
        items: items.slice(k, Math.min(k + columns, to)),
        startIndex: k,
      });
    }
  };

  let i = 0;
  while (i < items.length) {
    const monthKey = parts.month[i];
    const monthEnd = runEnd(parts.month, i, items.length);
    rows.push({
      kind: "month",
      key: uniqueKey(`m-${monthKey}`),
      title: monthTitle(monthKey, now),
      count: monthEnd - i,
    });

    if (grouping === "month") {
      pushTiles(i, monthEnd);
    } else {
      const keys = grouping === "day" ? parts.day : parts.week;
      let g = i;
      while (g < monthEnd) {
        const key = keys[g];
        const groupEnd = runEnd(keys, g, monthEnd);
        rows.push({
          kind: "group",
          // Weeks can straddle months, so their key includes the month.
          key: uniqueKey(`g-${grouping[0]}${key}-${monthKey}`),
          title: grouping === "day" ? dayTitle(key, now) : weekTitle(key, monthKey, now),
          count: groupEnd - g,
        });
        pushTiles(g, groupEnd);
        g = groupEnd;
      }
    }
    i = monthEnd;
  }
  return rows;
}

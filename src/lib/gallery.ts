/**
 * Data layer for the Gallery tab: every image *and* video on the device, read
 * page-by-page with expo-media-library's v56 Query API. Unlike the video
 * library (lib/media.ts), a gallery can hold tens of thousands of items, so we
 * never load an album in full — `exeForMetadata()` reads a page of cheap
 * media-store rows and we only resolve URIs for that page.
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { File } from "expo-file-system";
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

export const GALLERY_PAGE_SIZE = 120;

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
  const shareable = items.filter((i) => i.uri.startsWith("file://"));
  if (shareable.length === 0) throw new Error("These items can't be shared.");
  const types = new Set(shareable.map((i) => i.mediaType));
  const mime =
    types.size === 1 ? (types.has("image") ? "image/*" : "video/*") : "*/*";
  return shareFiles(shareable.map((i) => fileUriToPath(i.uri)), mime);
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

const DAY = 24 * 60 * 60 * 1000;

type Group = { key: string; title: string };

function monthGroup(time: number, now: Date): Group {
  if (!time) return { key: "unknown", title: "Unknown date" };
  const d = new Date(time);
  const sameYear = d.getFullYear() === now.getFullYear();
  const title = d.toLocaleDateString(undefined, {
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return { key: `${d.getFullYear()}-${d.getMonth()}`, title };
}

function dayGroup(time: number, now: Date): Group {
  if (!time) return { key: "unknown", title: "Unknown date" };
  const d = new Date(time);
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) return { key, title: "Today" };
  if (time >= startOfToday - DAY) return { key, title: "Yesterday" };
  const title = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return { key, title };
}

/** Monday 00:00 of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

function weekGroup(time: number, now: Date): Group {
  if (!time) return { key: "unknown", title: "Unknown date" };
  const d = new Date(time);
  const start = startOfWeek(d);
  const key = `w-${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
  const thisWeek = startOfWeek(now).getTime();
  if (start.getTime() === thisWeek) return { key, title: "This week" };
  if (start.getTime() === thisWeek - 7 * DAY) return { key, title: "Last week" };
  // Weeks are listed inside their month, so clip the range to that month.
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const from = start.getMonth() === d.getMonth() ? start : new Date(d.getFullYear(), d.getMonth(), 1);
  const to =
    end.getMonth() === d.getMonth() ? end : new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const title =
    from.getDate() === to.getDate()
      ? `${from.getDate()} ${month}`
      : `${from.getDate()} – ${to.getDate()} ${month}`;
  // The key must also be per-month, since a week can straddle two months.
  return { key: `${key}-${d.getMonth()}`, title };
}

/** How the timeline is sub-grouped under each month. */
export type TimelineGrouping = "day" | "week" | "month";

/** Index just past the run of items (from `start`) sharing one group key. */
function runEnd(
  items: GalleryItem[],
  start: number,
  end: number,
  groupOf: (time: number, now: Date) => Group,
  now: Date,
): number {
  const key = groupOf(items[start].creationTime, now).key;
  let j = start;
  while (j < end && groupOf(items[j].creationTime, now).key === key) j++;
  return j;
}

/**
 * Flatten items (already newest-first) into month headers, optional day/week
 * sub-headers, and rows of `columns` tiles, so one FlatList can render a
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
    const month = monthGroup(items[i].creationTime, now);
    const monthEnd = runEnd(items, i, items.length, monthGroup, now);
    rows.push({
      kind: "month",
      key: uniqueKey(`m-${month.key}`),
      title: month.title,
      count: monthEnd - i,
    });

    if (grouping === "month") {
      pushTiles(i, monthEnd);
    } else {
      const groupOf = grouping === "day" ? dayGroup : weekGroup;
      let g = i;
      while (g < monthEnd) {
        const group = groupOf(items[g].creationTime, now);
        const groupEnd = runEnd(items, g, monthEnd, groupOf, now);
        rows.push({
          kind: "group",
          key: uniqueKey(`g-${group.key}`),
          title: group.title,
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

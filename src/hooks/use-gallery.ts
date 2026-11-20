import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as MediaLibrary from "expo-media-library";
import { useEffect, useMemo } from "react";

import {
  galleryPageSize,
  IDS_ARE_URIS,
  indexToItems,
  getGalleryAlbums,
  getGalleryIndex,
  resolveGalleryPage,
  searchGallery,
  type GalleryFilter,
  type GalleryItem,
} from "@/lib/gallery";

const INDEX_STALE_MS = 5 * 60 * 1000;
const PREFETCH_DELAY_MS = 600;
/** After opening the Gallery, wait this long before loading albums. */
const ALBUMS_PREFETCH_DELAY_MS = 1200;

export const galleryKeys = {
  all: ["gallery"] as const,
  index: (filter: GalleryFilter, albumId?: string) =>
    ["gallery", "index", filter, albumId ?? "all"] as const,
  items: (filter: GalleryFilter, albumId: string | undefined, indexVersion: number) =>
    ["gallery", "items", filter, albumId ?? "all", indexVersion] as const,
  albums: ["gallery", "albums"] as const,
};

/**
 * Gallery items (newest first) for the whole device or one album.
 *
 * Two layers: a cheap sorted metadata index for the full list, then URIs
 * resolved page by page as the user scrolls. The pages are keyed by the
 * index's version so a refreshed index never mixes with stale pages.
 */
export function useGalleryItems(
  filter: GalleryFilter,
  albumId: string | undefined,
  enabled = true,
  /** Grid columns at the current zoom — sets the page size where paging applies. */
  columns = 3,
  /** Search text (dates, types, file names); empty shows everything. */
  query = "",
) {
  const pageSize = galleryPageSize(columns);
  const indexQuery = useQuery({
    queryKey: galleryKeys.index(filter, albumId),
    enabled,
    queryFn: () => getGalleryIndex(filter, albumId),
    // Library changes are pushed via useGalleryLibrarySync; don't refetch just
    // because another screen (e.g. the viewer) mounted the same list.
    staleTime: INDEX_STALE_MS,
  });
  const index = indexQuery.data;

  const pagesQuery = useInfiniteQuery({
    queryKey: galleryKeys.items(filter, albumId, indexQuery.dataUpdatedAt),
    // Android displays straight from the index (ids are content:// URIs), so
    // there's nothing to page in.
    enabled: enabled && !!index && !IDS_ARE_URIS,
    initialPageParam: 0,
    // Pages can differ in size (the zoom can change between fetches), so each
    // page records where it ended and the next one starts there.
    queryFn: async ({ pageParam }) => {
      const end = pageParam + pageSize;
      const items = await resolveGalleryPage((index ?? []).slice(pageParam, end));
      return { items, end };
    },
    getNextPageParam: (last) => (last.end < (index?.length ?? 0) ? last.end : undefined),
    staleTime: 5 * 60 * 1000,
    // Keep showing the old pages while a refreshed index re-resolves page 0,
    // instead of flashing an empty list (which also resets scroll positions).
    placeholderData: keepPreviousData,
  });

  const items = useMemo<GalleryItem[]>(() => {
    if (IDS_ARE_URIS) return index ? indexToItems(index) : [];
    const seen = new Set<string>();
    const out: GalleryItem[] = [];
    for (const page of pagesQuery.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [pagesQuery.data, index]);

  const results = useMemo(() => searchGallery(items, query), [items, query]);

  return {
    items: results,
    /** Unfiltered items (for search suggestions). */
    allItems: items,
    /** Total items in the list (known before all pages load). */
    total: index?.length ?? 0,
    isLoading: indexQuery.isLoading || (!IDS_ARE_URIS && pagesQuery.isLoading),
    isRefetching: indexQuery.isRefetching,
    isFetchingNextPage: !IDS_ARE_URIS && pagesQuery.isFetchingNextPage,
    hasNextPage: !IDS_ARE_URIS && pagesQuery.hasNextPage,
    fetchNextPage: pagesQuery.fetchNextPage,
    refetch: indexQuery.refetch,
  };
}

/** Albums containing images and/or videos. */
export function useGalleryAlbums(enabled = true) {
  return useQuery({
    queryKey: galleryKeys.albums,
    enabled,
    queryFn: getGalleryAlbums,
    // Prefetched from Home; refreshed by useGalleryLibrarySync on changes.
    staleTime: INDEX_STALE_MS,
  });
}

/**
 * Refresh every gallery query when the device library changes (new photo,
 * download, deletion elsewhere). Android only says *that* something changed,
 * so we invalidate everything.
 */
export function useGalleryLibrarySync(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = MediaLibrary.addListener(() => {
      // Bursts of changes (e.g. a camera burst) collapse into one refresh.
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: galleryKeys.all });
      }, 800);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [enabled, queryClient]);
}

/**
 * Warm the Gallery while another tab (Home) is showing: load the "All"
 * timeline's sorted index in the background, so opening Gallery skips the
 * slow native metadata query. Waits a moment so the current screen settles
 * first.
 */
export function usePrefetchGallery(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void queryClient.prefetchQuery({
        queryKey: galleryKeys.index("all"),
        queryFn: () => getGalleryIndex("all"),
        staleTime: INDEX_STALE_MS,
      });
    }, PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, queryClient]);
}

/**
 * Load the album list in the background — called while the Gallery's Photos
 * view is open, so the Albums switch is instant without adding work at app
 * launch (one media query per album is too heavy to run at start-up).
 */
export function usePrefetchAlbums(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void queryClient.prefetchQuery({
        queryKey: galleryKeys.albums,
        queryFn: getGalleryAlbums,
        staleTime: INDEX_STALE_MS,
      });
    }, ALBUMS_PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, queryClient]);
}

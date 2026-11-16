import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as MediaLibrary from "expo-media-library";
import { useEffect, useMemo } from "react";

import {
  GALLERY_PAGE_SIZE,
  getGalleryAlbums,
  getGalleryIndex,
  resolveGalleryPage,
  type GalleryFilter,
  type GalleryItem,
} from "@/lib/gallery";

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
) {
  const indexQuery = useQuery({
    queryKey: galleryKeys.index(filter, albumId),
    enabled,
    queryFn: () => getGalleryIndex(filter, albumId),
    // Library changes are pushed via useGalleryLibrarySync; don't refetch just
    // because another screen (e.g. the viewer) mounted the same list.
    staleTime: 5 * 60 * 1000,
  });
  const index = indexQuery.data;

  const pagesQuery = useInfiniteQuery({
    queryKey: galleryKeys.items(filter, albumId, indexQuery.dataUpdatedAt),
    enabled: enabled && !!index,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      resolveGalleryPage((index ?? []).slice(pageParam, pageParam + GALLERY_PAGE_SIZE)),
    getNextPageParam: (_last, pages) => {
      const next = pages.length * GALLERY_PAGE_SIZE;
      return next < (index?.length ?? 0) ? next : undefined;
    },
    staleTime: 5 * 60 * 1000,
    // Keep showing the old pages while a refreshed index re-resolves page 0,
    // instead of flashing an empty list (which also resets scroll positions).
    placeholderData: keepPreviousData,
  });

  const items = useMemo<GalleryItem[]>(() => {
    const seen = new Set<string>();
    const out: GalleryItem[] = [];
    for (const page of pagesQuery.data?.pages ?? []) {
      for (const item of page) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [pagesQuery.data]);

  return {
    items,
    /** Total items in the list (known before all pages load). */
    total: index?.length ?? 0,
    isLoading: indexQuery.isLoading || pagesQuery.isLoading,
    isRefetching: indexQuery.isRefetching,
    isFetchingNextPage: pagesQuery.isFetchingNextPage,
    hasNextPage: pagesQuery.hasNextPage,
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

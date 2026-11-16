import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import { BackHandler, Platform, Pressable, ScrollView, View } from "react-native";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { MediaGrid } from "@/components/gallery/media-grid";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { galleryKeys, useGalleryItems } from "@/hooks/use-gallery";
import { useSelection } from "@/hooks/use-selection";
import { useTheme } from "@/hooks/use-theme";
import { videoKeys } from "@/hooks/use-video-folders";
import {
  deleteGalleryItems,
  shareGalleryItems,
  type GalleryFilter,
  type GalleryItem,
} from "@/lib/gallery";

const FILTERS: { value: GalleryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Photos" },
  { value: "video", label: "Videos" },
];

export function FilterChips({
  value,
  onChange,
}: {
  value: GalleryFilter;
  onChange: (value: GalleryFilter) => void;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-2"
    >
      {FILTERS.map((f) => {
        const active = f.value === value;
        return (
          <Pressable
            key={f.value}
            onPress={() => onChange(f.value)}
            className="rounded-full px-4 py-1.5 active:opacity-80"
            style={{
              backgroundColor: active ? colors.text : colors.backgroundElement,
            }}
          >
            <ThemedText
              type="small"
              style={{ color: active ? colors.background : colors.text }}
            >
              {f.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

type GalleryBrowserProps = {
  albumId?: string;
  enabled: boolean;
  /** Show the loading skeleton even before querying (e.g. permission still being checked). */
  loading?: boolean;
  /** Normal (non-selection) header above the chips. */
  renderHeader: () => ReactNode;
  emptyText?: string;
};

/**
 * The gallery timeline with filter chips, multi-select (share / delete) and
 * tap-to-open viewer. Shared by the Gallery tab and the album screen.
 */
export function GalleryBrowser({
  albumId,
  enabled,
  loading = false,
  renderHeader,
  emptyText = "No photos or videos here yet.",
}: GalleryBrowserProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<GalleryFilter>("all");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const selection = useSelection();
  const {
    items,
    isLoading,
    isRefetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useGalleryItems(filter, albumId, enabled);

  // Hardware back clears the selection before leaving the screen.
  const { active: selectionActive, clear: clearSelection, toggle } = selection;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (selectionActive) {
          clearSelection();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [selectionActive, clearSelection]),
  );

  const onPressItem = useCallback(
    (item: GalleryItem, index: number) => {
      if (selectionActive) {
        toggle(item.id);
        return;
      }
      router.push({
        pathname: "/viewer",
        params: { filter, albumId: albumId ?? "", id: item.id, index: String(index) },
      });
    },
    [selectionActive, toggle, router, filter, albumId],
  );

  const selectedItems = () => items.filter((i) => selection.isSelected(i.id));

  const onShare = async () => {
    try {
      await shareGalleryItems(selectedItems());
      selection.clear();
    } catch (err) {
      console.warn("[gallery] share failed:", err);
    }
  };

  const confirmDelete = async () => {
    setConfirmOpen(false);
    try {
      await deleteGalleryItems([...selection.selectedIds]);
      selection.clear();
      await queryClient.invalidateQueries({ queryKey: galleryKeys.all });
      // Deleted videos also disappear from the Home tab's folders.
      await queryClient.invalidateQueries({ queryKey: videoKeys.folders });
    } catch {
      // User cancelled the system dialog, or it failed.
    }
  };

  const selectAll = () => {
    for (const item of items) if (!selection.isSelected(item.id)) toggle(item.id);
  };

  const header = (
    <View style={{ backgroundColor: colors.background }}>
      {selection.active ? (
        <View className="flex-row items-center gap-2 px-2 pb-3 pt-2">
          <Pressable onPress={selection.clear} hitSlop={10} className="p-2 active:opacity-70">
            <Icon name="xmark" size={24} color={colors.text} />
          </Pressable>
          <ThemedText type="subtitle" className="flex-1">
            {selection.count} selected
          </ThemedText>
          <Pressable onPress={selectAll} hitSlop={10} className="px-2 py-2 active:opacity-70">
            <ThemedText type="small" style={{ color: colors.accent }}>
              All
            </ThemedText>
          </Pressable>
          {Platform.OS === "android" && (
            <Pressable onPress={onShare} hitSlop={10} className="p-2 active:opacity-70">
              <Icon name="share" size={24} color={colors.text} />
            </Pressable>
          )}
          <Pressable
            onPress={() => setConfirmOpen(true)}
            hitSlop={10}
            className="p-2 active:opacity-70"
          >
            <Icon name="trash" size={24} color="#ef4444" />
          </Pressable>
        </View>
      ) : (
        renderHeader()
      )}
      <FilterChips
        value={filter}
        onChange={(f) => {
          selection.clear();
          setFilter(f);
        }}
      />
    </View>
  );

  return (
    <>
      {/* Header sits outside the list so it stays put while the grid scrolls. */}
      {header}
      <MediaGrid
        items={items}
        isLoading={isLoading || loading}
        isRefreshing={isRefetching && !isFetchingNextPage}
        isFetchingMore={isFetchingNextPage}
        onRefresh={refetch}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        emptyText={emptyText}
        selectedIds={selection.selectedIds}
        onPressItem={onPressItem}
        onSelectionChange={selection.replace}
      />
      <ConfirmSheet
        visible={confirmOpen}
        title={`Delete ${selection.count} item${selection.count === 1 ? "" : "s"}?`}
        message="The selected photos and videos will be permanently deleted from this device."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

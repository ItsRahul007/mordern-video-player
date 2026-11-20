import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { BackHandler, Keyboard, Platform, Pressable, ScrollView, TextInput, View } from "react-native";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { MediaGrid } from "@/components/gallery/media-grid";
import { TabSwipe } from "@/components/gallery/tab-swipe";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { galleryKeys, useGalleryItems } from "@/hooks/use-gallery";
import { useSelection } from "@/hooks/use-selection";
import { useTheme } from "@/hooks/use-theme";
import { videoKeys } from "@/hooks/use-video-folders";
import {
  deleteGalleryItems,
  searchSuggestions,
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
  /** Space to leave at the end of the grid (floating tab bar). */
  bottomInset?: number;
  /** Swiping the grid left-to-right opens this tab (Gallery → Home). */
  swipeTo?: "/";
  /** Normal (non-selection, non-search) header above the chips. */
  renderHeader: (actions: { openSearch: () => void }) => ReactNode;
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
  bottomInset = 0,
  swipeTo,
  renderHeader,
  emptyText = "No photos or videos here yet.",
}: GalleryBrowserProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<GalleryFilter>("all");
  // The grid's current column count (page size follows it where paging applies).
  const [columns, setColumns] = useState(3);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Filter on a deferred copy so typing stays instant on big libraries.
  const searchQuery = useDeferredValue(searchOpen ? query : "");
  const selection = useSelection();
  const {
    items,
    allItems,
    isLoading,
    isRefetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useGalleryItems(filter, albumId, enabled, columns, searchQuery);

  const closeSearch = useCallback(() => {
    // The input unmounts, but Android keeps the keyboard up unless told.
    Keyboard.dismiss();
    setSearchOpen(false);
    setQuery("");
  }, []);

  // Hardware back clears the selection before leaving the screen.
  const { active: selectionActive, clear: clearSelection, toggle } = selection;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (selectionActive) {
          clearSelection();
          return true;
        }
        if (searchOpen) {
          closeSearch();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [selectionActive, clearSelection, searchOpen, closeSearch]),
  );

  const onPressItem = useCallback(
    (item: GalleryItem, index: number) => {
      if (selectionActive) {
        toggle(item.id);
        return;
      }
      router.push({
        pathname: "/viewer",
        params: {
          filter,
          albumId: albumId ?? "",
          id: item.id,
          index: String(index),
          q: searchQuery,
        },
      });
    },
    [selectionActive, toggle, router, filter, albumId, searchQuery],
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

  const grid = (
    <MediaGrid
        items={items}
        isLoading={isLoading || loading}
        isRefreshing={isRefetching && !isFetchingNextPage}
        isFetchingMore={isFetchingNextPage}
        onRefresh={refetch}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        emptyText={
          searchQuery.trim()
            ? `Nothing matches “${searchQuery.trim()}”. Try a month, a year, “video” or part of a file name.`
            : emptyText
        }
        selectedIds={selection.selectedIds}
        onPressItem={onPressItem}
        onSelectionChange={selection.replace}
        onColumnsChange={setColumns}
        scrollResetKey={`${filter}|${searchQuery}`}
        bottomInset={bottomInset}
      />
  );

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
      ) : searchOpen ? (
        <SearchBar value={query} onChange={setQuery} onClose={closeSearch} />
      ) : (
        renderHeader({ openSearch: () => setSearchOpen(true) })
      )}
      {searchOpen && !selection.active && (
        query.trim() ? (
          <ThemedText type="muted" className="px-4 pb-2 text-xs">
            {items.length === 1 ? "1 result" : `${items.length.toLocaleString()} results`}
          </ThemedText>
        ) : (
          <SearchSuggestions items={allItems} onPick={setQuery} />
        )
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
      {swipeTo ? (
        // Swipe left-to-right on the grid to go back to Home.
        <TabSwipe>
          {grid}
        </TabSwipe>
      ) : (
        grid
      )}
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

/** Full-width search field that replaces the header while searching. */
function SearchBar({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View className="flex-row items-center gap-1 px-2 pb-3 pt-2">
      <Pressable
        onPress={onClose}
        hitSlop={10}
        accessibilityLabel="Close search"
        className="p-2 active:opacity-70"
      >
        <Icon name="back" size={24} color={colors.text} />
      </Pressable>
      <View
        className="h-11 flex-1 flex-row items-center gap-2 rounded-full px-4"
        style={{ backgroundColor: colors.backgroundElement }}
      >
        <Icon name="search" size={18} color={colors.textSecondary} />
        <TextInput
          value={value}
          onChangeText={onChange}
          autoFocus
          placeholder="Search by month, year, type or name"
          placeholderTextColor={colors.textSecondary}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          className="flex-1 text-base"
          style={{ color: colors.text, paddingVertical: 0 }}
        />
        {!!value && (
          <Pressable
            onPress={() => onChange("")}
            hitSlop={10}
            accessibilityLabel="Clear search"
            className="active:opacity-70"
          >
            <Icon name="xmark" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Starting points for a search, drawn from what's in this library. */
function SearchSuggestions({
  items,
  onPick,
}: {
  items: GalleryItem[];
  onPick: (query: string) => void;
}) {
  const { colors } = useTheme();
  const suggestions = useMemo(() => searchSuggestions(items), [items]);
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-3"
    >
      {suggestions.map((s) => (
        <Pressable
          key={s}
          onPress={() => onPick(s)}
          className="flex-row items-center gap-1.5 rounded-full border px-3.5 py-1.5 active:opacity-70"
          style={{ borderColor: colors.backgroundSelected }}
        >
          <Icon name="search" size={13} color={colors.textSecondary} />
          <ThemedText type="small">{s}</ThemedText>
        </Pressable>
      ))}
    </ScrollView>
  );
}

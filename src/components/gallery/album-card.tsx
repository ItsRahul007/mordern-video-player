import { memo } from "react";
import { Pressable, View } from "react-native";

import { MediaThumb } from "@/components/gallery/media-tile";
import { ThemedText } from "@/components/themed-text";
import type { GalleryAlbum } from "@/lib/gallery";

function countLabel(album: GalleryAlbum): string {
  const parts: string[] = [];
  if (album.imageCount) parts.push(`${album.imageCount} photo${album.imageCount === 1 ? "" : "s"}`);
  if (album.videoCount) parts.push(`${album.videoCount} video${album.videoCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Square-cover album card for the Albums grid. */
export const AlbumCard = memo(function AlbumCard({
  album,
  width,
  onPress,
}: {
  album: GalleryAlbum;
  width: number;
  onPress: (album: GalleryAlbum) => void;
}) {
  return (
    <Pressable onPress={() => onPress(album)} style={{ width }} className="active:opacity-80">
      <View className="overflow-hidden rounded-2xl" style={{ width, height: width }}>
        <MediaThumb
          id={album.coverId ?? album.id}
          uri={album.coverUri}
          mediaType={album.coverType}
        />
      </View>
      <ThemedText type="small" numberOfLines={1} className="mt-2 font-semibold">
        {album.title}
      </ThemedText>
      <ThemedText type="muted" numberOfLines={1} className="mt-0.5 text-xs">
        {countLabel(album)}
      </ThemedText>
    </Pressable>
  );
});

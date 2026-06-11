/**
 * Thin wrappers around expo-media-library's v56 Query/Asset/Album API plus
 * expo-video thumbnail generation, for browsing the device's local videos by
 * folder. The new Asset model exposes async getters and reports durations in
 * milliseconds; we normalize to seconds here.
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { File } from 'expo-file-system';
import { Album, Asset, AssetField, MediaType, Query } from 'expo-media-library';
import { createVideoPlayer, type VideoThumbnail } from 'expo-video';

export type VideoAsset = {
  id: string;
  /** Playable URI for the asset (file:// on Android, ph:// on iOS). */
  uri: string;
  filename: string;
  /** Duration in seconds. */
  duration: number;
  width: number;
  height: number;
  creationTime: number;
  /** File size in bytes, or null when unavailable (e.g. iOS ph:// URIs). */
  size: number | null;
};

/** How a folder's videos are ordered. Shared by Settings and the folder filter. */
export type SortOption =
  | 'name-asc'
  | 'name-desc'
  | 'date-desc'
  | 'date-asc'
  | 'size-desc'
  | 'size-asc';

export const DEFAULT_SORT: SortOption = 'date-desc';

function fileSize(uri: string): number | null {
  try {
    return new File(uri).size ?? null;
  } catch {
    return null;
  }
}

/** Order a list of videos by the chosen option (media-library can't sort by name/size). */
export function sortVideos(videos: VideoAsset[], option: SortOption): VideoAsset[] {
  const sorted = [...videos];
  switch (option) {
    case 'name-asc':
      return sorted.sort((a, b) => a.filename.localeCompare(b.filename));
    case 'name-desc':
      return sorted.sort((a, b) => b.filename.localeCompare(a.filename));
    case 'date-asc':
      return sorted.sort((a, b) => a.creationTime - b.creationTime);
    case 'date-desc':
      return sorted.sort((a, b) => b.creationTime - a.creationTime);
    case 'size-asc':
      return sorted.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    case 'size-desc':
      return sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  }
}

export type VideoFolder = {
  id: string;
  title: string;
  count: number;
  /** URI of the most recent video, used to generate a cover thumbnail. */
  coverUri: string | null;
};

function videosInAlbum(album: Album): Query {
  return new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.VIDEO)
    .album(album)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false });
}

async function toVideoAsset(asset: Asset): Promise<VideoAsset | null> {
  try {
    const info = await asset.getInfo();
    return {
      id: info.id,
      uri: info.uri,
      filename: info.filename,
      duration: (info.duration ?? 0) / 1000,
      width: info.width,
      height: info.height,
      creationTime: info.creationTime ?? 0,
      size: fileSize(info.uri),
    };
  } catch {
    // getInfo() rejects if the asset can't be fully read (e.g. an iCloud-only
    // or momentarily unavailable file). Fall back to the basic getters so one
    // bad asset doesn't blank the whole folder — a URI is enough to list and
    // play it. Only drop the video if even the URI is unreadable.
    try {
      const uri = await asset.getUri();
      const [filename, duration, width, height, creationTime] = await Promise.all([
        asset.getFilename().catch(() => uri.split('/').pop() ?? 'Video'),
        asset.getDuration().catch(() => 0),
        asset.getWidth().catch(() => 0),
        asset.getHeight().catch(() => 0),
        asset.getCreationTime().catch(() => 0),
      ]);
      return {
        id: asset.id,
        uri,
        filename,
        duration: (duration ?? 0) / 1000,
        width,
        height,
        creationTime: creationTime ?? 0,
        size: fileSize(uri),
      };
    } catch {
      return null;
    }
  }
}

/** All device albums that contain at least one video, sorted by video count. */
export async function getVideoFolders(): Promise<VideoFolder[]> {
  const albums = await Album.getAll();

  const folders = await Promise.all(
    albums.map(async (album): Promise<VideoFolder | null> => {
      const videos = await videosInAlbum(album).exe();
      if (videos.length === 0) return null;

      const [title, coverUri] = await Promise.all([
        album.getTitle(),
        videos[0].getUri().catch(() => null),
      ]);
      return { id: album.id, title, count: videos.length, coverUri };
    }),
  );

  return folders
    .filter((folder): folder is VideoFolder => folder !== null)
    .sort((a, b) => b.count - a.count);
}

/** Ordered list of videos in a folder — also serves as the player's playlist. */
export async function getFolderVideos(albumId: string): Promise<VideoAsset[]> {
  const assets = await videosInAlbum(new Album(albumId)).exe();
  const videos = await Promise.all(assets.map(toVideoAsset));
  // Drop assets that couldn't be read at all (toVideoAsset never throws now,
  // so one unreadable video can't reject the batch and empty the folder).
  return videos.filter((v): v is VideoAsset => v !== null);
}

/** Delete videos from the device (the OS shows its own confirmation dialog). */
export async function deleteVideos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Asset.delete(ids.map((id) => new Asset(id)));
}

/** Delete whole folders and their videos. */
export async function deleteFolders(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Android always removes the album's assets; `true` makes iOS do so too.
  await Album.delete(
    ids.map((id) => new Album(id)),
    true,
  );
}

/**
 * Generate a single still frame for a video. Returns a native image reference
 * that expo-image can render directly. The temporary player is released after.
 */
export async function generateVideoThumbnail(uri: string): Promise<VideoThumbnail | null> {
  const player = createVideoPlayer(uri);
  try {
    const thumbnails = await player.generateThumbnailsAsync([0.1], { maxWidth: 640 });
    return thumbnails[0] ?? null;
  } catch {
    return null;
  } finally {
    player.release();
  }
}

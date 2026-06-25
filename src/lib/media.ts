/**
 * Thin wrappers around expo-media-library's v56 Query/Asset/Album API plus
 * expo-video thumbnail generation, for browsing the device's local videos by
 * folder. The new Asset model exposes async getters and reports durations in
 * milliseconds; we normalize to seconds here.
 * https://docs.expo.dev/versions/v56.0.0/sdk/media-library/
 */
import { File } from 'expo-file-system';
import { deleteAsync, getInfoAsync, readDirectoryAsync } from 'expo-file-system/legacy';
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

/** The directory URI and the filenames of the album's videos inside it. */
type FolderProbe = { dirUri: string; videoNames: Set<string> };

/** Decode a single URI path segment (filename), tolerating malformed escapes. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Inspect an album's on-disk folders and return those that hold *nothing but*
 * the album's videos — i.e. would be left empty once the videos are gone. A
 * folder is skipped if it contains any other file or a subdirectory, so we
 * never remove a directory the user keeps other things in. Returns an empty
 * array when the paths can't be read (e.g. iOS ph:// URIs).
 *
 * Uses the legacy file-system API on purpose: the new File/Directory API parses
 * paths with `java.net.URI`, which throws on characters like `[` `]` that media
 * filenames often contain. The legacy API parses with the lenient `Uri.parse`.
 */
async function emptyableFolders(albumId: string): Promise<string[]> {
  try {
    const assets = await videosInAlbum(new Album(albumId)).exe();
    const uris = await Promise.all(assets.map((a) => a.getUri().catch(() => null)));
    const fileUris = uris.filter((u): u is string => !!u && u.startsWith('file://'));
    console.log(
      `[deleteFolders] album ${albumId}: ${assets.length} videos, ${fileUris.length} file:// URIs`,
    );
    if (fileUris.length === 0) return [];

    // Group the album's videos by their parent directory (by filename).
    const probes = new Map<string, FolderProbe>();
    for (const uri of fileUris) {
      const slash = uri.lastIndexOf('/');
      if (slash < 0) continue;
      const dirUri = uri.slice(0, slash);
      const name = decodeSegment(uri.slice(slash + 1));
      const probe = probes.get(dirUri) ?? { dirUri, videoNames: new Set<string>() };
      probe.videoNames.add(name);
      probes.set(dirUri, probe);
    }

    const emptyable: string[] = [];
    for (const { dirUri, videoNames } of probes.values()) {
      try {
        // readDirectoryAsync returns decoded names of files *and* subdirectories.
        const entries = await readDirectoryAsync(dirUri);
        const extras = entries.filter((name) => !videoNames.has(name));
        if (extras.length === 0) {
          console.log(`[deleteFolders] ${dirUri}: only videos → will remove folder`);
          emptyable.push(dirUri);
        } else {
          console.log(
            `[deleteFolders] ${dirUri}: ${extras.length} extra entr${
              extras.length === 1 ? 'y' : 'ies'
            } (${extras.join(', ')}) → keeping folder`,
          );
        }
      } catch (err) {
        // Couldn't read the directory — leave it in place.
        console.warn(`[deleteFolders] failed to list ${dirUri}:`, err);
      }
    }
    return emptyable;
  } catch (err) {
    console.warn(`[deleteFolders] failed to inspect album ${albumId}:`, err);
    return [];
  }
}

/**
 * Delete whole folders and their videos. The check runs *before* deleting: any
 * folder that holds only the videos being removed is deleted from disk too,
 * while folders that contain other files are left in place.
 */
export async function deleteFolders(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  console.log(`[deleteFolders] deleting ${ids.length} folder(s):`, ids);

  // Check on-disk contents first, while the videos still exist.
  const toRemove = (await Promise.all(ids.map(emptyableFolders))).flat();
  console.log(`[deleteFolders] ${toRemove.length} folder(s) will be removed from disk`);

  // Android always removes the album's assets; `true` makes iOS do so too.
  await Album.delete(
    ids.map((id) => new Album(id)),
    true,
  );
  console.log('[deleteFolders] album assets deleted');

  // Now that the videos are gone, remove the directories that are left empty.
  for (const dirUri of toRemove) {
    try {
      const info = await getInfoAsync(dirUri);
      if (info.exists) {
        await deleteAsync(dirUri, { idempotent: true });
        console.log(`[deleteFolders] removed folder ${dirUri}`);
      } else {
        console.log(`[deleteFolders] folder already gone ${dirUri}`);
      }
    } catch (err) {
      // Best-effort cleanup; the videos were already deleted successfully.
      console.warn(`[deleteFolders] failed to remove folder ${dirUri}:`, err);
    }
  }
}

/**
 * Fallback duration probe for videos whose media-library metadata reports 0
 * (some files, especially recently copied or downloaded ones, aren't indexed
 * with a duration yet). Spins up a temporary player and reads the duration the
 * decoder reports once the source loads. Returns seconds, or null if it can't
 * resolve within the timeout. The player is always released.
 */
export async function getVideoDuration(uri: string, timeoutMs = 8000): Promise<number | null> {
  const player = createVideoPlayer(uri);
  try {
    return await new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.remove();
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), timeoutMs);

      // expo-video reports duration in seconds, available once the source loads.
      const sub = player.addListener('sourceLoad', ({ duration }) => {
        finish(duration && duration > 0 ? duration : null);
      });

      // It may already be loaded by the time we subscribe.
      if (player.duration > 0) finish(player.duration);
    });
  } catch {
    return null;
  } finally {
    player.release();
  }
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

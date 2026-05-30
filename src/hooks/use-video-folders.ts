import { useQuery } from '@tanstack/react-query';

import { getFolderVideos, getVideoFolders } from '@/lib/media';

export const videoKeys = {
  folders: ['video-folders'] as const,
  folder: (albumId: string) => ['folder-videos', albumId] as const,
  thumbnail: (uri: string) => ['video-thumbnail', uri] as const,
};

/** All folders on the device that contain videos. */
export function useVideoFolders(enabled: boolean) {
  return useQuery({
    queryKey: videoKeys.folders,
    enabled,
    queryFn: getVideoFolders,
  });
}

/** The ordered list of videos in a folder (also the player's playlist). */
export function useFolderVideos(albumId: string | undefined) {
  return useQuery({
    queryKey: videoKeys.folder(albumId ?? ''),
    enabled: !!albumId,
    queryFn: () => getFolderVideos(albumId as string),
  });
}

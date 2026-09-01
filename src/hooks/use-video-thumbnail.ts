import { useQuery } from '@tanstack/react-query';

import { generateVideoThumbnail } from '@/lib/media';
import { videoKeys } from '@/hooks/use-video-folders';

/**
 * Lazily generate (and cache) a still-frame thumbnail for a video URI.
 * `id` is a stable key (e.g. the media-library asset id) used both as the
 * query key and the disk-cache filename, so the thumbnail survives cold
 * starts once it's been generated once.
 */
export function useVideoThumbnail(
  uri: string | null | undefined,
  id: string | null | undefined,
) {
  return useQuery({
    queryKey: videoKeys.thumbnail(id ?? ''),
    enabled: !!uri && !!id,
    queryFn: () => generateVideoThumbnail(uri as string, id as string),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

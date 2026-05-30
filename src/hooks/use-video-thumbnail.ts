import { useQuery } from '@tanstack/react-query';

import { generateVideoThumbnail } from '@/lib/media';
import { videoKeys } from '@/hooks/use-video-folders';

/**
 * Lazily generate (and cache) a still-frame thumbnail for a video URI.
 * Thumbnails are native image refs, so they're cached indefinitely in memory.
 */
export function useVideoThumbnail(uri: string | null | undefined) {
  return useQuery({
    queryKey: videoKeys.thumbnail(uri ?? ''),
    enabled: !!uri,
    queryFn: () => generateVideoThumbnail(uri as string),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

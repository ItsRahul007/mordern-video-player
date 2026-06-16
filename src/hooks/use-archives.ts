import { useQuery } from '@tanstack/react-query';

import { listZipFiles } from '@/lib/archives';

export const archiveKeys = {
  zips: ['zip-files'] as const,
};

/** All `.zip` archives in the device's Downloads folder. */
export function useZipFiles(enabled: boolean) {
  return useQuery({
    queryKey: archiveKeys.zips,
    enabled,
    queryFn: listZipFiles,
  });
}

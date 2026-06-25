import { useQuery } from "@tanstack/react-query";

import { listStatuses } from "@/lib/whatsapp-status";

export const statusKeys = {
  statuses: ["whatsapp-statuses"] as const,
};

/** All WhatsApp/Business statuses currently cached on the device. */
export function useStatuses(enabled: boolean) {
  return useQuery({
    queryKey: statusKeys.statuses,
    enabled,
    queryFn: listStatuses,
  });
}

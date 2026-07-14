import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchAppOpens, type OpenCount } from "@/lib/supabase";

/** App opens grouped under a single local calendar day. */
export type DailyOpens = {
  /** `YYYY-MM-DD` in the device's local timezone — stable grouping key. */
  date: string;
  /** Human label, e.g. `Jul 2`. */
  label: string;
  count: number;
  /** Local times of each open that day, newest first (e.g. `10:43 PM`). */
  times: string[];
};

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Roll raw open rows up into per-day buckets, newest day first. */
export function groupByDay(rows: OpenCount[]): DailyOpens[] {
  const buckets = new Map<string, DailyOpens>();

  for (const row of rows) {
    // Prefer the true open time; fall back to the server insert time for
    // legacy rows recorded before `opened_at` existed.
    const when = new Date(row.opened_at ?? row.created_at);
    if (Number.isNaN(when.getTime())) continue;

    const key = localDateKey(when);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        date: key,
        label: when.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        count: 0,
        times: [],
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.times.push(
      when.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  }

  // `fetchAppOpens` returns newest-first, so both the day keys and the times
  // within each day are already in descending order.
  return [...buckets.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Load app-open analytics from Supabase, grouped by day.
 *
 * `rangeDays` bounds the query to opens within the last N days (filtered on
 * `opened_at`). Pass `null` for all-time. Defaults to the last 30 days.
 *
 * `deviceId` scopes the query to a single install:
 * - a string  → only that install's opens (the normal, per-user view),
 * - `undefined` → every install's opens (the hidden all-devices view),
 * - `null`    → the id hasn't resolved yet; the query stays disabled.
 */
export function useAppOpens(
  rangeDays: number | null = 30,
  deviceId?: string | null,
) {
  const sinceIso = useMemo(() => {
    if (rangeDays == null) return undefined;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    return cutoff.toISOString();
  }, [rangeDays]);

  const query = useQuery({
    queryKey: ["app-opens", rangeDays ?? "all", deviceId ?? "all"],
    queryFn: () => fetchAppOpens(sinceIso, deviceId ?? undefined),
    staleTime: 30_000,
    enabled: deviceId !== null,
  });

  return {
    ...query,
    days: query.data ? groupByDay(query.data) : [],
    total: query.data?.length ?? 0,
  };
}

/**
 * Minimal Supabase access via the PostgREST REST API.
 *
 * We talk to Supabase directly with `fetch` instead of pulling in
 * `@supabase/supabase-js` — the only thing this app needs is a single insert
 * (record an app open) and a single select (read them back for the usage
 * chart), and the JS client drags in URL/stream polyfills that React Native
 * doesn't ship. The table has RLS locked down to anon insert/select on the
 * `open-count` table only, so the publishable key is safe to embed.
 *
 * `EXPO_PUBLIC_SUPABASE_URL` already points at the `/rest/v1/` endpoint.
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;

/** One row of the `open-count` table. */
export type OpenCount = {
  id: string | number;
  /** Client-supplied true open time. Null for legacy rows recorded before this column existed. */
  opened_at: string | null;
  /** Server insert time — kept as a fallback for legacy rows without `opened_at`. */
  created_at: string;
};

const TABLE = "open-count";

function headers(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY ?? "",
    Authorization: `Bearer ${SUPABASE_KEY ?? ""}`,
    "Content-Type": "application/json",
  };
}

const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);

/** A queued app-open ready to upload. */
export type AppOpenInsert = {
  opened_at: string;
  device_id: string;
};

/**
 * Batch-insert app-open events. PostgREST accepts a JSON array body, so the
 * whole local queue uploads in one request. Returns whether the server accepted
 * the rows; throws only on a network error so the caller can keep the queue and
 * retry later. No-ops (returns true) when Supabase isn't configured.
 */
export async function insertAppOpens(rows: AppOpenInsert[]): Promise<boolean> {
  if (!configured || rows.length === 0) return true;
  const res = await fetch(`${SUPABASE_URL}${TABLE}`, {
    method: "POST",
    headers: { ...headers(), Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  return res.ok;
}

/**
 * Fetch recorded app-opens, newest first. When `sinceIso` is given, only rows
 * with an `opened_at` at or after that instant are returned (legacy rows with a
 * null `opened_at` are excluded from a date-bounded query — they can't be
 * placed on the timeline anyway).
 */
export async function fetchAppOpens(sinceIso?: string): Promise<OpenCount[]> {
  if (!configured) {
    throw new Error("Supabase is not configured");
  }
  const since = sinceIso ? `&opened_at=gte.${sinceIso}` : "";
  const res = await fetch(
    `${SUPABASE_URL}${TABLE}?select=id,opened_at,created_at&order=opened_at.desc.nullslast${since}`,
    { headers: headers() },
  );
  if (!res.ok) {
    throw new Error(`Supabase request failed (${res.status})`);
  }
  return (await res.json()) as OpenCount[];
}

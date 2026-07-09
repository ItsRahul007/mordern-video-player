/**
 * Offline-safe app-open tracking.
 *
 * Every launch is written to a local SQLite queue (`pending_opens`) *first*, so
 * an open is never lost when the device is offline or the Supabase request
 * fails. The queue is then flushed to Supabase whenever the app has network —
 * on cold start and on returning to the foreground (see `_layout.tsx`). Each
 * row carries the true local open time and a stable per-install `device_id`.
 */
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

import { Storage, StorageKeys } from '@/lib/storage';
import { insertAppOpens } from '@/lib/supabase';

/** A queued, not-yet-uploaded app open. */
type PendingOpen = {
  id: number;
  opened_at: string;
  device_id: string;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Open (once) the analytics DB and ensure the queue table exists. */
function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('analytics.db');
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS pending_opens (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           opened_at TEXT NOT NULL,
           device_id TEXT NOT NULL
         );`,
      );
      return db;
    })();
  }
  return dbPromise;
}

let deviceIdPromise: Promise<string> | null = null;

/**
 * A stable identifier for this install. Generated once with a cryptographically
 * secure V4 UUID and persisted; reused for the lifetime of the install. It
 * identifies an install, not a person — a reinstall produces a fresh id.
 */
export function getDeviceId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const existing = await Storage.getItem(StorageKeys.deviceId);
      if (existing) return existing;
      const id = Crypto.randomUUID();
      await Storage.setItem(StorageKeys.deviceId, id);
      return id;
    })();
  }
  return deviceIdPromise;
}

/** Append this launch to the local queue. Never throws. */
export async function enqueueOpen(): Promise<void> {
  try {
    const db = await getDb();
    const deviceId = await getDeviceId();
    await db.runAsync(
      'INSERT INTO pending_opens (opened_at, device_id) VALUES (?, ?)',
      new Date().toISOString(),
      deviceId,
    );
  } catch {
    // A failed local write must not affect app startup.
  }
}

let flushInFlight: Promise<void> | null = null;

/**
 * Upload every queued open to Supabase in a single batch, deleting the rows
 * that were successfully sent. A failed flush is a no-op — the rows stay queued
 * and are retried on the next trigger. Concurrent calls share one flush.
 */
export function flushPendingOpens(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<PendingOpen>(
        'SELECT id, opened_at, device_id FROM pending_opens ORDER BY id ASC',
      );
      if (rows.length === 0) return;

      const ok = await insertAppOpens(
        rows.map((r) => ({ opened_at: r.opened_at, device_id: r.device_id })),
      );
      if (!ok) return;

      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      await db.runAsync(
        `DELETE FROM pending_opens WHERE id IN (${placeholders})`,
        ids,
      );
    } catch {
      // Offline / server error — leave the queue intact for the next flush.
    } finally {
      flushInFlight = null;
    }
  })();
  return flushInFlight;
}

/**
 * Record an app open: enqueue locally (offline-safe), then attempt to flush.
 * Fire-and-forget — never throws to the caller.
 */
export async function recordAppOpen(): Promise<void> {
  await enqueueOpen();
  await flushPendingOpens();
}

/**
 * Tracks per-video playback progress (last position + completion) so the UI can
 * show watch progress and the player can resume where you left off.
 *
 * Implemented as a tiny external store (subscribed via useSyncExternalStore) so
 * the high-frequency position updates during playback don't re-render the video
 * lists on every tick — the committed snapshot only changes on a flush or when a
 * video's "completed" flag flips.
 */
import { Storage, StorageKeys } from '@/lib/storage';

export type PlaybackEntry = {
  /** Last playback position in seconds. */
  position: number;
  /** Total duration in seconds. */
  duration: number;
  completed: boolean;
};

type Entries = Record<string, PlaybackEntry>;

/** A video counts as completed once watched to ≥95% of its duration. */
const COMPLETE_RATIO = 0.95;
/** Resume only if more than this many seconds were watched. */
export const RESUME_THRESHOLD = 5;
const PERSIST_DELAY = 4000;

let committed: Entries = {};
let pending: Entries = {};
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  void Storage.setItem(StorageKeys.playbackProgress, JSON.stringify(committed));
}

/** Move pending live writes into the committed snapshot and notify subscribers. */
function commit() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (Object.keys(pending).length === 0) return;
  committed = { ...committed, ...pending };
  pending = {};
  emit();
  persist();
}

export const playbackStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): Entries {
    return committed;
  },

  getEntry(id: string): PlaybackEntry | undefined {
    return pending[id] ?? committed[id];
  },

  async hydrate() {
    if (hydrated) return;
    hydrated = true;
    const raw = await Storage.getItem(StorageKeys.playbackProgress);
    if (!raw) return;
    try {
      committed = JSON.parse(raw) as Entries;
      emit();
    } catch {
      // ignore corrupt data
    }
  },

  /** Record the current position for a video (called frequently while playing). */
  record(id: string, position: number, duration: number) {
    if (!id || duration <= 0) return;
    const completed = position >= duration * COMPLETE_RATIO;
    const previouslyCompleted = playbackStore.getEntry(id)?.completed ?? false;
    pending[id] = { position, duration, completed };

    // Surface completion transitions to the UI immediately; otherwise batch.
    if (completed !== previouslyCompleted) {
      commit();
    } else if (!flushTimer) {
      flushTimer = setTimeout(commit, PERSIST_DELAY);
    }
  },

  /** Persist the latest position now (e.g. when leaving the player). */
  flush() {
    commit();
  },
};

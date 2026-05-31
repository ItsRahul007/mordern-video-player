import { useSyncExternalStore } from 'react';

import { playbackStore, type PlaybackEntry } from '@/lib/playback-store';

/** All playback entries, keyed by video id. Re-renders on commit. */
export function usePlaybackEntries(): Record<string, PlaybackEntry> {
  return useSyncExternalStore(
    playbackStore.subscribe,
    playbackStore.getSnapshot,
    playbackStore.getSnapshot,
  );
}

/** Playback progress for a single video, or undefined if never played. */
export function usePlaybackEntry(id: string): PlaybackEntry | undefined {
  return usePlaybackEntries()[id];
}

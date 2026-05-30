import { useSyncExternalStore } from 'react';

import { playbackStore, type PlaybackEntry } from '@/lib/playback-store';

function useEntries() {
  return useSyncExternalStore(
    playbackStore.subscribe,
    playbackStore.getSnapshot,
    playbackStore.getSnapshot,
  );
}

/** Playback progress for a single video, or undefined if never played. */
export function usePlaybackEntry(id: string): PlaybackEntry | undefined {
  return useEntries()[id];
}

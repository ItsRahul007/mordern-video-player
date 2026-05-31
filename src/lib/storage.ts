/**
 * Lightweight key-value persistence backed by SQLite.
 * `expo-sqlite/kv-store` is a drop-in AsyncStorage replacement.
 * https://docs.expo.dev/versions/v56.0.0/sdk/sqlite/#keyvalue-storage
 */
import Storage from 'expo-sqlite/kv-store';

export { Storage };

export const StorageKeys = {
  themePreference: 'theme-preference',
  sortOption: 'sort-option',
  playbackProgress: 'playback-progress',
  playerVolume: 'player-volume',
  playerBrightness: 'player-brightness',
} as const;

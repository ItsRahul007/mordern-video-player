/**
 * Persisted player brightness (the last value set via the player's vertical-drag
 * gesture). Re-applied each time a video opens, then normalized (handed back to
 * the system) when leaving the player.
 *
 * Volume isn't stored here — it maps to the device media volume (react-native-
 * volume-manager), which the OS already remembers globally.
 *
 * Value is 0..1. Kept in memory for synchronous reads; persisted via persist().
 */
import { Storage, StorageKeys } from '@/lib/storage';

let brightness: number | null = null; // null = never set; leave system brightness alone
let hydrated = false;

export const playerPrefs = {
  async hydrate() {
    if (hydrated) return;
    hydrated = true;
    const stored = await Storage.getItem(StorageKeys.playerBrightness);
    const value = stored != null ? Number.parseFloat(stored) : NaN;
    if (Number.isFinite(value)) brightness = Math.max(0, Math.min(1, value));
  },

  getBrightness() {
    return brightness;
  },

  // In-memory update during a drag (cheap; no disk write per frame).
  setBrightness(value: number) {
    brightness = value;
  },

  // Persist the current value (call when a drag ends).
  persist() {
    if (brightness != null) {
      void Storage.setItem(StorageKeys.playerBrightness, String(brightness));
    }
  },
};

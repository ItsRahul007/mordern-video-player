import Constants from 'expo-constants';
import { ActivityAction, startActivityAsync } from 'expo-intent-launcher';
import { useCallback } from 'react';
import { Platform } from 'react-native';

/**
 * Opens the Android "All files access" (MANAGE_EXTERNAL_STORAGE) settings page.
 *
 * There's no JS API to read the grant state, and expo-file-system's own
 * listing is the real source of truth for the archives screen — so this hook
 * only handles *opening* the settings page. The screen re-lists on foreground.
 */
export function useAllFilesAccess() {
  const openSettings = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    const pkg = Constants.expoConfig?.android?.package;
    try {
      // Deep-link straight to this app's toggle when we know the package id.
      await startActivityAsync(
        ActivityAction.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        pkg ? { data: `package:${pkg}` } : undefined,
      );
    } catch {
      // Fall back to the full all-files-access list if the app-specific screen
      // isn't available on this device.
      await startActivityAsync(ActivityAction.MANAGE_ALL_FILES_ACCESS_PERMISSION);
    }
  }, []);

  return { openSettings };
}

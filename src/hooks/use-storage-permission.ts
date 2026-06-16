import Constants from 'expo-constants';
import { ActivityAction, startActivityAsync } from 'expo-intent-launcher';
import { useCallback } from 'react';
import { Platform } from 'react-native';

import { isAllFilesAccessGranted } from '@modules/all-files-access';

/**
 * Reads the real MANAGE_EXTERNAL_STORAGE grant state. Unlike inferring from a
 * directory listing (which the app can do via its scoped media permissions even
 * without the grant), this reflects the actual OS toggle. `true` on platforms
 * without the concept (iOS, Android ≤10).
 */
export function hasAllFilesAccess(): boolean {
  return isAllFilesAccessGranted();
}

/**
 * Opens the Android "All files access" (MANAGE_EXTERNAL_STORAGE) settings page.
 *
 * The screen re-checks the grant on foreground (the toggle lives in a separate
 * system activity), so this hook only handles *opening* the settings page.
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

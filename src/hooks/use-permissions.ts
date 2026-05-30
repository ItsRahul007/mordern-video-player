import * as MediaLibrary from 'expo-media-library';

/**
 * Media-library permission state for the library gate.
 * Returns the permission response and a `requestPermission` function.
 */
export function useMediaPermissions() {
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  return {
    permission,
    requestPermission,
    granted: permission?.granted ?? false,
    canAskAgain: permission?.canAskAgain ?? true,
  };
}

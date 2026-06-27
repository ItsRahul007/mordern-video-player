// A file manager's "Open with" launches us with a content://|file:// video URI
// as the app's initial URL. That isn't an app route, so without this hook
// expo-router would try to match it and land on the "Unmatched Route" screen,
// which then sits beneath the player.
//
// Returning null tells expo-router to ignore the URL and fall through to the
// home screen. RootLayout separately reads the same URI via Linking and pushes
// the player on top, so the stack stays [home, player] and Back returns to the
// library. Runs for both cold start (initial) and while already running.
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    if (path.startsWith("content://") || path.startsWith("file://")) {
      return null;
    }
  } catch {
    // Fall through and let expo-router handle the path normally.
  }
  return path;
}

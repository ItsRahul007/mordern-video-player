/**
 * Theme access for the app. Styling is primarily done with NativeWind
 * (`bg-background`, `text-foreground`, `dark:` variants). This hook exposes the
 * resolved scheme, the raw `Colors` palette (for the few APIs that need literal
 * color values — status bar, video background, navigation chrome) and the
 * persisted light/dark preference.
 *
 * https://docs.expo.dev/guides/color-schemes/
 */
import { Colors } from '@/constants/theme';
import { useThemeContext } from '@/providers/theme-provider';

export function useTheme() {
  const { preference, scheme, setPreference } = useThemeContext();

  return {
    preference,
    scheme,
    setPreference,
    colors: Colors[scheme],
  };
}

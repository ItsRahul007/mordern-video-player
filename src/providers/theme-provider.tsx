import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';
import { Appearance, useColorScheme } from 'react-native';

import { Storage, StorageKeys } from '@/lib/storage';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

type ThemeContextValue = {
  /** What the user picked: follow the OS, or force light/dark. */
  preference: ThemePreference;
  /** The scheme actually applied right now. */
  scheme: ResolvedScheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const colorScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Drive RN's Appearance directly — NativeWind (react-native-css) tracks it via
  // Appearance.addChangeListener, so the `dark` variant flips with it.
  // In RN 0.85 "follow OS" is the `'unspecified'` scheme.
  const applyScheme = (pref: ThemePreference) =>
    Appearance.setColorScheme(pref === 'system' ? 'unspecified' : pref);

  // Hydrate the saved preference on first mount.
  useEffect(() => {
    Storage.getItem(StorageKeys.themePreference).then((saved) => {
      if (isPreference(saved)) {
        setPreferenceState(saved);
        applyScheme(saved);
      }
    });
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    applyScheme(next);
    Storage.setItem(StorageKeys.themePreference, next);
  };

  return (
    <ThemeContext
      value={{
        preference,
        scheme: colorScheme === 'dark' ? 'dark' : 'light',
        setPreference,
      }}>
      {children}
    </ThemeContext>
  );
}

export function useThemeContext() {
  const context = use(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeProvider');
  }
  return context;
}

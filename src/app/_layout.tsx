import '@/global.css';

import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
} from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useTheme } from '@/hooks/use-theme';
import { playbackStore } from '@/lib/playback-store';
import { playerPrefs } from '@/lib/player-prefs';
import { QueryProvider } from '@/providers/query-provider';
import { SortProvider } from '@/providers/sort-provider';
import { ThemeProvider } from '@/providers/theme-provider';

function RootNavigator() {
  const { scheme } = useTheme();

  return (
    <NavigationThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="folder/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen
          name="player"
          options={{ animation: 'fade', presentation: 'fullScreenModal' }}
        />
      </Stack>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  // Load saved playback progress and lock the app to portrait on launch
  // (the player rotates to landscape on its own for wide videos).
  useEffect(() => {
    void playbackStore.hydrate();
    void playerPrefs.hydrate();
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryProvider>
        <ThemeProvider>
          <SortProvider>
            <AnimatedSplashOverlay />
            <RootNavigator />
          </SortProvider>
        </ThemeProvider>
      </QueryProvider>
    </GestureHandlerRootView>
  );
}

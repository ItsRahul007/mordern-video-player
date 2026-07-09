import '@/global.css';

import * as Linking from 'expo-linking';
import {
  DarkTheme,
  DefaultTheme,
  router,
  Stack,
  ThemeProvider as NavigationThemeProvider,
} from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import NetInfo from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useTheme } from '@/hooks/use-theme';
import { flushPendingOpens, recordAppOpen } from '@/lib/open-tracker';
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
        <Stack.Screen name="archives" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="status-saver" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen
          name="status-viewer"
          options={{ animation: 'fade', presentation: 'fullScreenModal' }}
        />
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

/** A file URI handed to us by another app (file manager "Open with"). */
function isExternalVideoUrl(url: string | null): url is string {
  return !!url && (url.startsWith('content://') || url.startsWith('file://'));
}

export default function RootLayout() {
  // Load saved playback progress and lock the app to portrait on launch
  // (the player rotates to landscape on its own for wide videos).
  useEffect(() => {
    void playbackStore.hydrate();
    void playerPrefs.hydrate();
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    // Log this launch for the usage chart: queued locally (offline-safe) then
    // flushed to Supabase. Retry the queue whenever we return to the foreground
    // so an open recorded offline uploads as soon as the network is back.
    void recordAppOpen();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flushPendingOpens();
    });
    // Also flush the moment connectivity returns mid-session (e.g. the app was
    // opened offline and the network came back while it stayed in foreground).
    // Only act on the offline -> online transition to avoid redundant work.
    let online = true;
    const netInfoSub = NetInfo.addEventListener((state) => {
      const nowOnline = Boolean(state.isConnected && state.isInternetReachable);
      if (nowOnline && !online) void flushPendingOpens();
      online = nowOnline;
    });
    return () => {
      appStateSub.remove();
      netInfoSub();
    };
  }, []);

  // Open videos launched from another app's "Open with" menu. The intent's
  // content://|file:// URI arrives as the launch URL (cold start) or via the
  // 'url' event (already running, singleTask brings us forward); we route it
  // straight to the player as a standalone clip.
  useEffect(() => {
    let lastHandled: string | null = null;
    const open = (url: string | null) => {
      if (!isExternalVideoUrl(url) || url === lastHandled) return;
      lastHandled = url;
      router.push({ pathname: '/player', params: { uri: url } });
    };
    void Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
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

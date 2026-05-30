import { useEvent, useEventListener } from 'expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StatusBar, View } from 'react-native';

import { VideoControls } from '@/components/player/video-controls';
import { ThemedText } from '@/components/themed-text';
import { useFolderVideos } from '@/hooks/use-video-folders';
import { playbackStore, RESUME_THRESHOLD } from '@/lib/playback-store';
import { sortVideos } from '@/lib/media';
import { useSort } from '@/providers/sort-provider';

export default function PlayerScreen() {
  const router = useRouter();
  const { albumId, id } = useLocalSearchParams<{ albumId: string; id: string }>();
  const { data: videos, isLoading } = useFolderVideos(albumId);
  const { sort } = useSort();

  // The playlist must match the order shown in the folder (the selected filter).
  const playlist = useMemo(() => (videos ? sortVideos(videos, sort) : undefined), [videos, sort]);

  // Track the currently playing video within the folder playlist.
  const [currentId, setCurrentId] = useState(id);
  const index = playlist?.findIndex((v) => v.id === currentId) ?? -1;
  const current = index >= 0 ? playlist?.[index] : undefined;
  const hasPrev = index > 0;
  const hasNext = !!playlist && index >= 0 && index < playlist.length - 1;

  const player = useVideoPlayer(current?.uri ?? null, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });

  // Autoplay whenever the source resolves or changes (next/prev).
  useEffect(() => {
    if (current?.uri) player.play();
  }, [current?.uri, player]);

  // Resume from the saved position once the (new) video is ready to play.
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const resumedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'readyToPlay' || !current) return;
    if (resumedIdRef.current === current.id) return;
    resumedIdRef.current = current.id;

    const entry = playbackStore.getEntry(current.id);
    if (
      entry &&
      !entry.completed &&
      entry.position > RESUME_THRESHOLD &&
      entry.position < player.duration - RESUME_THRESHOLD
    ) {
      // Seek to the saved position (method call avoids mutating the player ref).
      player.seekBy(entry.position - player.currentTime);
    }
  }, [status, current?.id, current, player]);

  // Record progress as the video plays.
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (current) playbackStore.record(current.id, currentTime, player.duration);
  });

  const goNext = () => {
    if (playlist && index >= 0 && index < playlist.length - 1) setCurrentId(playlist[index + 1].id);
  };
  const goPrev = () => {
    if (playlist && index > 0) setCurrentId(playlist[index - 1].id);
  };

  // Mark complete and auto-advance when the current video finishes.
  useEventListener(player, 'playToEnd', () => {
    if (current) playbackStore.record(current.id, player.duration, player.duration);
    if (hasNext) goNext();
  });

  // Rotate the screen to match the video: landscape videos play horizontally,
  // portrait videos stay vertical.
  useEffect(() => {
    if (!current?.width || !current?.height) return;
    const landscape = current.width > current.height;
    void ScreenOrientation.lockAsync(
      landscape
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, [current?.width, current?.height]);

  // Persist progress and restore portrait when leaving the player.
  useEffect(
    () => () => {
      playbackStore.flush();
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    },
    [],
  );

  return (
    <View className="flex-1 bg-black">
      <StatusBar hidden />

      {current ? (
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="contain"
          nativeControls={false}
          allowsPictureInPicture
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          {!isLoading && !current ? (
            <ThemedText className="text-white">Couldn’t load this video.</ThemedText>
          ) : (
            <ActivityIndicator color="#ffffff" />
          )}
        </View>
      )}

      {current && (
        <VideoControls
          player={player}
          title={current.filename}
          onClose={() => router.back()}
          onNext={goNext}
          onPrev={goPrev}
          hasNext={hasNext}
          hasPrev={hasPrev}
        />
      )}
    </View>
  );
}

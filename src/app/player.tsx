import { useEvent, useEventListener } from "expo";
import * as Brightness from "expo-brightness";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StatusBar, View } from "react-native";

import { VideoControls } from "@/components/player/video-controls";
import { ThemedText } from "@/components/themed-text";
import { useFolderVideos } from "@/hooks/use-video-folders";
import { sortVideos } from "@/lib/media";
import { playbackStore, RESUME_THRESHOLD } from "@/lib/playback-store";
import { playerPrefs } from "@/lib/player-prefs";
import { useSort } from "@/providers/sort-provider";

type Orientation = "landscape" | "portrait";

export default function PlayerScreen() {
  const router = useRouter();
  const { albumId, id } = useLocalSearchParams<{
    albumId: string;
    id: string;
  }>();
  const { data: videos, isLoading } = useFolderVideos(albumId);
  const { sort } = useSort();

  // The playlist must match the order shown in the folder (the selected filter).
  const playlist = useMemo(
    () => (videos ? sortVideos(videos, sort) : undefined),
    [videos, sort],
  );

  // Track the currently playing video within the folder playlist.
  const [currentId, setCurrentId] = useState(id);
  const index = playlist?.findIndex((v) => v.id === currentId) ?? -1;
  const current = index >= 0 ? playlist?.[index] : undefined;
  const hasPrev = index > 0;
  const hasNext = !!playlist && index >= 0 && index < playlist.length - 1;

  const player = useVideoPlayer(current?.uri ?? null, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });

  // The decoder reports the true display size of the loaded video (already
  // corrected for any rotation metadata in the container), which is more
  // reliable than the media-library width/height. We keep the library values
  // as a fallback for the brief window before the source loads.
  const [videoSize, setVideoSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  useEventListener(player, "sourceLoad", ({ availableVideoTracks }) => {
    const size = availableVideoTracks?.[0]?.size;
    if (size?.width && size?.height) setVideoSize(size);
  });

  // A manual override set by the rotate button; cleared whenever the video
  // changes so each clip starts from its own auto-detected orientation. Reset
  // during render (React's "adjust state on prop change" pattern) rather than
  // in an effect, so the new clip never flashes the previous one's state.
  const [manualOrientation, setManualOrientation] = useState<Orientation | null>(
    null,
  );
  const [trackedId, setTrackedId] = useState(current?.id);
  if (current?.id !== trackedId) {
    setTrackedId(current?.id);
    setManualOrientation(null);
    setVideoSize(null);
  }

  const autoOrientation: Orientation = useMemo(() => {
    const w = videoSize?.width ?? current?.width ?? 0;
    const h = videoSize?.height ?? current?.height ?? 0;
    // Square videos default to portrait so the phone stays upright.
    return w > h ? "landscape" : "portrait";
  }, [videoSize, current?.width, current?.height]);

  const orientation = manualOrientation ?? autoOrientation;
  const toggleOrientation = () =>
    setManualOrientation(orientation === "landscape" ? "portrait" : "landscape");

  // Apply the saved brightness on open; normalize (hand back to the system)
  // when leaving the player. The chosen value stays persisted for next time.
  useEffect(() => {
    const saved = playerPrefs.getBrightness();
    if (saved != null) void Brightness.setBrightnessAsync(saved);
    return () => {
      void Brightness.restoreSystemBrightnessAsync();
    };
  }, []);

  // Autoplay whenever the source resolves or changes (next/prev).
  useEffect(() => {
    if (current?.uri) player.play();
  }, [current?.uri, player]);

  // Capture the saved resume position the moment the video changes — BEFORE
  // playback starts recording (which would overwrite the stored position with
  // ~0 and defeat the resume).
  const resumeTargetRef = useRef<{ id: string; position: number } | null>(null);
  useEffect(() => {
    if (!current) {
      resumeTargetRef.current = null;
      return;
    }
    const entry = playbackStore.getEntry(current.id);
    resumeTargetRef.current =
      entry &&
      !entry.completed &&
      entry.position > RESUME_THRESHOLD &&
      entry.position < entry.duration - RESUME_THRESHOLD
        ? { id: current.id, position: entry.position }
        : null;
  }, [current?.id, current]);

  // Seek to the captured position once the video is ready to play.
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  const resumedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "readyToPlay" || !current) return;
    if (resumedIdRef.current === current.id) return;
    resumedIdRef.current = current.id;

    const target = resumeTargetRef.current;
    if (target && target.id === current.id) {
      player.seekBy(target.position - player.currentTime);
    }
  }, [status, current?.id, current, player]);

  // Record progress as the video plays.
  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    if (current) playbackStore.record(current.id, currentTime, player.duration);
  });

  // On pause, commit the position immediately so the library UI reflects it.
  useEventListener(player, "playingChange", ({ isPlaying }) => {
    if (!isPlaying && current && player.duration > 0) {
      playbackStore.record(current.id, player.currentTime, player.duration);
      playbackStore.flush();
    }
  });

  const goNext = () => {
    if (playlist && index >= 0 && index < playlist.length - 1)
      setCurrentId(playlist[index + 1].id);
  };
  const goPrev = () => {
    if (playlist && index > 0) setCurrentId(playlist[index - 1].id);
  };

  // Mark complete and auto-advance when the current video finishes.
  useEventListener(player, "playToEnd", () => {
    if (current)
      playbackStore.record(current.id, player.duration, player.duration);
    if (hasNext) goNext();
  });

  // Rotate the screen to match the video: landscape videos play horizontally,
  // portrait videos stay vertical. The rotate button can override this.
  useEffect(() => {
    void ScreenOrientation.lockAsync(
      orientation === "landscape"
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, [orientation]);

  // Persist progress and restore portrait when leaving the player.
  useEffect(
    () => () => {
      playbackStore.flush();
      void ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
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
            <ThemedText className="text-white">
              Couldn’t load this video.
            </ThemedText>
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
          orientation={orientation}
          onToggleOrientation={toggleOrientation}
        />
      )}
    </View>
  );
}

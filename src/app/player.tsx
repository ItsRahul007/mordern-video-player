import { useEvent, useEventListener } from "expo";
import * as Brightness from "expo-brightness";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useVideoPlayer, VideoView } from "expo-video";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, View } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { VolumeManager } from "react-native-volume-manager";
import { scheduleOnRN } from "react-native-worklets";

import { VideoControls } from "@/components/player/video-controls";
import { ThemedText } from "@/components/themed-text";
import {
  audioTrackLanguage,
  pickPreferredAudioTrack,
} from "@/lib/audio-track";
import { useFolderVideos } from "@/hooks/use-video-folders";
import { sortVideos, type VideoAsset } from "@/lib/media";
import { playbackStore, RESUME_THRESHOLD } from "@/lib/playback-store";
import { playerPrefs } from "@/lib/player-prefs";
import { useSort } from "@/providers/sort-provider";

type Orientation = "landscape" | "portrait";

export default function PlayerScreen() {
  const router = useRouter();
  const { albumId, id, uri: externalUri } = useLocalSearchParams<{
    albumId?: string;
    id?: string;
    uri?: string;
  }>();
  // External mode: a single video handed in by another app ("Open with").
  // There's no folder, so there's no playlist and no next/prev.
  const isExternal = !!externalUri;
  const { data: videos, isLoading } = useFolderVideos(
    isExternal ? undefined : albumId,
  );
  const { sort } = useSort();

  // Synthesize a one-off asset for the incoming URI. The display name is the
  // best we can derive from the URI; content:// URIs rarely carry a real one.
  const externalVideo = useMemo<VideoAsset | undefined>(() => {
    if (!externalUri) return undefined;
    let filename = "Video";
    try {
      filename = decodeURIComponent(externalUri.split("/").pop() ?? "") || "Video";
    } catch {
      filename = "Video";
    }
    return {
      id: externalUri,
      uri: externalUri,
      filename,
      duration: 0,
      width: 0,
      height: 0,
      creationTime: 0,
      size: null,
    };
  }, [externalUri]);

  // The playlist must match the order shown in the folder (the selected filter);
  // in external mode it's just the single incoming clip.
  const playlist = useMemo(
    () =>
      isExternal
        ? externalVideo
          ? [externalVideo]
          : undefined
        : videos
          ? sortVideos(videos, sort)
          : undefined,
    [isExternal, externalVideo, videos, sort],
  );

  // Track the currently playing video within the folder playlist.
  const [currentId, setCurrentId] = useState(id ?? externalUri);
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
  // Pinch-to-zoom scale (1 = fit, capped at 2 = 200%). Owned here so the
  // transform applies to the VideoView; the pinch gesture lives in the controls.
  const zoom = useSharedValue(1);
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ scale: zoom.value }],
  }));
  // A transform-based zoom only renders on Android over a TextureView, which is
  // far more expensive than the default SurfaceView and makes playback stutter.
  // Keep the smooth SurfaceView for normal 1x playback and switch to TextureView
  // only while actually zoomed in.
  const [zoomActive, setZoomActive] = useState(false);
  useAnimatedReaction(
    () => zoom.value > 1.001,
    (active, prev) => {
      if (active !== prev) scheduleOnRN(setZoomActive, active);
    },
  );

  const [trackedId, setTrackedId] = useState(current?.id);
  if (current?.id !== trackedId) {
    setTrackedId(current?.id);
    setManualOrientation(null);
    setVideoSize(null);
  }

  // Reset zoom to fit whenever the video changes. A shared value is mutable by
  // design; the immutability rule doesn't account for Reanimated.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    zoom.value = 1;
  }, [current?.id, zoom]);

  const autoOrientation: Orientation = useMemo(() => {
    const w = videoSize?.width ?? current?.width ?? 0;
    const h = videoSize?.height ?? current?.height ?? 0;
    // Square videos default to portrait so the phone stays upright.
    return w > h ? "landscape" : "portrait";
  }, [videoSize, current?.width, current?.height]);

  const orientation = manualOrientation ?? autoOrientation;
  const toggleOrientation = () =>
    setManualOrientation(orientation === "landscape" ? "portrait" : "landscape");

  // The status bar (clock, battery, notifications) follows the player controls:
  // visible while the overlay is up, hidden when it auto-hides.
  const [controlsVisible, setControlsVisible] = useState(true);

  // Suppress the system volume UI while the player is active so hardware
  // volume buttons trigger the in-player indicator instead.
  const [hwVolume, setHwVolume] = useState<number | null>(null);
  const hwVolumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHwVolume = useCallback((vol: number) => {
    setHwVolume(vol);
    if (hwVolumeTimer.current) clearTimeout(hwVolumeTimer.current);
    hwVolumeTimer.current = setTimeout(() => setHwVolume(null), 1200);
  }, []);

  useEffect(() => {
    VolumeManager.showNativeVolumeUI({ enabled: false });

    const listener = VolumeManager.addVolumeListener((result) => {
      showHwVolume(result.volume);
    });

    return () => {
      listener.remove();
      VolumeManager.showNativeVolumeUI({ enabled: true });
      if (hwVolumeTimer.current) clearTimeout(hwVolumeTimer.current);
    };
  }, [showHwVolume]);

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

  // Pick the audio track once per video: the user's saved language if present,
  // else Hindi if available, else the video's own default (left untouched).
  const { availableAudioTracks } = useEvent(player, "availableAudioTracksChange", {
    availableAudioTracks: player.availableAudioTracks,
  });
  const audioAppliedRef = useRef<string | null>(null);
  // expo-video's player is a mutable native object; assigning audioTrack selects
  // it — safe here because the effect runs after render, keyed to the video id.
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => {
    if (!current || !availableAudioTracks?.length) return;
    if (audioAppliedRef.current === current.id) return;
    audioAppliedRef.current = current.id;

    const desired = pickPreferredAudioTrack(
      availableAudioTracks,
      playerPrefs.getAudioLanguage(),
    );
    const currentLang = player.audioTrack
      ? audioTrackLanguage(player.audioTrack)
      : null;
    if (desired && audioTrackLanguage(desired) !== currentLang) {
      // eslint-disable-next-line react-hooks/immutability
      player.audioTrack = desired;
    }
  }, [availableAudioTracks, current?.id, current, player]);

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

  // Leave the player. Normally we just pop back to the folder we came from, but
  // when the app was launched straight into the player from another app's "Open
  // with", there's nothing beneath us — fall back to the home screen so back
  // never drops the user out of the app.
  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  // Intercept the Android hardware back button in external mode so it routes to
  // home instead of exiting the app.
  useEffect(() => {
    if (!isExternal) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleClose();
      return true;
    });
    return () => sub.remove();
  }, [isExternal, handleClose]);

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
      <StatusBar
        hidden={!controlsVisible}
        style="light"
        animated
        hideTransitionAnimation="fade"
      />

      {current ? (
        <Animated.View style={[{ flex: 1 }, zoomStyle]}>
          <VideoView
            player={player}
            style={{ flex: 1 }}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture
            surfaceType={zoomActive ? "textureView" : "surfaceView"}
          />
        </Animated.View>
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
          onClose={handleClose}
          onNext={goNext}
          onPrev={goPrev}
          hasNext={hasNext}
          hasPrev={hasPrev}
          orientation={orientation}
          onToggleOrientation={toggleOrientation}
          onVisibilityChange={setControlsVisible}
          zoom={zoom}
          hardwareVolume={hwVolume}
        />
      )}
    </View>
  );
}

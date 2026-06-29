import { useEvent } from "expo";
import * as Brightness from "expo-brightness";
import { LinearGradient } from "expo-linear-gradient";
import type { VideoPlayer } from "expo-video";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  type SharedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import {
  OptionsSheet,
  type SheetMode,
} from "@/components/player/options-sheet";
import { SeekBar } from "@/components/player/seek-bar";
import { VolumeManager } from "react-native-volume-manager";

import { SeekFeedback } from "@/components/player/seek-feedback";
import { ThemedText } from "@/components/themed-text";
import { formatDuration } from "@/lib/format";
import { playerPrefs } from "@/lib/player-prefs";

type VideoControlsProps = {
  player: VideoPlayer;
  title?: string;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  orientation?: "landscape" | "portrait";
  onToggleOrientation?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  /** Pinch-to-zoom scale, owned by the player (1 = fit, 2 = 200% max). */
  zoom?: SharedValue<number>;
  /** When non-null the hardware volume buttons changed the level; show the
   *  custom volume indicator instead of the system overlay. */
  hardwareVolume?: number | null;
  /** True while the player is fetching/buffering (e.g. a streamed source);
   *  the center transport shows a spinner instead of the play/pause button. */
  isLoading?: boolean;
};

const HIDE_DELAY = 3500;
const SEEK_STEP = 10;
/** Pinch-to-zoom bounds: 1 = fit-to-screen, 2 = 200% (max in and out). */
const MIN_ZOOM = 1;
const MAX_ZOOM = 2;
/** Seconds skipped per full-width horizontal drag across the video. */
const DRAG_SEEK_SPAN = 90;

type FeedbackState = {
  dir: "forward" | "backward";
  seconds: number;
  nonce: number;
} | null;
type SeekPreview = { target: number; delta: number } | null;
type VerticalFeedback = { type: "volume" | "brightness"; value: number } | null;

function IconButton({
  name,
  size,
  onPress,
  disabled,
}: {
  name: IconName;
  size: number;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      className="active:opacity-70"
      style={{ opacity: disabled ? 0.3 : 1 }}
    >
      <Icon name={name} size={size} color="#ffffff" />
    </Pressable>
  );
}

export function VideoControls({
  player,
  title,
  onClose,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  onToggleOrientation,
  onVisibilityChange,
  zoom,
  hardwareVolume,
  isLoading,
}: VideoControlsProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [seekPreview, setSeekPreview] = useState<SeekPreview>(null);
  const [verticalFeedback, setVerticalFeedback] =
    useState<VerticalFeedback>(null);
  const [sheet, setSheet] = useState<SheetMode>(null);

  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  const duration = player.duration ?? 0;
  const progress = duration > 0 ? currentTime / duration : 0;

  // Mirror control visibility to the parent so it can show/hide the system
  // status bar in step with the overlay.
  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  // Show the custom volume indicator when the hardware volume buttons are
  // pressed (the parent suppresses the system volume overlay and passes the
  // new level here). A null value means the feedback should be cleared.
  useEffect(() => {
    if (hardwareVolume != null) {
      setVerticalFeedback({ type: "volume", value: hardwareVolume });
    } else {
      // Only clear if the current feedback is a volume indicator (don't clobber
      // an active brightness swipe).
      setVerticalFeedback((prev) =>
        prev?.type === "volume" ? null : prev,
      );
    }
  }, [hardwareVolume]);

  // Auto-hide while playing and not scrubbing. Re-runs (and resets the timer)
  // whenever visibility/playback/scrubbing changes.
  useEffect(() => {
    if (!(visible && isPlaying && !scrubbing)) return;
    const timer = setTimeout(() => setVisible(false), HIDE_DELAY);
    return () => clearTimeout(timer);
  }, [visible, isPlaying, scrubbing]);

  // Briefly show the double-tap seek feedback, then clear it.
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 650);
    return () => clearTimeout(timer);
  }, [feedback]);

  const togglePlay = () => {
    if (isPlaying) player.pause();
    else player.play();
  };

  const seekToFraction = (fraction: number) => {
    // expo-video's player is a mutable native object; assigning currentTime seeks.
    // eslint-disable-next-line react-hooks/immutability
    if (duration > 0) player.currentTime = fraction * duration;
  };

  // Accumulate the skip amount so rapid double-taps read "10s, 20s, 30s…".
  const bumpFeedback = (dir: "forward" | "backward") =>
    setFeedback((prev) => ({
      dir,
      seconds: prev && prev.dir === dir ? prev.seconds + SEEK_STEP : SEEK_STEP,
      nonce: (prev?.nonce ?? 0) + 1,
    }));

  // Gestures on the video surface:
  // - single tap: toggle controls
  // - double tap: left third = back 10s, right = forward 10s, middle = play/pause
  // - horizontal drag: scrub through the video with a time preview
  // Refs let the seek bar block these so touches on the bar always win.
  // Built in useMemo so the gesture refs aren't flagged as render-phase reads.
  const singleTapRef = useRef<GestureType | undefined>(undefined);
  const doubleTapRef = useRef<GestureType | undefined>(undefined);
  const dragRef = useRef<GestureType | undefined>(undefined);
  // Anchor position captured at drag start (shared value = gesture-callback safe).
  const dragStart = useSharedValue(0);
  // Vertical-drag scratch: live value being adjusted, side (0 = volume/right,
  // 1 = brightness/left), and whether the async baseline has loaded yet.
  const vStart = useSharedValue(0);
  const vSide = useSharedValue(0);
  const vReady = useSharedValue(false);
  // Zoom scale captured at pinch start (fallback shared value if no zoom prop).
  const pinchStart = useSharedValue(1);
  const localZoom = useSharedValue(1);
  const zoomValue = zoom ?? localZoom;

  const gesture = useMemo(() => {
    const singleTap = Gesture.Tap()
      // eslint-disable-next-line react-hooks/refs
      .withRef(singleTapRef)
      .maxDuration(250)
      .runOnJS(true)
      .onEnd(() => setVisible((v) => !v));

    const doubleTap = Gesture.Tap()
      // eslint-disable-next-line react-hooks/refs
      .withRef(doubleTapRef)
      .numberOfTaps(2)
      .maxDuration(250)
      .runOnJS(true)
      .onEnd((event) => {
        if (event.x < width / 3) {
          player.seekBy(-SEEK_STEP);
          bumpFeedback("backward");
        } else if (event.x > (width * 2) / 3) {
          player.seekBy(SEEK_STEP);
          bumpFeedback("forward");
        } else {
          if (player.playing) player.pause();
          else player.play();
          setVisible(true);
        }
      });

    const targetFor = (translationX: number, dur: number) =>
      Math.max(
        0,
        Math.min(
          dur,
          dragStart.value + (translationX / width) * DRAG_SEEK_SPAN,
        ),
      );

    const drag = Gesture.Pan()
      // eslint-disable-next-line react-hooks/refs
      .withRef(dragRef)
      .runOnJS(true)
      .activeOffsetX([-15, 15])
      .failOffsetY([-25, 25])
      .onStart(() => {
        dragStart.value = player.currentTime;
      })
      .onUpdate((event) => {
        const dur = player.duration || 0;
        if (dur <= 0) return;
        const target = targetFor(event.translationX, dur);
        setSeekPreview({ target, delta: target - dragStart.value });
      })
      .onEnd((event) => {
        const dur = player.duration || 0;
        if (dur > 0)
          player.seekBy(
            targetFor(event.translationX, dur) - player.currentTime,
          );
      })
      .onFinalize(() => setSeekPreview(null));

    // Vertical drag: right half = volume, left half = brightness.
    // A swipe over ~60% of the screen height covers the full 0–1 range.
    const verticalDrag = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetY([-15, 15])
      .failOffsetX([-25, 25])
      .onStart((event) => {
        // Read the CURRENT device value as the baseline (async). Until it
        // resolves, ignore movement so we never adjust from a stale value
        // (which previously cross-contaminated volume <-> brightness).
        vReady.value = false;
        const isLeft = event.x < width / 2;
        vSide.value = isLeft ? 1 : 0;
        if (isLeft) {
          Brightness.getBrightnessAsync()
            .then((value) => {
              vStart.value = value;
              vReady.value = true;
            })
            .catch(() => {
              vStart.value = 1;
              vReady.value = true;
            });
        } else {
          VolumeManager.getVolume()
            .then((result) => {
              vStart.value = result.volume;
              vReady.value = true;
            })
            .catch(() => {
              vStart.value = 1;
              vReady.value = true;
            });
        }
      })
      // Accumulate per-frame deltas onto the live value (not a reused baseline).
      .onChange((event) => {
        if (!vReady.value) return;
        const next = Math.max(
          0,
          Math.min(1, vStart.value - event.changeY / (height * 0.6)),
        );
        vStart.value = next;
        if (vSide.value === 1) {
          void Brightness.setBrightnessAsync(next);
          playerPrefs.setBrightness(next);
          setVerticalFeedback({ type: "brightness", value: next });
        } else {
          // Device media volume — the OS persists this across sessions.
          void VolumeManager.setVolume(next);
          setVerticalFeedback({ type: "volume", value: next });
        }
      })
      .onFinalize(() => {
        playerPrefs.persist();
        setVerticalFeedback(null);
      });

    // Two-finger pinch to zoom the video, clamped to 100%–200%. Runs on the UI
    // thread (no runOnJS) so the scale tracks the fingers smoothly.
    const pinch = Gesture.Pinch()
      .onStart(() => {
        pinchStart.value = zoomValue.value;
      })
      .onUpdate((event) => {
        zoomValue.value = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, pinchStart.value * event.scale),
        );
      });

    return Gesture.Race(
      pinch,
      drag,
      verticalDrag,
      Gesture.Exclusive(doubleTap, singleTap),
    );
    // dragStart/vStart/vSide/zoom are stable shared values; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, player]);

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Full-screen gesture layer (tap, double tap, drag-to-seek). */}
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {/* Animated double-tap seek feedback (left or right half). */}
      {feedback && (
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="flex-row"
        >
          <View className="flex-1 items-center justify-center">
            {feedback.dir === "backward" && (
              <SeekFeedback
                key={feedback.nonce}
                direction="backward"
                seconds={feedback.seconds}
              />
            )}
          </View>
          <View className="flex-1 items-center justify-center">
            {feedback.dir === "forward" && (
              <SeekFeedback
                key={feedback.nonce}
                direction="forward"
                seconds={feedback.seconds}
              />
            )}
          </View>
        </View>
      )}

      {/* Drag-to-seek time preview. */}
      {seekPreview && (
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="items-center justify-center"
        >
          <View className="items-center gap-1 rounded-2xl bg-black/65 px-6 py-3">
            <ThemedText className="text-2xl font-bold text-white">
              {formatDuration(seekPreview.target)}
            </ThemedText>
            <ThemedText className="text-sm font-medium text-white/70">
              {seekPreview.delta >= 0 ? "+" : "−"}
              {formatDuration(Math.abs(seekPreview.delta))}
            </ThemedText>
          </View>
        </View>
      )}

      {/* Volume / brightness vertical-drag indicator. */}
      {verticalFeedback && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(300)}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="items-center justify-center"
        >
          <View className="items-center gap-2 rounded-2xl bg-black/65 px-6 py-4">
            <Icon
              name={
                verticalFeedback.type === "volume" ? "volume" : "brightness"
              }
              size={28}
              color="#ffffff"
            />
            <View className="h-1.5 w-28 overflow-hidden rounded-full bg-white/25">
              <View
                className="h-full rounded-full bg-white"
                style={{ width: `${verticalFeedback.value * 100}%` }}
              />
            </View>
            <ThemedText className="text-xs font-semibold text-white">
              {Math.round(verticalFeedback.value * 100)}%
            </ThemedText>
          </View>
        </Animated.View>
      )}

      {visible && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          pointerEvents="box-none"
          style={StyleSheet.absoluteFill}
        >
          <LinearGradient
            colors={["rgba(0,0,0,0.6)", "transparent", "rgba(0,0,0,0.75)"]}
            locations={[0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          <View pointerEvents="box-none" className="flex-1">
            {/* Top bar */}
            <View
              pointerEvents="box-none"
              className="flex-row items-center gap-3 px-5"
              style={{ paddingTop: insets.top + 8 }}
            >
              <IconButton name="back" size={26} onPress={onClose} />
              {title && (
                <ThemedText
                  numberOfLines={1}
                  className="flex-1 text-base font-semibold text-white"
                >
                  {title}
                </ThemedText>
              )}
              {onToggleOrientation && (
                <IconButton
                  name="rotate"
                  size={22}
                  onPress={onToggleOrientation}
                />
              )}
              <IconButton
                name="captions"
                size={24}
                onPress={() => setSheet("cc")}
              />
              <IconButton
                name="settings"
                size={22}
                onPress={() => setSheet("settings")}
              />
            </View>

            {/* Center transport: prev · play/pause · next */}
            <View
              pointerEvents="box-none"
              className="flex-1 flex-row items-center justify-center gap-12"
            >
              {onPrev && (
                <IconButton
                  name="previous"
                  size={30}
                  onPress={onPrev}
                  disabled={!hasPrev}
                />
              )}
              {isLoading ? (
                <View className="h-[62px] w-[62px] items-center justify-center">
                  <ActivityIndicator size="large" color="#ffffff" />
                </View>
              ) : (
                <Pressable
                  onPress={togglePlay}
                  hitSlop={16}
                  className="active:opacity-70"
                >
                  <Icon
                    name={isPlaying ? "pause" : "play"}
                    size={62}
                    color="#ffffff"
                  />
                </Pressable>
              )}
              {onNext && (
                <IconButton
                  name="next"
                  size={30}
                  onPress={onNext}
                  disabled={!hasNext}
                />
              )}
            </View>

            {/* Bottom seek bar */}
            <View
              pointerEvents="box-none"
              className="px-5"
              style={{ paddingBottom: insets.bottom + 16 }}
            >
              <SeekBar
                progress={progress}
                onSeek={seekToFraction}
                onScrubbingChange={setScrubbing}
                blockGestures={[singleTapRef, doubleTapRef, dragRef]}
              />
              <View className="mt-1 flex-row justify-between">
                <ThemedText className="text-xs font-medium text-white">
                  {formatDuration(currentTime)}
                </ThemedText>
                <ThemedText className="text-xs font-medium text-white/70">
                  {formatDuration(duration)}
                </ThemedText>
              </View>
            </View>
          </View>
        </Animated.View>
      )}

      <OptionsSheet
        player={player}
        mode={sheet}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

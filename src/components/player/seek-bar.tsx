import { View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';

type SeekBarProps = {
  /** Current playback progress, 0..1. */
  progress: number;
  /** Called with a 0..1 fraction when the user taps or finishes scrubbing. */
  onSeek: (fraction: number) => void;
  /** Notifies the parent while the user is actively dragging. */
  onScrubbingChange?: (scrubbing: boolean) => void;
  /** Gestures that this bar should win over (e.g. the overlay's tap/drag layer). */
  blockGestures?: React.RefObject<GestureType | undefined>[];
};

const TRACK_HEIGHT = 4;
const THUMB_SIZE = 16;
const HIT_HEIGHT = 36;

export function SeekBar({ progress, onSeek, onScrubbingChange, blockGestures }: SeekBarProps) {
  const width = useSharedValue(0);
  const scrubX = useSharedValue(0);
  const scrubbing = useSharedValue(false);
  // Derive the prop into a shared value without an effect (re-runs when progress changes).
  const progressSV = useDerivedValue(() => progress, [progress]);

  const setScrubbing = (value: boolean) => onScrubbingChange?.(value);
  const blocked = blockGestures ?? [];

  // Tap: seek straight to the tapped position. A Pan often never activates for a
  // tap-without-movement (so its onEnd never fires) — handle taps explicitly.
  const tap = Gesture.Tap()
    .maxDuration(300)
    .blocksExternalGesture(...blocked)
    .onEnd((e) => {
      const fraction = width.value > 0 ? Math.max(0, Math.min(e.x, width.value)) / width.value : 0;
      runOnJS(onSeek)(fraction);
    });

  // Drag: scrub. minDistance distinguishes it from a tap.
  const pan = Gesture.Pan()
    .minDistance(4)
    .maxPointers(1)
    .blocksExternalGesture(...blocked)
    .onStart((e) => {
      scrubbing.value = true;
      scrubX.value = Math.max(0, Math.min(e.x, width.value));
      runOnJS(setScrubbing)(true);
    })
    .onUpdate((e) => {
      scrubX.value = Math.max(0, Math.min(e.x, width.value));
    })
    .onEnd(() => {
      const fraction = width.value > 0 ? scrubX.value / width.value : 0;
      runOnJS(onSeek)(fraction);
    })
    // Always runs (even if the gesture is cancelled) — guarantees scrubbing resets.
    .onFinalize(() => {
      scrubbing.value = false;
      runOnJS(setScrubbing)(false);
    });

  const gesture = Gesture.Race(pan, tap);

  const fillStyle = useAnimatedStyle(() => {
    const w = scrubbing.value ? scrubX.value : progressSV.value * width.value;
    return { width: Math.max(0, w) };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const x = scrubbing.value ? scrubX.value : progressSV.value * width.value;
    return { transform: [{ translateX: Math.max(0, x) - THUMB_SIZE / 2 }] };
  });

  return (
    <GestureDetector gesture={gesture}>
      {/* Tall, opaque hit area so the thin track is easy to grab. */}
      <View className="justify-center" style={{ height: HIT_HEIGHT }} collapsable={false}>
        <View
          onLayout={(e) => {
            width.value = e.nativeEvent.layout.width;
          }}
          className="overflow-visible rounded-full bg-white/30"
          style={{ height: TRACK_HEIGHT }}>
          <Animated.View className="h-full rounded-full bg-white" style={fillStyle} />
          <Animated.View
            className="absolute rounded-full bg-white"
            style={[
              { width: THUMB_SIZE, height: THUMB_SIZE, top: TRACK_HEIGHT / 2 - THUMB_SIZE / 2 },
              thumbStyle,
            ]}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

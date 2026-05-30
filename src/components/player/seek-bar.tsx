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
  /** Called with a 0..1 fraction when the user finishes scrubbing. */
  onSeek: (fraction: number) => void;
  /** Notifies the parent while the user is actively dragging. */
  onScrubbingChange?: (scrubbing: boolean) => void;
  /** Gestures that this bar should win over (e.g. the overlay's tap-to-toggle). */
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

  const pan = Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    // Win the touch over the full-screen tap layer so taps on the bar always seek.
    .blocksExternalGesture(...(blockGestures ?? []))
    .onBegin((e) => {
      scrubbing.value = true;
      scrubX.value = Math.max(0, Math.min(e.x, width.value));
      runOnJS(setScrubbing)(true);
    })
    .onUpdate((e) => {
      scrubX.value = Math.max(0, Math.min(e.x, width.value));
    })
    .onEnd(() => {
      const fraction = width.value > 0 ? scrubX.value / width.value : 0;
      scrubbing.value = false;
      runOnJS(onSeek)(fraction);
      runOnJS(setScrubbing)(false);
    });

  const fillStyle = useAnimatedStyle(() => {
    const w = scrubbing.value ? scrubX.value : progressSV.value * width.value;
    return { width: Math.max(0, w) };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const x = scrubbing.value ? scrubX.value : progressSV.value * width.value;
    return { transform: [{ translateX: Math.max(0, x) - THUMB_SIZE / 2 }] };
  });

  return (
    <GestureDetector gesture={pan}>
      {/* Tall, opaque hit area so the thin track is easy to grab. */}
      <View className="justify-center" style={{ height: HIT_HEIGHT }} collapsable={false}>
        <View
          onLayout={(e) => {
            width.value = e.nativeEvent.layout.width;
          }}
          className="overflow-visible rounded-full bg-white/30"
          style={{ height: TRACK_HEIGHT }}>
          <Animated.View className="h-full rounded-full bg-accent" style={fillStyle} />
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

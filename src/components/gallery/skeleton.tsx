import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { useTheme } from "@/hooks/use-theme";

const CYCLE_MS = 1400;

/**
 * One clock (0 → 1, repeating) shared by every block in a skeleton, so a
 * whole screen of placeholders costs a single running animation.
 */
export function useSkeletonClock(): SharedValue<number> {
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.set(withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false));
  }, [clock]);
  return clock;
}

/**
 * A placeholder block that softly pulses. `phase` (0–1) offsets it along the
 * cycle — giving rows increasing phases makes the pulse travel down the
 * skeleton as a wave.
 */
export function SkeletonBlock({
  clock,
  phase = 0,
  style,
}: {
  clock: SharedValue<number>;
  phase?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const animated = useAnimatedStyle(() => {
    const t = clock.get() - phase;
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * t);
    return { opacity: 0.45 + 0.4 * wave };
  });
  return (
    <Animated.View style={[{ backgroundColor: colors.backgroundElement }, style, animated]} />
  );
}

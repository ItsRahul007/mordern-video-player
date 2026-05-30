import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';

type SeekFeedbackProps = {
  direction: 'forward' | 'backward';
  /** Total seconds skipped so far in this burst (for rapid repeated taps). */
  seconds: number;
};

/**
 * Small animated double-tap feedback: three chevrons that fade in staggered in
 * the skip direction (mounts fresh on each tap, so the animation replays).
 */
export function SeekFeedback({ direction, seconds }: SeekFeedbackProps) {
  const forward = direction === 'forward';
  return (
    <Animated.View
      entering={FadeIn.duration(120)}
      exiting={FadeOut.duration(220)}
      className="items-center gap-1 rounded-full bg-black/55 px-7 py-5">
      <View className="flex-row gap-0.5">
        {[0, 1, 2].map((i) => (
          <Animated.View key={i} entering={FadeIn.delay((forward ? i : 2 - i) * 90).duration(220)}>
            <Icon name={forward ? 'chevronRight' : 'back'} size={20} color="#ffffff" />
          </Animated.View>
        ))}
      </View>
      <ThemedText className="text-xs font-semibold text-white">{seconds} seconds</ThemedText>
    </Animated.View>
  );
}

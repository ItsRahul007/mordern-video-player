import { SymbolView } from 'expo-symbols';
import type { ColorValue } from 'react-native';

/**
 * Cross-platform icon wrapper. `SymbolView` only renders SF Symbols on iOS;
 * Android/web need Material Symbol names. Each entry maps one semantic icon to
 * the right glyph per platform so icons are visible everywhere.
 */
const ICONS = {
  settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
  back: { ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' },
  chevronRight: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  lock: { ios: 'lock.fill', android: 'lock', web: 'lock' },
  library: { ios: 'film.stack', android: 'video_library', web: 'video_library' },
  play: { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' },
  pause: { ios: 'pause.fill', android: 'pause', web: 'pause' },
  back10: { ios: 'gobackward.10', android: 'replay_10', web: 'replay_10' },
  forward10: { ios: 'goforward.10', android: 'forward_10', web: 'forward_10' },
  previous: { ios: 'backward.end.fill', android: 'skip_previous', web: 'skip_previous' },
  next: { ios: 'forward.end.fill', android: 'skip_next', web: 'skip_next' },
  close: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  fullscreen: {
    ios: 'arrow.up.left.and.arrow.down.right',
    android: 'fullscreen',
    web: 'fullscreen',
  },
  light: { ios: 'sun.max.fill', android: 'light_mode', web: 'light_mode' },
  dark: { ios: 'moon.fill', android: 'dark_mode', web: 'dark_mode' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter_list', web: 'filter_list' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  captions: { ios: 'captions.bubble', android: 'closed_caption', web: 'closed_caption' },
} as const;

export type IconName = keyof typeof ICONS;

type IconProps = {
  name: IconName;
  size?: number;
  color?: ColorValue;
};

export function Icon({ name, size = 24, color }: IconProps) {
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} />;
}

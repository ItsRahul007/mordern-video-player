import { FontAwesome } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import type { ColorValue } from 'react-native';

/**
 * Brand logos (e.g. WhatsApp) aren't part of SF Symbols or Material Symbols,
 * so they're rendered from FontAwesome's brand glyphs instead of `SymbolView`.
 */
const BRAND_ICONS = {
  whatsapp: 'whatsapp',
  instagram: 'instagram',
} as const;

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
  volume: { ios: 'speaker.wave.2.fill', android: 'volume_up', web: 'volume_up' },
  brightness: { ios: 'sun.max.fill', android: 'brightness_high', web: 'brightness_high' },
  rotate: { ios: 'rotate.right', android: 'screen_rotation', web: 'screen_rotation' },
  trash: { ios: 'trash', android: 'delete', web: 'delete' },
  share: { ios: 'square.and.arrow.up', android: 'share', web: 'share' },
  xmark: { ios: 'xmark', android: 'close', web: 'close' },
  archive: { ios: 'doc.zipper', android: 'folder_zip', web: 'folder_zip' },
  unarchive: { ios: 'arrow.down.doc', android: 'unarchive', web: 'unarchive' },
  status: { ios: 'circle.dashed', android: 'motion_photos_on', web: 'motion_photos_on' },
  save: { ios: 'arrow.down.circle', android: 'download', web: 'download' },
  paste: { ios: 'doc.on.clipboard', android: 'content_paste', web: 'content_paste' },
  playCircle: { ios: 'play.circle.fill', android: 'play_circle', web: 'play_circle' },
  image: { ios: 'photo', android: 'image', web: 'image' },
  terabox: { ios: 'shippingbox.fill', android: 'cloud_download', web: 'cloud_download' },
} as const;

export type IconName = keyof typeof ICONS | keyof typeof BRAND_ICONS;

type IconProps = {
  name: IconName;
  size?: number;
  color?: ColorValue;
};

export function Icon({ name, size = 24, color }: IconProps) {
  if (name in BRAND_ICONS) {
    return (
      <FontAwesome
        name={BRAND_ICONS[name as keyof typeof BRAND_ICONS]}
        size={size}
        color={color}
      />
    );
  }
  return <SymbolView name={ICONS[name as keyof typeof ICONS]} size={size} tintColor={color} />;
}

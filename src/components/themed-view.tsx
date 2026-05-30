import { View, type ViewProps } from 'react-native';

export type ThemedSurface = 'background' | 'surface' | 'surface-2';

export type ThemedViewProps = ViewProps & {
  /** Semantic background that adapts to light/dark automatically. */
  surface?: ThemedSurface;
};

const surfaceClass: Record<ThemedSurface, string> = {
  background: 'bg-background',
  surface: 'bg-surface',
  'surface-2': 'bg-surface-2',
};

export function ThemedView({ surface = 'background', className, ...rest }: ThemedViewProps) {
  return <View className={`${surfaceClass[surface]} ${className ?? ''}`} {...rest} />;
}

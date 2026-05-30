import { Text, type TextProps } from 'react-native';

export type ThemedTextType = 'default' | 'title' | 'subtitle' | 'small' | 'smallBold' | 'muted';

export type ThemedTextProps = TextProps & {
  type?: ThemedTextType;
};

const typeClass: Record<ThemedTextType, string> = {
  default: 'text-base font-medium text-foreground',
  title: 'text-3xl font-bold text-foreground',
  subtitle: 'text-xl font-semibold text-foreground',
  small: 'text-sm font-medium text-foreground',
  smallBold: 'text-sm font-bold text-foreground',
  muted: 'text-sm font-medium text-muted',
};

export function ThemedText({ type = 'default', className, ...rest }: ThemedTextProps) {
  return <Text className={`${typeClass[type]} ${className ?? ''}`} {...rest} />;
}

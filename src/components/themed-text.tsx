import { Text, type TextProps } from "react-native";

export type ThemedTextType =
  | "default"
  | "title"
  | "subtitle"
  | "small"
  | "smallBold"
  | "muted";

export type ThemedTextProps = TextProps & {
  type?: ThemedTextType;
};

const typeClass: Record<ThemedTextType, string> = {
  default: "text-base font-medium text-foreground dark:text-white",
  title: "text-3xl font-bold text-foreground dark:text-white",
  subtitle: "text-xl font-semibold text-foreground dark:text-white",
  small: "text-sm font-medium text-foreground dark:text-white",
  smallBold: "text-sm font-bold text-foreground dark:text-white",
  muted: "text-sm font-medium text-gray-400",
};

export function ThemedText({
  type = "default",
  className,
  ...rest
}: ThemedTextProps) {
  return <Text className={`${typeClass[type]} ${className ?? ""}`} {...rest} />;
}

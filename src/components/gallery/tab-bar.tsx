import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import type { Tabs } from "expo-router";

type TabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>["tabBar"]>
>[0];

const TAB_ICONS: Record<string, IconName> = {
  index: "home",
  gallery: "gallery",
};

function TabButton({
  label,
  icon,
  focused,
  onPress,
  onLongPress,
}: {
  label: string;
  icon: IconName;
  focused: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();

  // Material-3 style "active indicator" pill that grows in behind the icon.
  const pillStyle = useAnimatedStyle(() => ({
    opacity: withTiming(focused ? 1 : 0, { duration: 160 }),
    transform: [{ scaleX: withSpring(focused ? 1 : 0.5, { damping: 16 }) }],
  }));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      className="flex-1 items-center justify-center gap-1 py-2"
    >
      <View className="h-8 w-16 items-center justify-center">
        <Animated.View
          className="absolute inset-0 rounded-full"
          style={[{ backgroundColor: `${colors.accent}2E` }, pillStyle]}
        />
        <Icon
          name={icon}
          size={22}
          color={focused ? colors.accent : colors.textSecondary}
        />
      </View>
      <ThemedText
        type="small"
        style={{ color: focused ? colors.text : colors.textSecondary }}
        className={focused ? "font-semibold" : ""}
      >
        {label}
      </ThemedText>
    </Pressable>
  );
}

/** Bottom navigation bar for the root tabs (Home / Gallery). */
export function AppTabBar({ state, descriptors, navigation }: TabBarProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row px-6"
      style={{
        backgroundColor: colors.background,
        borderTopWidth: 0.5,
        borderTopColor: colors.backgroundSelected,
        paddingBottom: Math.max(insets.bottom, 8),
      }}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label =
          typeof options.tabBarLabel === "string"
            ? options.tabBarLabel
            : (options.title ?? route.name);
        const focused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        return (
          <TabButton
            key={route.key}
            label={label}
            icon={TAB_ICONS[route.name] ?? "home"}
            focused={focused}
            onPress={onPress}
            onLongPress={() =>
              navigation.emit({ type: "tabLongPress", target: route.key })
            }
          />
        );
      })}
    </View>
  );
}

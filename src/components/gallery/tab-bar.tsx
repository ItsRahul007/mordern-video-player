import { useEffect, type ComponentProps } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import type { Tabs } from "expo-router";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

const TAB_ICONS: Record<string, IconName> = {
  index: "home",
  gallery: "gallery",
};

/** Width of one tab slot inside the dock (dp). */
const SLOT = 124;
/** Height of a slot / the sliding segment (dp). */
const SLOT_H = 48;
/** Padding between the dock's edge and the segment (dp). */
const INSET = 5;
const SPRING = { damping: 18, stiffness: 230, mass: 0.7 };
/** Space above the dock (dp). */
const DOCK_TOP = 8;

/** Space under the dock: the system navigation bar plus a small lift. */
function dockBottom(insetBottom: number): number {
  return Math.max(insetBottom, 10) + 4;
}

/**
 * Height the floating dock covers at the bottom of the screen. Tab screens
 * scroll under the dock, so they add this much padding at the end of their
 * lists to keep the last row reachable.
 */
export function useTabBarInset(): number {
  const insets = useSafeAreaInsets();
  return DOCK_TOP + SLOT_H + INSET * 2 + dockBottom(insets.bottom);
}

/**
 * Bottom navigation as a floating dock: a rounded capsule lifted off the
 * bottom edge, where the active tab is a solid accent segment (icon + label)
 * that springs across when you switch; inactive tabs are just a quiet icon.
 */
export function AppTabBar({ state, descriptors, navigation }: TabBarProps) {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  // Text/icons on the accent segment: white in both themes.
  const onAccent = "#FFFFFF";

  const offset = useSharedValue(state.index * SLOT);
  useEffect(() => {
    offset.set(withSpring(state.index * SLOT, SPRING));
  }, [state.index, offset]);
  const segmentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.get() }],
  }));

  return (
    // Floats over the screens (no background strip): only the dock itself
    // is drawn, so photos scroll visibly behind it. box-none lets touches
    // beside the dock reach the content underneath.
    <View
      pointerEvents="box-none"
      className="absolute bottom-0 left-0 right-0 items-center"
      style={{
        paddingTop: DOCK_TOP,
        paddingBottom: dockBottom(insets.bottom),
      }}
    >
      <View
        className="flex-row rounded-full"
        style={{
          padding: INSET,
          backgroundColor: colors.backgroundElement,
          borderWidth: 0.5,
          borderColor: colors.backgroundSelected,
          shadowColor: "#000",
          shadowOpacity: scheme === "dark" ? 0.5 : 0.15,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 10,
        }}
      >
        {/* The sliding accent segment behind the active tab. */}
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full"
          style={[
            {
              top: INSET,
              left: INSET,
              width: SLOT,
              height: SLOT_H,
              backgroundColor: colors.accent,
            },
            segmentStyle,
          ]}
        />

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
            <Pressable
              key={route.key}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              // Plain style object: NativeWind drops function styles when a
              // className is present, which collapsed the slots.
              style={{ width: SLOT, height: SLOT_H }}
              className="flex-row items-center justify-center gap-2 active:opacity-75"
            >
              <Icon
                name={TAB_ICONS[route.name] ?? "home"}
                size={22}
                color={focused ? onAccent : colors.textSecondary}
              />
              {focused && (
                <ThemedText className="text-[15px] font-semibold" style={{ color: onAccent }}>
                  {label}
                </ThemedText>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

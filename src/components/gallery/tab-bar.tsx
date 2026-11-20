import { Pressable, View } from "react-native";
import { useState } from "react";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { PAGER_TABS, useTabPager } from "@/components/gallery/tab-pager";


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
export function AppTabBar() {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { position, index: focusedIndex, goTo } = useTabPager();
  // Text/icons on the accent segment: white in both themes.
  const onAccent = "#FFFFFF";

  // The capsule tracks the pager position live — it slides with the finger
  // during a swipe and springs with the pages on a tap.
  const segmentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * SLOT }],
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

        {PAGER_TABS.map((tab, index) => (
          <DockTab
            key={tab.name}
            index={index}
            label={tab.label}
            icon={TAB_ICONS[tab.name] ?? "home"}
            focused={focusedIndex === index}
            position={position}
            onAccent={onAccent}
            inactiveColor={colors.textSecondary}
            onPress={() => {
              if (focusedIndex !== index) goTo(index);
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Gap between icon and label when fully shown (dp). */
const LABEL_GAP = 8;

/**
 * One tab in the dock. How "active" it looks is derived continuously from
 * the pager position (1 when its page is centred, 0 a page away), so the
 * label grows in, the icon crossfades to white and scales up — in step with
 * the pages and the capsule, live under the finger during a swipe.
 */
function DockTab({
  index,
  label,
  icon,
  focused,
  position,
  onAccent,
  inactiveColor,
  onPress,
}: {
  index: number;
  label: string;
  icon: IconName;
  focused: boolean;
  position: SharedValue<number>;
  onAccent: string;
  inactiveColor: string;
  onPress: () => void;
}) {
  // Natural label width, measured once from an invisible copy.
  const labelW = useSharedValue(0);
  const [measured, setMeasured] = useState<number | null>(null);

  // Each style reads `position` itself (not through a helper) so Reanimated
  // sees the dependency and re-runs it every frame of a swipe.
  const labelStyle = useAnimatedStyle(() => {
    const a = 1 - Math.min(1, Math.abs(position.get() - index));
    return {
      width: labelW.get() * a,
      marginLeft: LABEL_GAP * a,
      // Text arrives a beat after the width opens, and leaves first.
      opacity: interpolate(a, [0.35, 1], [0, 1], "clamp"),
      transform: [{ translateX: interpolate(a, [0, 1], [-6, 0]) }],
    };
  });
  const iconScale = useAnimatedStyle(() => {
    const a = 1 - Math.min(1, Math.abs(position.get() - index));
    return { transform: [{ scale: interpolate(a, [0, 1], [1, 1.08]) }] };
  });
  const whiteIcon = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.abs(position.get() - index)),
  }));
  const grayIcon = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.abs(position.get() - index)),
  }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      // Plain style object: NativeWind drops function styles when a
      // className is present, which collapsed the slots.
      style={{ width: SLOT, height: SLOT_H }}
      className="flex-row items-center justify-center active:opacity-75"
    >
      {/* Two stacked icons crossfade (tint colour itself can't animate). */}
      <Animated.View style={iconScale}>
        <Animated.View style={grayIcon}>
          <Icon name={icon} size={22} color={inactiveColor} />
        </Animated.View>
        <Animated.View className="absolute inset-0" style={whiteIcon}>
          <Icon name={icon} size={22} color={onAccent} />
        </Animated.View>
      </Animated.View>

      <Animated.View className="overflow-hidden" style={labelStyle}>
        {/* Fixed at its natural width: the container clips it while
            collapsing, so it slides away instead of truncating to "Ho…". */}
        <ThemedText
          numberOfLines={1}
          ellipsizeMode="clip"
          className="text-[15px] font-semibold"
          // A little slack over the measured width so it never wraps.
          style={{ color: onAccent, width: (measured ?? 196) + 4 }}
        >
          {label}
        </ThemedText>
      </Animated.View>

      {/* Invisible copy, only to measure the label's natural width. */}
      {measured == null && (
        <View className="absolute opacity-0" pointerEvents="none">
          <ThemedText
            className="text-[15px] font-semibold"
            onLayout={(e) => {
              const w = Math.ceil(e.nativeEvent.layout.width) + 4;
              labelW.set(w);
              setMeasured(w);
            }}
          >
            {label}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

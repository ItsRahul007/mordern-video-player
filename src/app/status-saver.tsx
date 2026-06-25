import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import { StatusTile } from "@/components/status-tile";
import { ThemedText } from "@/components/themed-text";
import { useSelection } from "@/hooks/use-selection";
import {
  hasAllFilesAccess,
  useAllFilesAccess,
} from "@/hooks/use-storage-permission";
import { useTheme } from "@/hooks/use-theme";
import { statusKeys, useStatuses } from "@/hooks/use-whatsapp-status";
import {
  saveStatus,
  type StatusFile,
  type StatusType,
} from "@/lib/whatsapp-status";

const COLUMNS = 3;
const GAP = 8;
const H_PADDING = 16; // matches px-4 on the list content
const SWIPE_THRESHOLD = 80;
const SWIPE_VELOCITY_THRESHOLD = 500;
const TAB_BAR_H_MARGIN = 16; // mx-4
const TAB_BAR_PADDING = 4; // p-1
const TAB_GAP = 8; // gap-2

// Animation configs
const SPRING_DAMPING = 50;
const SPRING_STIFFNESS = 200;
const TIMING_DURATION = 150;

const SPRING_CONFIG = { damping: SPRING_DAMPING, stiffness: SPRING_STIFFNESS };
const SPRING_BOUNCE_CONFIG = {
  damping: SPRING_DAMPING,
  stiffness: SPRING_STIFFNESS,
};

export default function StatusSaverScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const { openSettings } = useAllFilesAccess();
  const {
    data: statuses,
    isLoading,
    isRefetching,
    refetch,
  } = useStatuses(Platform.OS !== "web");
  const selection = useSelection();

  const { width } = useWindowDimensions();
  const tileSize = (width - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;

  const [tab, setTab] = useState<StatusType>("image");
  const [saving, setSaving] = useState(false);
  // Whether all-files access is granted (read from the OS, not inferred from a
  // listing). Drives whether an empty list offers a "grant access" button.
  const [hasAccess, setHasAccess] = useState<boolean>(hasAllFilesAccess);

  // --- Swipe gesture for tab switching ---
  const translateX = useSharedValue(0);
  // 0 = image, 1 = video — shared value so worklets can read it
  const tabIndex = useSharedValue(0);
  // Animated position for the tab indicator (0 → left, 1 → right)
  const indicatorProgress = useSharedValue(0);

  const switchTab = useCallback(
    (newTab: StatusType) => {
      setTab(newTab);
      selection.clear();
    },
    [selection],
  );

  // Keep tabIndex in sync when tab changes via press
  useEffect(() => {
    const idx = tab === "image" ? 0 : 1;
    tabIndex.value = idx;
    indicatorProgress.value = withTiming(idx, {
      duration: TIMING_DURATION,
    });
  }, [tab, tabIndex, indicatorProgress]);

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      // Subtle drag feedback — only 15% of finger movement
      const maxDrag = width * 0.15;
      translateX.value = Math.max(
        -maxDrag,
        Math.min(maxDrag, e.translationX * 0.15),
      );

      // Move the indicator proportionally during drag
      const dragRatio = (e.translationX * 0.15) / maxDrag; // -1 to 1
      const currentIdx = tabIndex.value;
      indicatorProgress.value = Math.max(
        0,
        Math.min(1, currentIdx - dragRatio * 0.5),
      );
    })
    .onEnd((e) => {
      const swipedFarEnough = Math.abs(e.translationX) > SWIPE_THRESHOLD;
      const fastEnough = Math.abs(e.velocityX) > SWIPE_VELOCITY_THRESHOLD;

      if (swipedFarEnough || fastEnough) {
        const swipedLeft = e.translationX < 0;

        if (swipedLeft && tabIndex.value === 0) {
          // image → video
          tabIndex.value = 1;
          indicatorProgress.value = withTiming(1, {
            duration: TIMING_DURATION,
          });
          translateX.value = withSpring(0, SPRING_CONFIG);
          runOnJS(switchTab)("video");
        } else if (!swipedLeft && tabIndex.value === 1) {
          // video → image
          tabIndex.value = 0;
          indicatorProgress.value = withTiming(0, {
            duration: TIMING_DURATION,
          });
          translateX.value = withSpring(0, SPRING_CONFIG);
          runOnJS(switchTab)("image");
        } else {
          // Already at edge, bounce back
          indicatorProgress.value = withTiming(tabIndex.value, {
            duration: TIMING_DURATION,
          });
          translateX.value = withSpring(0, SPRING_BOUNCE_CONFIG);
        }
      } else {
        // Didn't cross threshold — snap indicator and content back
        indicatorProgress.value = withTiming(tabIndex.value, {
          duration: TIMING_DURATION,
        });
        translateX.value = withSpring(0, SPRING_BOUNCE_CONFIG);
      }
    });

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  // Animated tab indicator style
  const tabBarInnerWidth = width - TAB_BAR_H_MARGIN * 2 - TAB_BAR_PADDING * 2;
  const pillWidth = (tabBarInnerWidth - TAB_GAP) / 2;

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          indicatorProgress.value,
          [0, 1],
          [0, pillWidth + TAB_GAP],
        ),
      },
    ],
  }));

  const visible = useMemo(
    () => (statuses ?? []).filter((s) => s.type === tab),
    [statuses, tab],
  );

  // Hardware back exits selection mode first (before leaving the screen).
  const { active: selectionActive, clear: clearSelection } = selection;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (selectionActive) {
          clearSelection();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [selectionActive, clearSelection]),
  );

  // Re-check access and re-list when the app returns to the foreground — e.g.
  // after granting all-files access in system settings (a separate activity).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setHasAccess(hasAllFilesAccess());
        void refetch();
      }
    });
    return () => sub.remove();
  }, [refetch]);

  const saveSelected = async () => {
    const targets = (statuses ?? []).filter((s) => selection.isSelected(s.uri));
    if (targets.length === 0) return;
    console.log(`[status] bulk save: ${targets.length} item(s)`);
    setSaving(true);
    let saved = 0;
    for (const status of targets) {
      try {
        await saveStatus(status);
        saved++;
      } catch (e) {
        console.warn(
          "[status] bulk save FAILED:",
          status.name,
          e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        );
      }
    }
    console.log(`[status] bulk save done: ${saved}/${targets.length}`);
    setSaving(false);
    selection.clear();
    Alert.alert(
      saved === targets.length ? "Saved" : "Partially saved",
      `Saved ${saved} of ${targets.length} to the "WhatsApp Status Saver" folder.`,
    );
  };

  const onTilePress = (status: StatusFile) => {
    if (selection.active) {
      selection.toggle(status.uri);
    } else {
      router.push({
        pathname: "/status-viewer",
        params: { uri: status.uri, type: status.type, name: status.name },
      });
    }
  };

  const header = selection.active ? (
    <View className="flex-row items-center gap-2 px-2 py-1">
      <Pressable
        onPress={selection.clear}
        hitSlop={10}
        className="p-2 active:opacity-70"
      >
        <Icon name="xmark" size={22} color={colors.text} />
      </Pressable>
      <ThemedText type="subtitle" className="flex-1">
        {selection.count} selected
      </ThemedText>
      <Pressable
        onPress={saveSelected}
        hitSlop={10}
        disabled={saving}
        className="p-2 active:opacity-70"
      >
        {saving ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <Icon name="save" size={24} color={colors.accent} />
        )}
      </Pressable>
    </View>
  ) : (
    <View className="flex-row items-center gap-2 px-2 py-1">
      <Pressable
        onPress={() => router.back()}
        hitSlop={10}
        className="p-2 active:opacity-70"
      >
        <Icon name="back" size={22} color={colors.text} />
      </Pressable>
      <ThemedText type="subtitle" className="flex-1">
        Status Saver
      </ThemedText>
    </View>
  );

  const tabBar = (
    <View className="mx-4 mb-3 mt-1 rounded-full bg-light-backgroundElement p-1 dark:bg-dark-backgroundElement">
      {/* Animated sliding indicator */}
      <Animated.View
        style={[
          {
            position: "absolute",
            top: TAB_BAR_PADDING,
            left: TAB_BAR_PADDING,
            width: pillWidth,
            height: "100%",
            borderRadius: 9999,
            backgroundColor: colors.accent,
          },
          indicatorStyle,
        ]}
      />
      <View className="flex-row gap-2">
        {(["image", "video"] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => {
              setTab(t);
              selection.clear();
            }}
            className="flex-1 items-center rounded-full py-2 active:opacity-80"
          >
            <ThemedText
              type="small"
              className={
                t === tab ? "font-semibold text-white" : "font-semibold"
              }
            >
              {t === "image" ? "Images" : "Videos"}
            </ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {header}
      {tabBar}
      <GestureDetector gesture={swipeGesture}>
        <Animated.View style={[{ flex: 1 }, contentAnimatedStyle]}>
          <FlatList
            data={visible}
            keyExtractor={(item) => item.uri}
            numColumns={COLUMNS}
            extraData={selection.selectedIds}
            columnWrapperStyle={{ gap: GAP }}
            contentContainerStyle={{
              gap: GAP,
              paddingHorizontal: H_PADDING,
              paddingBottom: 32,
            }}
            renderItem={({ item }) => (
              <StatusTile
                status={item}
                size={tileSize}
                selectionActive={selection.active}
                selected={selection.isSelected(item.uri)}
                onPress={() => onTilePress(item)}
                onLongPress={() => selection.toggle(item.uri)}
              />
            )}
            refreshControl={
              <RefreshControl
                refreshing={isRefetching}
                onRefresh={() =>
                  queryClient.invalidateQueries({
                    queryKey: statusKeys.statuses,
                  })
                }
                tintColor={colors.textSecondary}
              />
            }
            ListEmptyComponent={
              isLoading ? (
                <View className="mt-24 items-center">
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              ) : hasAccess ? (
                // Access is granted — there simply are no statuses of this type.
                <View className="mt-24 items-center gap-3 px-8">
                  <Icon name="status" size={48} color={colors.textSecondary} />
                  <ThemedText type="muted" className="text-center">
                    No recent {tab === "image" ? "photo" : "video"} statuses
                    found. Open a status in WhatsApp first, then pull to
                    refresh.
                  </ThemedText>
                </View>
              ) : (
                // Can't read the hidden .Statuses folder without all-files access.
                <View className="mt-24 items-center gap-4 px-8">
                  <Icon name="lock" size={48} color={colors.textSecondary} />
                  <ThemedText type="muted" className="text-center">
                    Grant access to all files to see WhatsApp statuses you've
                    viewed.
                  </ThemedText>
                  <Pressable
                    onPress={openSettings}
                    style={{ backgroundColor: colors.accent }}
                    className="mt-1 rounded-full px-6 py-3 active:opacity-80"
                  >
                    <ThemedText className="font-semibold text-white">
                      Grant access
                    </ThemedText>
                  </Pressable>
                </View>
              )
            }
          />
        </Animated.View>
      </GestureDetector>
      {saving && !selection.active && (
        <View className="absolute inset-0 items-center justify-center bg-black/40">
          <ActivityIndicator color="#ffffff" size="large" />
        </View>
      )}
    </SafeAreaView>
  );
}

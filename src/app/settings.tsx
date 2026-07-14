import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import { OpenStats } from "@/components/open-stats";
import { SortOptionsList } from "@/components/sort-options-list";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { getDeviceId } from "@/lib/open-tracker";
import { useSort } from "@/providers/sort-provider";
import type { ThemePreference } from "@/providers/theme-provider";

const OPTIONS: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "settings" },
  { value: "light", label: "Light", icon: "light" },
  { value: "dark", label: "Dark", icon: "dark" },
];

/** Date-range presets for the app-open stats. `null` means all-time. */
const RANGE_OPTIONS: { value: number | null; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: null, label: "All" },
];

/**
 * Hidden gesture: re-tapping the already-selected "7 days" range this many
 * times in a row unlocks the all-devices view (every install's opens instead of
 * just this one). Once unlocked it stays active across all ranges for the
 * session.
 */
const SECRET_RANGE = 7;
const SECRET_TAPS = 4;

export default function SettingsScreen() {
  const router = useRouter();
  const { preference, setPreference, colors } = useTheme();
  const { sort, setSort } = useSort();
  const [rangeDays, setRangeDays] = useState<number | null>(7);
  // Stable per-install id; `null` until it resolves. Used to scope open stats
  // to this device only, unless the hidden all-devices view is unlocked.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [allDevices, setAllDevices] = useState(false);
  // Consecutive taps on the already-active "7 days" chip (see SECRET_TAPS).
  const [secretTaps, setSecretTaps] = useState(0);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  const selectRange = (value: number | null) => {
    // Re-tapping the currently active range doesn't change the selection, but
    // repeated taps on "7 days" arm the hidden all-devices view.
    if (value === rangeDays) {
      if (value === SECRET_RANGE) {
        const taps = secretTaps + 1;
        setSecretTaps(taps);
        if (taps >= SECRET_TAPS) setAllDevices(true);
      }
      return;
    }
    setRangeDays(value);
    setSecretTaps(0);
    // Once unlocked, the all-devices view stays active across every range for
    // the rest of the session — switching ranges no longer re-locks it.
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {/* Custom header with back button */}
      <View className="flex-row items-center gap-2 px-2 py-1">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="p-2 active:opacity-70"
        >
          <Icon name="back" size={22} color={colors.text} />
        </Pressable>
        <ThemedText type="subtitle" className="flex-1">
          Settings
        </ThemedText>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
      <View className="mt-4 px-4">
        <ThemedText type="muted" className="mb-2 px-1 uppercase">
          Appearance
        </ThemedText>
        <View className="flex-row gap-2 rounded-2xl bg-surface p-1.5">
          {OPTIONS.map((option) => {
            const active = preference === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => setPreference(option.value)}
                className={`flex-1 items-center gap-1.5 rounded-xl py-3 active:opacity-80 ${
                  active ? "bg-blue-500" : ""
                }`}
              >
                <Icon
                  name={option.icon}
                  size={22}
                  color={active ? "#ffffff" : colors.textSecondary}
                />
                <ThemedText
                  type="smallBold"
                  className={active ? "text-white" : "text-muted"}
                >
                  {option.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="mt-8 px-4">
        <ThemedText type="muted" className="mb-2 px-1 uppercase">
          Sort videos by
        </ThemedText>
        <SortOptionsList value={sort} onChange={setSort} />
      </View>

      <View className="mt-8 px-4">
        <ThemedText type="muted" className="mb-2 px-1 uppercase">
          About
        </ThemedText>
        <View className="rounded-2xl bg-surface px-4 py-3">
          <View className="flex-row items-center justify-between py-1">
            <ThemedText>App</ThemedText>
            <ThemedText type="muted">Modern Video Player</ThemedText>
          </View>
          <View className="flex-row items-center justify-between py-1">
            <ThemedText>Version</ThemedText>
            <ThemedText type="muted">{Constants.expoConfig?.version}</ThemedText>
          </View>
        </View>
      </View>

      <View className="mt-8 px-4">
        <ThemedText type="muted" className="mb-2 px-1 uppercase">
          App opens
        </ThemedText>
        <View className="mb-3 flex-row gap-2 rounded-2xl bg-surface p-1.5">
          {RANGE_OPTIONS.map((option) => {
            const active = rangeDays === option.value;
            return (
              <Pressable
                key={option.label}
                onPress={() => selectRange(option.value)}
                className={`flex-1 items-center rounded-xl py-2.5 active:opacity-80 ${
                  active ? "bg-blue-500" : ""
                }`}
              >
                <ThemedText
                  type="smallBold"
                  className={active ? "text-white" : "text-muted"}
                >
                  {option.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
        {allDevices && (
          <ThemedText type="muted" className="mb-2 px-1">
            Showing all devices
          </ThemedText>
        )}
        <OpenStats
          rangeDays={rangeDays}
          deviceId={allDevices ? undefined : deviceId}
        />
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import { OpenStats } from "@/components/open-stats";
import { SortOptionsList } from "@/components/sort-options-list";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
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

export default function SettingsScreen() {
  const router = useRouter();
  const { preference, setPreference, colors } = useTheme();
  const { sort, setSort } = useSort();
  const [rangeDays, setRangeDays] = useState<number | null>(7);

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
                onPress={() => setRangeDays(option.value)}
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
        <OpenStats rangeDays={rangeDays} />
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

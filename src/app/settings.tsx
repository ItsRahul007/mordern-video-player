import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
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

export default function SettingsScreen() {
  const router = useRouter();
  const { preference, setPreference, colors } = useTheme();
  const { sort, setSort } = useSort();

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
      </ScrollView>
    </SafeAreaView>
  );
}

import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { type DailyOpens, useAppOpens } from "@/hooks/use-app-opens";
import { useTheme } from "@/hooks/use-theme";

/** How many recent days to render as bars in the chart. */
const CHART_DAYS = 14;
/** Pixel height of the tallest bar. */
const MAX_BAR_HEIGHT = 120;

/**
 * App-open usage: a bar chart of opens per day plus a per-day breakdown that
 * expands to reveal the exact times. Data comes from the `open-count` table in
 * Supabase (see `useAppOpens`).
 */
export function OpenStats() {
  const { colors } = useTheme();
  const { days, total, isLoading, isError, refetch } = useAppOpens();

  if (isLoading) {
    return (
      <View className="items-center rounded-2xl bg-surface py-8">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (isError) {
    return (
      <Pressable
        onPress={() => refetch()}
        className="items-center rounded-2xl bg-surface py-8 active:opacity-70"
      >
        <ThemedText type="muted">Couldn&apos;t load usage. Tap to retry.</ThemedText>
      </Pressable>
    );
  }

  if (days.length === 0) {
    return (
      <View className="items-center rounded-2xl bg-surface py-8">
        <ThemedText type="muted">No opens recorded yet.</ThemedText>
      </View>
    );
  }

  // Oldest → newest, capped to the most recent CHART_DAYS for the bar chart.
  const chartDays = days.slice(0, CHART_DAYS).reverse();
  const maxCount = Math.max(...chartDays.map((d) => d.count), 1);

  return (
    <View className="rounded-2xl bg-surface p-4">
      <View className="mb-4 flex-row items-baseline justify-between">
        <ThemedText type="smallBold">Total opens</ThemedText>
        <ThemedText type="subtitle">{total}</ThemedText>
      </View>

      {/* Bar chart */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingBottom: 4 }}
      >
        {chartDays.map((day) => (
          <View key={day.date} className="items-center" style={{ width: 34 }}>
            <ThemedText type="muted" className="mb-1 text-xs">
              {day.count}
            </ThemedText>
            <View
              className="justify-end"
              style={{ height: MAX_BAR_HEIGHT }}
            >
              <View
                style={{
                  height: Math.max(
                    4,
                    (day.count / maxCount) * MAX_BAR_HEIGHT,
                  ),
                  backgroundColor: colors.accent,
                  borderRadius: 6,
                  width: 22,
                }}
              />
            </View>
            <ThemedText type="muted" className="mt-1 text-xs">
              {day.label}
            </ThemedText>
          </View>
        ))}
      </ScrollView>

      {/* Per-day breakdown with expandable times */}
      <View
        className="mt-4 pt-2"
        style={{ borderTopWidth: 1, borderTopColor: colors.backgroundSelected }}
      >
        {days.map((day) => (
          <DayRow key={day.date} day={day} accent={colors.accent} />
        ))}
      </View>
    </View>
  );
}

function DayRow({ day, accent }: { day: DailyOpens; accent: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        className="flex-row items-center justify-between py-2.5 active:opacity-70"
      >
        <View className="flex-row items-center gap-2">
          <Icon name={expanded ? "close" : "chevronRight"} size={16} color={accent} />
          <ThemedText type="small">{day.label}</ThemedText>
        </View>
        <ThemedText type="muted">
          {day.count} {day.count === 1 ? "open" : "opens"}
        </ThemedText>
      </Pressable>

      {expanded && (
        <View className="flex-row flex-wrap gap-2 pb-3 pl-6">
          {day.times.map((time, i) => (
            <View
              key={`${day.date}-${i}`}
              className="rounded-md bg-background px-2 py-1"
            >
              <ThemedText type="muted" className="text-xs">
                {time}
              </ThemedText>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

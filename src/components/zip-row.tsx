import { ActivityIndicator, Pressable, View } from "react-native";

import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import type { ZipFile } from "@/lib/archives";
import { formatBytes } from "@/lib/format";

type ZipRowProps = {
  zip: ZipFile;
  onPress: () => void;
  onLongPress?: () => void;
  selectionActive?: boolean;
  selected?: boolean;
  /** 0–1 extraction progress while this archive is being extracted; null otherwise. */
  progress?: number | null;
};

export function ZipRow({
  zip,
  onPress,
  onLongPress,
  selectionActive = false,
  selected = false,
  progress = null,
}: ZipRowProps) {
  const { colors } = useTheme();
  const extracting = progress !== null;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      disabled={extracting}
      className={`flex-row items-center gap-3 rounded-2xl p-2.5 active:opacity-80 ${
        selected
          ? "bg-light-backgroundSelected dark:bg-dark-backgroundSelected"
          : "bg-light-backgroundElement dark:bg-dark-backgroundElement"
      }`}
    >
      <View className="h-14 w-14 items-center justify-center rounded-xl bg-light-backgroundSelected dark:bg-dark-backgroundSelected">
        <Icon name="archive" size={26} color={colors.textSecondary} />
      </View>
      <View className="flex-1">
        <ThemedText type="small" numberOfLines={2} className="font-semibold">
          {zip.name}
        </ThemedText>
        <ThemedText type="muted" className="mt-0.5">
          {extracting
            ? `Extracting… ${Math.round((progress ?? 0) * 100)}%`
            : formatBytes(zip.size)}
        </ThemedText>
      </View>
      {extracting ? (
        <ActivityIndicator color={colors.accent} />
      ) : selectionActive ? (
        <View
          className="h-6 w-6 items-center justify-center rounded-full border-2"
          style={{
            borderColor: selected ? colors.accent : colors.textSecondary,
            backgroundColor: selected ? colors.accent : "transparent",
          }}
        >
          {selected && <Icon name="check" size={14} color="#ffffff" />}
        </View>
      ) : null}
    </Pressable>
  );
}

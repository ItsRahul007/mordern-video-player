import { Modal, Pressable, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

/** App destructive red (matches the trash actions elsewhere). */
const DESTRUCTIVE = "#ef4444";

type ConfirmSheetProps = {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A themed bottom-sheet confirmation dialog — a nicer replacement for the
 * system `Alert`. Matches the sort sheet's look (grabber + rounded top sheet).
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <Pressable className="flex-1 justify-end bg-black/50" onPress={onCancel}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-3xl bg-light-background dark:bg-dark-background px-5 pb-10 pt-3"
        >
          <View className="mb-4 items-center">
            <View className="h-1 w-10 rounded-full bg-light-backgroundSelected dark:bg-dark-backgroundSelected" />
          </View>

          <ThemedText type="subtitle" className="mb-2">
            {title}
          </ThemedText>
          {message ? (
            <ThemedText type="muted" className="mb-5">
              {message}
            </ThemedText>
          ) : (
            <View className="mb-2" />
          )}

          <View className="gap-2.5">
            <Pressable
              onPress={onConfirm}
              style={{ backgroundColor: destructive ? DESTRUCTIVE : colors.accent }}
              className="items-center rounded-2xl py-3.5 active:opacity-80"
            >
              <ThemedText className="font-semibold text-white">
                {confirmLabel}
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={onCancel}
              className="items-center rounded-2xl bg-light-backgroundElement py-3.5 active:opacity-80 dark:bg-dark-backgroundElement"
            >
              <ThemedText className="font-semibold">{cancelLabel}</ThemedText>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

import { Modal, Pressable, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

type MessageSheetProps = {
  visible: boolean;
  title: string;
  message?: string;
  buttonLabel?: string;
  onClose: () => void;
};

/**
 * A themed bottom-sheet for a single informational/error message — a nicer
 * replacement for the system `Alert`. Same look as {@link ConfirmSheet} but with
 * a single dismiss button.
 */
export function MessageSheet({
  visible,
  title,
  message,
  buttonLabel = "OK",
  onClose,
}: MessageSheetProps) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-3xl bg-light-background px-5 pb-10 pt-3 dark:bg-dark-background"
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

          <Pressable
            onPress={onClose}
            style={{ backgroundColor: colors.accent }}
            className="items-center rounded-2xl py-3.5 active:opacity-80"
          >
            <ThemedText className="font-semibold text-white">
              {buttonLabel}
            </ThemedText>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

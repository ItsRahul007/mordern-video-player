import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { Icon } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { ZipRow } from "@/components/zip-row";
import { archiveKeys, useZipFiles } from "@/hooks/use-archives";
import { useSelection } from "@/hooks/use-selection";
import { useAllFilesAccess } from "@/hooks/use-storage-permission";
import { useTheme } from "@/hooks/use-theme";
import {
  deleteZip,
  downloadsReadable,
  extractZip,
  type ZipFile,
} from "@/lib/archives";

/** Which confirmation sheet is currently open (none when null). */
type Dialog =
  | { type: "extract"; zip: ZipFile }
  | { type: "postDelete"; zip: ZipFile }
  | { type: "bulkDelete" };

export default function ArchivesScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const { openSettings } = useAllFilesAccess();
  const {
    data: zips,
    isLoading,
    isRefetching,
    refetch,
  } = useZipFiles(Platform.OS === "android");
  const selection = useSelection();

  // Per-archive extraction progress (0–1), keyed by URI.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Whether Downloads is readable (proxy for all-files access). Drives whether
  // an empty list offers a "grant access" button or just says "no zips".
  const [readable, setReadable] = useState<boolean>(() =>
    Platform.OS === "android" ? downloadsReadable() : false,
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

  const refreshList = () =>
    queryClient.invalidateQueries({ queryKey: archiveKeys.zips });

  // Re-list when the app returns to the foreground — e.g. after the user grants
  // all-files access in system settings (which runs in a separate activity).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setReadable(downloadsReadable());
        void refetch();
      }
    });
    return () => sub.remove();
  }, [refetch]);

  const runExtraction = async (zip: ZipFile) => {
    setProgress((p) => ({ ...p, [zip.uri]: 0 }));
    try {
      console.warn("[archives] extract start:", zip.name);
      const dest = await extractZip(zip, (fraction) => {
        setProgress((p) => ({ ...p, [zip.uri]: fraction }));
      });
      console.warn("[archives] extract OK ->", dest);
      // Offer to remove the archive now that it's been extracted.
      setDialog({ type: "postDelete", zip });
    } catch (e) {
      console.warn(
        "[archives] extract FAILED:",
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      );
      setDialog(null);
      Alert.alert("Extraction failed", `Could not extract “${zip.name}”.`);
    } finally {
      setProgress((p) => {
        const next = { ...p };
        delete next[zip.uri];
        return next;
      });
    }
  };

  const bulkDelete = async () => {
    const targets = (zips ?? []).filter((z) => selection.isSelected(z.uri));
    await Promise.all(
      targets.map((z) =>
        deleteZip(z).catch((e) =>
          console.warn(
            "[archives] bulk delete FAILED:",
            z.name,
            e instanceof Error ? e.message : String(e),
          ),
        ),
      ),
    );
    selection.clear();
    void refreshList();
  };

  const onZipPress = (zip: ZipFile) => {
    if (selection.active) selection.toggle(zip.uri);
    else setDialog({ type: "extract", zip });
  };

  // Build the props for the currently-open confirmation sheet.
  const sheet = (() => {
    if (!dialog) return null;
    const close = () => setDialog(null);
    switch (dialog.type) {
      case "extract": {
        const { zip } = dialog;
        return {
          title: "Extract archive",
          message: `Extract “${zip.name}”?`,
          confirmLabel: "Extract",
          cancelLabel: "Cancel",
          destructive: false,
          onConfirm: () => {
            close();
            void runExtraction(zip);
          },
          onCancel: close,
        };
      }
      case "postDelete": {
        const { zip } = dialog;
        return {
          title: "Extraction complete",
          message: `“${zip.name}” was extracted to a new folder. Delete the zip file?`,
          confirmLabel: "Delete",
          cancelLabel: "Keep",
          destructive: true,
          onConfirm: async () => {
            close();
            try {
              await deleteZip(zip);
              console.warn("[archives] delete OK:", zip.name);
            } catch (e) {
              console.warn(
                "[archives] delete FAILED:",
                e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              );
            }
            void refreshList();
          },
          onCancel: close,
        };
      }
      case "bulkDelete": {
        const n = selection.count;
        return {
          title: `Delete ${n} zip file${n === 1 ? "" : "s"}?`,
          message:
            "This permanently deletes the selected .zip files from Downloads.",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          destructive: true,
          onConfirm: () => {
            close();
            void bulkDelete();
          },
          onCancel: close,
        };
      }
    }
  })();

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
        onPress={() => setDialog({ type: "bulkDelete" })}
        hitSlop={10}
        className="p-2 active:opacity-70"
      >
        <Icon name="trash" size={22} color="#ef4444" />
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
        Zip Files
      </ThemedText>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {header}
      <FlatList
        data={zips}
        keyExtractor={(item) => item.uri}
        extraData={[progress, selection.selectedIds]}
        contentContainerClassName="gap-2.5 px-4 pb-8 pt-1"
        renderItem={({ item }) => (
          <ZipRow
            zip={item}
            progress={progress[item.uri] ?? null}
            selectionActive={selection.active}
            selected={selection.isSelected(item.uri)}
            onPress={() => onZipPress(item)}
            onLongPress={() => selection.toggle(item.uri)}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? (
            <View className="mt-24 items-center">
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : readable ? (
            // Access is granted — the folder simply has no zips.
            <View className="mt-24 items-center gap-3 px-8">
              <Icon name="archive" size={48} color={colors.textSecondary} />
              <ThemedText type="muted" className="text-center">
                No zip files found in your Downloads folder.
              </ThemedText>
            </View>
          ) : (
            // Can't read Downloads — all-files access hasn't been granted yet
            // (a non-media .zip is invisible without it).
            <View className="mt-24 items-center gap-4 px-8">
              <Icon name="lock" size={48} color={colors.textSecondary} />
              <ThemedText type="muted" className="text-center">
                Grant access to all files to see zip files in your Downloads
                folder.
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

      <ConfirmSheet
        visible={sheet !== null}
        title={sheet?.title ?? ""}
        message={sheet?.message}
        confirmLabel={sheet?.confirmLabel ?? ""}
        cancelLabel={sheet?.cancelLabel}
        destructive={sheet?.destructive}
        onConfirm={sheet?.onConfirm ?? (() => {})}
        onCancel={sheet?.onCancel ?? (() => setDialog(null))}
      />
    </SafeAreaView>
  );
}

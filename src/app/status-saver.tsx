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
import { saveStatus, type StatusFile, type StatusType } from "@/lib/whatsapp-status";

const COLUMNS = 3;
const GAP = 8;
const H_PADDING = 16; // matches px-4 on the list content

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
      `Saved ${saved} of ${targets.length} to the “WhatsApp Status Saver” folder.`,
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
    <View className="mx-4 mb-3 mt-1 flex-row gap-2 rounded-full bg-light-backgroundElement p-1 dark:bg-dark-backgroundElement">
      {(["image", "video"] as const).map((t) => (
        <Pressable
          key={t}
          onPress={() => {
            setTab(t);
            selection.clear();
          }}
          style={t === tab ? { backgroundColor: colors.accent } : undefined}
          className="flex-1 items-center rounded-full py-2 active:opacity-80"
        >
          <ThemedText
            type="small"
            className={t === tab ? "font-semibold text-white" : "font-semibold"}
          >
            {t === "image" ? "Images" : "Videos"}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {header}
      {tabBar}
      <FlatList
        data={visible}
        keyExtractor={(item) => item.uri}
        numColumns={COLUMNS}
        extraData={selection.selectedIds}
        columnWrapperStyle={{ gap: GAP }}
        contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING, paddingBottom: 32 }}
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
              queryClient.invalidateQueries({ queryKey: statusKeys.statuses })
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
                No recent {tab === "image" ? "photo" : "video"} statuses found.
                Open a status in WhatsApp first, then pull to refresh.
              </ThemedText>
            </View>
          ) : (
            // Can't read the hidden .Statuses folder without all-files access.
            <View className="mt-24 items-center gap-4 px-8">
              <Icon name="lock" size={48} color={colors.textSecondary} />
              <ThemedText type="muted" className="text-center">
                Grant access to all files to see WhatsApp statuses you’ve viewed.
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
      {saving && !selection.active && (
        <View className="absolute inset-0 items-center justify-center bg-black/40">
          <ActivityIndicator color="#ffffff" size="large" />
        </View>
      )}
    </SafeAreaView>
  );
}

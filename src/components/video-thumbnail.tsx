import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";

import { Icon } from "@/components/icon";

// Deterministic gradient per key so placeholders look lively before/without a frame.
const GRADIENTS: [string, string][] = [
  ["#6366f1", "#8b5cf6"],
  ["#0ea5e9", "#2563eb"],
  ["#ec4899", "#f43f5e"],
  ["#10b981", "#0d9488"],
  ["#f59e0b", "#ef4444"],
  ["#8b5cf6", "#d946ef"],
];

function gradientFor(key: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < key.length; i++)
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

type VideoThumbnailProps = {
  /** Video URI to generate a still frame from. */
  uri: string | null | undefined;
  /** Stable key (e.g. asset/album id) for the fallback gradient. */
  seed: string;
};

export function VideoThumbnail({ uri, seed }: VideoThumbnailProps) {
  const colors = gradientFor(seed);

  return (
    <View className="h-full w-full items-center justify-center">
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {uri ? (
        <Image
          source={uri}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <Icon name="play" size={30} color="rgba(255,255,255,0.95)" />
      )}
    </View>
  );
}

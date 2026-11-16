import { Tabs } from "expo-router";

import { AppTabBar } from "@/components/gallery/tab-bar";

/**
 * Root bottom navigation: Home (video folders) and Gallery (all images +
 * videos). Uses expo-router's bundled JS tabs with a custom bar — no native
 * dependency, and it plays well with the FlatLists both tabs are built on.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false, animation: "fade" }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="gallery" options={{ title: "Gallery" }} />
    </Tabs>
  );
}

import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { View } from "react-native";

import { AppTabBar } from "@/components/gallery/tab-bar";
import { PAGER_TABS, TabPagerProvider, renderPagerPage } from "@/components/gallery/tab-pager";

/**
 * Root bottom navigation: Home (video folders) and Gallery (all images +
 * videos), built on expo-router's headless tabs so the screens can be laid
 * out side by side as pages. Swiping moves both together (see TabSwipe),
 * and the floating dock's capsule follows the same pager position.
 */
export default function TabsLayout() {
  return (
    <TabPagerProvider>
      <View style={{ flex: 1 }}>
        <Tabs style={{ flex: 1 }}>
          <TabSlot renderFn={renderPagerPage} detachInactiveScreens={false} />
          {/* Declares the tab routes; the visible bar is the dock below. */}
          <TabList style={{ display: "none" }}>
            {PAGER_TABS.map((tab) => (
              <TabTrigger key={tab.name} name={tab.name} href={tab.href} />
            ))}
          </TabList>
        </Tabs>
        <AppTabBar />
      </View>
    </TabPagerProvider>
  );
}

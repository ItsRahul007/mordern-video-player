import type { ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { PAGER_TABS, settlePager, useTabPager } from "@/components/gallery/tab-pager";

const LAST = PAGER_TABS.length - 1;
/** Release past this fraction of a page… */
const DISTANCE = 0.35;
/** …or flick faster than this (dp/s) to change tabs. */
const VELOCITY = 600;

/**
 * Swipe horizontally to move between tabs like pages: both screens slide
 * together under the finger, and on release the pager springs to the
 * nearest page (or the one flicked towards). Only a clearly horizontal,
 * one-finger swipe activates it — vertical scrolling, pinch and
 * long-press-drag selection inside keep working.
 */
export function TabSwipe({ children }: { children: ReactNode }) {
  const { position, settling, width, goTo } = useTabPager();
  const base = useSharedValue(0);

  const pan = Gesture.Pan()
    .maxPointers(1)
    .activeOffsetX([-20, 20])
    .failOffsetY([-14, 14])
    .onStart(() => {
      base.set(Math.round(position.get()));
    })
    .onUpdate((e) => {
      const p = base.get() - e.translationX / width;
      // A little resistance past the first/last page.
      const clamped = p < 0 ? p * 0.25 : p > LAST ? LAST + (p - LAST) * 0.25 : p;
      position.set(clamped);
    })
    .onEnd((e, success) => {
      // onEnd also fires when an active swipe is cancelled (not released);
      // that's handled in onFinalize — never navigate on a cancel, or the
      // route and the pages would disagree.
      if (!success) return;
      const from = base.get();
      const moved = from - position.get(); // pages moved towards the left tab
      let target = from;
      if (e.velocityX < -VELOCITY || moved < -DISTANCE) target = from + 1;
      else if (e.velocityX > VELOCITY || moved > DISTANCE) target = from - 1;
      target = Math.max(0, Math.min(LAST, target));
      if (target !== from) settling.set(target);
      position.set(settlePager(position.get(), target));
      if (target !== from) scheduleOnRN(goTo, target);
    })
    .onFinalize((_e, success) => {
      // Cancelled mid-drag (e.g. another gesture won): settle where we were.
      if (!success) position.set(settlePager(position.get(), base.get()));
    });

  return (
    <GestureDetector gesture={pan}>
      {/* A real native view for the detector to attach to. */}
      <View collapsable={false} style={{ flex: 1 }}>
        {children}
      </View>
    </GestureDetector>
  );
}

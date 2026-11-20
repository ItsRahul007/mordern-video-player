import { usePathname, useRouter } from "expo-router";
import type { TabsDescriptor, TabsSlotRenderOptions } from "expo-router/ui";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  Easing,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/** Tabs in pager order (left → right). */
export const PAGER_TABS = [
  { name: "index", href: "/", label: "Home" },
  { name: "gallery", href: "/gallery", label: "Gallery" },
] as const;
const LAST = PAGER_TABS.length - 1;

/** Mount the other tabs this long after start-up, so they're ready to slide in. */
const WARM_DELAY_MS = 1500;
/**
 * Animate the pager to `target` with an eased-out glide. Duration scales with
 * the distance left (a full page ≈ 420 ms, a nearly finished swipe ≈ 300 ms)
 * and ignores flick speed, so a quick flick doesn't end in a blink.
 */
export function settlePager(from: number, target: number) {
  "worklet";
  const remaining = Math.min(1, Math.abs(target - from));
  return withTiming(target, {
    duration: 300 + 120 * remaining,
    easing: Easing.out(Easing.cubic),
  });
}

type PagerContextValue = {
  /** Pager position in pages (0 = Home, 1 = Gallery); fractional mid-swipe. */
  position: SharedValue<number>;
  /** Page the gesture is settling on (-1 when idle) — stops a double animation. */
  settling: SharedValue<number>;
  /** Focused tab index (from the route). */
  index: number;
  width: number;
  /** Mount every tab, even ones never opened (set shortly after start-up). */
  warm: boolean;
  goTo: (index: number) => void;
};

const PagerContext = createContext<PagerContextValue | null>(null);

export function useTabPager(): PagerContextValue {
  const ctx = use(PagerContext);
  if (!ctx) throw new Error("useTabPager must be used inside TabPagerProvider");
  return ctx;
}

function indexFor(pathname: string): number {
  return pathname.startsWith("/gallery") ? 1 : 0;
}

/**
 * Shared state for the swipeable tabs: one pager position that the pages,
 * the swipe gesture and the dock's capsule all follow.
 */
export function TabPagerProvider({ children }: PropsWithChildren) {
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const index = indexFor(pathname);

  const position = useSharedValue(index);
  const settling = useSharedValue(-1);

  // Route changed (dock tap, swipe, deep link): glide to that page — unless
  // a swipe is already springing there.
  useEffect(() => {
    if (settling.get() === index) {
      settling.set(-1);
      return;
    }
    position.set(settlePager(position.get(), index));
  }, [index, position, settling]);

  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWarm(true), WARM_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const goTo = useCallback(
    (i: number) => {
      const tab = PAGER_TABS[Math.max(0, Math.min(LAST, i))];
      router.navigate(tab.href);
    },
    [router],
  );

  const value = useMemo(
    () => ({ position, settling, index, width, warm, goTo }),
    [position, settling, index, width, warm, goTo],
  );
  return <PagerContext value={value}>{children}</PagerContext>;
}

/** One full-width page, offset by its distance from the pager position. */
function PagerPage({ index, children }: PropsWithChildren<{ index: number }>) {
  const { position, width } = useTabPager();
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (index - position.get()) * width }],
  }));
  return <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>;
}

/** Mounts a page once it's been opened, is focused, or the pager is warm. */
function PagerSlotPage({
  descriptor,
  index,
  isFocused,
  loaded,
}: {
  descriptor: TabsDescriptor;
  index: number;
  isFocused: boolean;
  loaded: boolean;
}) {
  const { warm } = useTabPager();
  if (!isFocused && !loaded && !warm) return null;
  return <PagerPage index={index}>{descriptor.render()}</PagerPage>;
}

/** `renderFn` for `<TabSlot>`: every tab side by side instead of one at a time. */
export function renderPagerPage(
  descriptor: TabsDescriptor,
  { index, isFocused, loaded }: TabsSlotRenderOptions,
) {
  return (
    <PagerSlotPage
      descriptor={descriptor}
      index={index}
      isFocused={isFocused}
      loaded={loaded}
    />
  );
}

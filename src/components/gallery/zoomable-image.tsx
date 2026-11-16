import { Image } from "expo-image";
import { useCallback, useState } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;
const SPRING = { damping: 20, stiffness: 220 };
/** Focal-point movement in one event that can only mean a finger lifted (dp). */
const FOCAL_JUMP = 48;

type ZoomableImageProps = {
  uri: string;
  recyclingKey: string;
  width: number;
  height: number;
  /** Reports zoomed-in state so the pager can lock horizontal swiping. */
  onZoomChange: (zoomed: boolean) => void;
  onSingleTap: () => void;
};

/**
 * Full-screen photo with pinch-to-zoom (around the pinch point), pan while
 * zoomed, and double-tap to zoom in / reset. Same approach as the player's
 * video pinch (shared values + RNGH gestures on the UI thread), extended with
 * focal-point zoom and panning, which photos need.
 *
 * Zoom resets when the parent remounts it (the viewer keys it on whether its
 * page is the current one).
 */
export function ZoomableImage({
  uri,
  recyclingKey,
  width,
  height,
  onZoomChange,
  onSingleTap,
}: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startTx = useSharedValue(0);
  const startTy = useSharedValue(0);
  // Pinch gesture's own scale at the (last) anchor point.
  const startPinch = useSharedValue(1);
  const startFocalX = useSharedValue(0);
  const startFocalY = useSharedValue(0);

  // Mirrors "scale > 1" on the JS side: enables the pan gesture and tells
  // the pager to lock swiping.
  const [zoomed, setZoomed] = useState(false);
  const reportZoom = useCallback(
    (value: boolean) => {
      setZoomed(value);
      onZoomChange(value);
    },
    [onZoomChange],
  );
  useAnimatedReaction(
    () => scale.value > 1.01,
    (isZoomed, prev) => {
      if (isZoomed !== prev) scheduleOnRN(reportZoom, isZoomed);
    },
  );

  // Size of the photo as displayed at 1x ("contain" inside the screen).
  // Defaults to the full screen until the image reports its pixel size.
  const contentW = useSharedValue(width);
  const contentH = useSharedValue(height);
  const pinching = useSharedValue(false);
  // Set once a pinch starts in the current touch; cleared when a new touch
  // begins with a single finger.
  const pinchedThisTouch = useSharedValue(false);
  const lastFocalX = useSharedValue(0);
  const lastFocalY = useSharedValue(0);

  /**
   * Translation limit on one axis at scale `s`. When the photo is bigger than
   * the screen its edges may not come inside the screen; when it's smaller it
   * may move anywhere as long as it stays fully visible. Either way it is
   * never forced back to the centre.
   */
  const limit = (content: number, viewport: number, s: number) => {
    "worklet";
    return Math.abs(content * s - viewport) / 2;
  };
  const clampX = (x: number, s: number) => {
    "worklet";
    const max = limit(contentW.value, width, s);
    return Math.min(max, Math.max(-max, x));
  };
  const clampY = (y: number, s: number) => {
    "worklet";
    const max = limit(contentH.value, height, s);
    return Math.min(max, Math.max(-max, y));
  };

  const pinch = Gesture.Pinch()
    .onTouchesDown((e) => {
      // A new touch starting with one finger: a fresh gesture, drag allowed.
      if (e.numberOfTouches <= 1) pinchedThisTouch.value = false;
    })
    .onStart((e) => {
      pinching.value = true;
      pinchedThisTouch.value = true;
      startScale.value = scale.value;
      startPinch.value = e.scale;
      startTx.value = tx.value;
      startTy.value = ty.value;
      // Focal point relative to the screen centre.
      startFocalX.value = e.focalX - width / 2;
      startFocalY.value = e.focalY - height / 2;
      lastFocalX.value = startFocalX.value;
      lastFocalY.value = startFocalY.value;
    })
    .onUpdate((e) => {
      if (e.numberOfPointers < 2) return;
      const fx = e.focalX - width / 2;
      const fy = e.focalY - height / 2;
      // When one finger lifts, Android recomputes the focal point without it
      // in that same event (still reporting two pointers), so the focal point
      // jumps to the remaining finger. Real fingers can't move that far in one
      // frame — treat it as a re-grip and re-anchor at the current state so
      // the photo stays exactly where it is.
      if (Math.hypot(fx - lastFocalX.value, fy - lastFocalY.value) > FOCAL_JUMP) {
        startScale.value = scale.value;
        startPinch.value = e.scale;
        startTx.value = tx.value;
        startTy.value = ty.value;
        startFocalX.value = fx;
        startFocalY.value = fy;
        lastFocalX.value = fx;
        lastFocalY.value = fy;
        return;
      }
      // Allow a little rubber-band below 1x / above max while pinching.
      const next = Math.min(
        MAX_SCALE * 1.2,
        Math.max(MIN_SCALE * 0.7, startScale.value * (e.scale / startPinch.value)),
      );
      const ratio = next / startScale.value;
      // Keep the content point under the fingers fixed (and follow the
      // fingers if they move together while pinching).
      tx.value = fx - ratio * (startFocalX.value - startTx.value);
      ty.value = fy - ratio * (startFocalY.value - startTy.value);
      scale.value = next;
      lastFocalX.value = fx;
      lastFocalY.value = fy;
    })
    .onEnd((e) => {
      const current = scale.value;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current));
      if (s <= MIN_SCALE) {
        scale.value = withSpring(1, SPRING);
        tx.value = withSpring(0, SPRING);
        ty.value = withSpring(0, SPRING);
        return;
      }
      // Release must never move the photo. Only if the pinch overshot the
      // max do we ease the scale back — around the fingers, so the spot
      // being zoomed stays exactly where it is.
      if (s !== current) {
        const ratio = s / current;
        const fx = lastFocalX.value;
        const fy = lastFocalY.value;
        scale.value = withSpring(s, SPRING);
        tx.value = withSpring(fx - ratio * (fx - tx.value), SPRING);
        ty.value = withSpring(fy - ratio * (fy - ty.value), SPRING);
      }
    })
    .onFinalize(() => {
      pinching.value = false;
    });

  // One-finger drag only while zoomed; at 1x the pager handles swipes. Two
  // fingers belong to the pinch — if the pan also tracked them, lifting one
  // finger would shift the touch centroid and jump the photo.
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .maxPointers(1)
    .onStart(() => {
      startTx.value = tx.value;
      startTy.value = ty.value;
    })
    .onUpdate((e) => {
      // The finger left over after a pinch must never drag the photo. (The
      // pan only becomes enabled mid-pinch, once zoomed, so it never sees
      // the second finger and maxPointers(1) can't cancel it on its own.)
      if (pinching.value || pinchedThisTouch.value || scale.value <= 1.01) return;
      // Never snap: if a pinch left the photo beyond the normal limits, the
      // limit grows to include where it already is.
      const s = scale.value;
      const maxX = Math.max(limit(contentW.value, width, s), Math.abs(startTx.value));
      const maxY = Math.max(limit(contentH.value, height, s), Math.abs(startTy.value));
      tx.value = Math.min(maxX, Math.max(-maxX, startTx.value + e.translationX));
      ty.value = Math.min(maxY, Math.max(-maxY, startTy.value + e.translationY));
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .maxDistance(20)
    .onEnd((e) => {
      if (scale.value > 1.01) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
      } else {
        const s = DOUBLE_TAP_SCALE;
        const fx = e.x - width / 2;
        const fy = e.y - height / 2;
        scale.value = withTiming(s);
        tx.value = withTiming(clampX(-fx * (s - 1), s));
        ty.value = withTiming(clampY(-fy * (s - 1), s));
      }
    });

  // maxDistance: a drag must never count as a tap (RNGH taps have no
  // movement limit by default, so panning would toggle the chrome).
  const singleTap = Gesture.Tap().maxDistance(10).onEnd(() => {
    scheduleOnRN(onSingleTap);
  });

  const gesture = Gesture.Simultaneous(
    pinch,
    pan,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height, overflow: "hidden" }]}>
        <Animated.View style={[{ width, height }, style]}>
          <Image
            source={{ uri }}
            recyclingKey={recyclingKey}
            style={{ width, height }}
            contentFit="contain"
            transition={120}
            onLoad={(e) => {
              const { width: iw, height: ih } = e.source;
              if (!iw || !ih) return;
              const fit = Math.min(width / iw, height / ih);
              contentW.set(iw * fit);
              contentH.set(ih * fit);
            }}
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

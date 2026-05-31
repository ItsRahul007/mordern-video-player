/**
 * Config plugin: build native libraries for arm64-v8a only.
 *
 * A universal Android APK ships native .so libs for all 4 ABIs
 * (armeabi-v7a, arm64-v8a, x86, x86_64), which is the main reason the APK is
 * ~114 MB. Restricting to arm64-v8a (every modern phone) cuts it to ~40-50 MB.
 *
 * `reactNativeArchitectures` is the standard RN/Expo gradle property that
 * controls which ABIs are compiled.
 *
 * Note: x86/x86_64 Android emulators (Intel) won't run this build — use a
 * physical device or an arm64 emulator (default on Apple Silicon).
 */
const { withGradleProperties } = require('expo/config-plugins');

const ARCHITECTURES = 'arm64-v8a';

module.exports = function withSingleAbi(config) {
  return withGradleProperties(config, (cfg) => {
    const properties = cfg.modResults;
    const key = 'reactNativeArchitectures';
    const existing = properties.find((item) => item.type === 'property' && item.key === key);

    if (existing) {
      existing.value = ARCHITECTURES;
    } else {
      properties.push({ type: 'property', key, value: ARCHITECTURES });
    }

    return cfg;
  });
};

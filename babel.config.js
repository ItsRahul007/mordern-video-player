// NativeWind v5 does NOT use a babel preset or jsxImportSource (those are v4-only).
// `nativewind/babel` re-adds react-native-worklets/plugin, which babel-preset-expo
// already includes — duplicating it corrupts Reanimated worklets (breaks gestures/
// animated styles, e.g. the seek bar). className is handled by withNativeWind's
// globalClassNamePolyfill in metro.config.js, so keep babel-preset-expo only.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};

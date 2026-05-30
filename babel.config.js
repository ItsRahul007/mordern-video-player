// NativeWind v5 does NOT use a babel preset or jsxImportSource (those were v4-only).
// Keep babel-preset-expo only.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    env: {
      // Fires when NODE_ENV=production, which covers both the EAS `preview`
      // and `production` release profiles.
      production: {
        plugins: ["transform-remove-console"],
      },
      preview: {
        plugins: ["transform-remove-console"],
      },
    },
  };
};

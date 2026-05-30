// Tailwind CSS v4 runs as a PostCSS plugin. Expo's Metro CSS pipeline executes
// this config, which is what expands @import "tailwindcss/*", @theme and the
// utility classes that NativeWind/react-native-css then compile for native.
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

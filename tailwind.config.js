/** @type {import('tailwindcss').Config} */

module.exports = {
  // NOTE: Update this to include the paths to all files that contain Nativewind classes.
  content: [
    "./src/app/**/*.{js,jsx,ts,tsx}",
    "./src/components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        light: {
          text: "#000000",
          background: "#ffffff",
          backgroundElement: "#F0F0F3",
          backgroundSelected: "#E0E1E6",
          textSecondary: "#60646C",
          accent: "#208AEF",
        },
        dark: {
          text: "#ffffff",
          background: "#000000",
          backgroundElement: "#212225",
          backgroundSelected: "#2E3135",
          textSecondary: "#B0B4BA",
          accent: "#4AA3FF",
        },
      },
    },
  },
  plugins: [],
};

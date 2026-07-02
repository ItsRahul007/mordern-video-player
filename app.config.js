const APP_VARIANT = process.env.APP_VARIANT ?? "development";
const IS_DEV = APP_VARIANT === "development";
const { version } = require("./package.json");

module.exports = {
  expo: {
    name: IS_DEV ? "VP (Dev)" : "Video Player",
    slug: "video-player",
    version,
    orientation: "default",
    // OTA updates via EAS Update. The fingerprint policy ties each update to
    // the native build's fingerprint, so JS-only changes ship over-the-air
    // while native changes (new modules, plugins, permissions) require a fresh
    // build that bumps the runtime version automatically.
    runtimeVersion: {
      policy: "fingerprint",
    },
    updates: {
      url: "https://u.expo.dev/bdc45493-6f5f-403c-9212-16ecbbe1c9eb",
      // Local (non-EAS-Build) builds don't get the channel baked in from
      // eas.json, so set it explicitly here keyed off APP_VARIANT. This is
      // what tells the installed app which update channel to pull from.
      requestHeaders: {
        "expo-channel-name": APP_VARIANT,
      },
    },
    icon: "./assets/images/app-logo.png",
    scheme: "mordernvideoplayer",
    userInterfaceStyle: "automatic",
    ios: {
      icon: "./assets/images/app-logo.png",
      supportsTablet: true,
      bundleIdentifier: IS_DEV
        ? "com.rahulghosh.vplayer"
        : "com.rahulghosh.mordernvideoplayer",
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#080918",
        foregroundImage: "./assets/images/app-logo.png",
      },
      predictiveBackGestureEnabled: false,
      permissions: [
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_AUDIO",
        // All-files access — needed to scan Downloads for .zip archives, which
        // the scoped READ_MEDIA_* permissions can't see. Granted via system
        // settings (see use-storage-permission.ts).
        "android.permission.MANAGE_EXTERNAL_STORAGE",
        // Let DownloadManager show its background-download progress notification
        // on Android 13+ (see modules/media-downloader).
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.ACCESS_NETWORK_STATE",
      ],
      package: IS_DEV
        ? "com.rahulghosh.vplayer"
        : "com.rahulghosh.mordernvideoplayer",
      // Register the app as a handler for video files so it shows up under the
      // file manager's "Open with" menu. File managers fire ACTION_VIEW with a
      // content:// (or file://) URI and a video/* MIME type.
      intentFilters: [
        {
          action: "VIEW",
          category: ["DEFAULT", "BROWSABLE"],
          data: [
            { mimeType: "video/*", scheme: "content" },
            { mimeType: "video/*", scheme: "file" },
          ],
        },
      ],
    },
    web: {
      output: "static",
      favicon: "./assets/images/app-logo.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#080918",
          android: {
            image: "./assets/images/app-logo.png",
            imageWidth: 200,
          },
        },
      ],
      [
        "expo-video",
        {
          supportsBackgroundPlayback: false,
          supportsPictureInPicture: true,
        },
      ],
      [
        "expo-file-system",
        {
          supportsOpeningDocumentsInPlace: true,
          enableFileSharing: true,
        },
      ],
      "expo-sqlite",
      [
        "expo-media-library",
        {
          photosPermission: "Allow $(PRODUCT_NAME) to access your photos.",
          videosPermission: "Allow $(PRODUCT_NAME) to access your videos.",
          isAccessMediaLocationEnabled: false,
        },
      ],
      // Receive shared links (e.g. "Share → Video Player" from Instagram).
      // Defaults to text + URL sharing, which is what social links arrive as.
      "expo-share-intent",
      "./plugins/with-single-abi.js",
      "./plugins/with-gradle-memory.js",
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: "bdc45493-6f5f-403c-9212-16ecbbe1c9eb",
      },
    },
  },
};

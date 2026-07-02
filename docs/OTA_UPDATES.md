# OTA Updates (EAS Update)

Push JS/UI changes to installed apps without shipping a new APK.

## What ships OTA vs needs a new build

- **OTA (`eas update`):** JS, UI, logic, styling, assets.
- **New build required:** new native package (`expo install ...`), config plugins in `plugins/`, or native settings in `app.config.js` (permissions, intent filters, icon, splash).

The `fingerprint` runtime policy handles this automatically — native changes shift the fingerprint, so old builds won't pull an incompatible update.

## One-time setup

Create the channels on the server:

```bash
eas channel:create preview
eas channel:create production
```

## Build locally

Set the variant so the correct channel gets baked in, then build as usual:

```bash
APP_VARIANT=preview <your local android build command>
```

Give this APK to users **once**. All future JS changes go OTA.

## Push a JS change

```bash
eas update --branch preview -m "describe the change"
```

Installed apps download it in the background and apply it on next launch.

> `--branch` must match the build's channel (`preview` → `preview`). Same for `production`.

## Notes

- Channel is set via `expo-channel-name` header in `app.config.js` (keyed off `APP_VARIANT`) — required because local builds don't get it from `eas.json`.
- Updates only work in release builds, not dev mode.
- If an update won't apply, check fingerprints match:
  ```bash
  npx expo-updates fingerprint:generate
  ```

## Config locations

- `app.config.js` → `updates.url`, `runtimeVersion`, `updates.requestHeaders`
- `eas.json` → `channel` per build profile (used by EAS cloud builds)

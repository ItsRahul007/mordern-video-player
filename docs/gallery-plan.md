# Gallery tab: plan

Branch: `feature/gallery` (parent: `social-downloaders`)

## Goal

Add a bottom navigation bar with two tabs:

| Tab | What it shows |
| --- | --- |
| **Home** | The current video library: folders, then the videos in each folder. Unchanged. |
| **Gallery** | A modern photo + video gallery: every image and video on the device, plus an Albums view that shows folders the same way Home does, but with images included. |

## Navigation / routing

expo-router v56 bundles its own JS bottom-tabs navigator (`Tabs` from `expo-router`). We use it with a
**custom floating tab bar** instead of `NativeTabs`:
- no new native dependency, so it can ship as an OTA update
- `NativeTabs` is still `unstable-native-tabs` in SDK 56, and its docs list problems with `FlatList`
  (the bar turns transparent, scroll-to-top doesn't work). Both tabs are built on lists.

```
src/app/
  _layout.tsx            root Stack ("(tabs)" replaces "index")
  (tabs)/
    _layout.tsx          Tabs + custom bar (Home, Gallery)
    index.tsx            Home (moved from app/index.tsx, unchanged)
    gallery.tsx          Gallery tab
  album/[id].tsx         gallery album grid (images + videos), pushed over the tabs
  viewer.tsx             full-screen media viewer (swipe between items), fullScreenModal
  folder/[id].tsx        unchanged (video folders)
  player.tsx             unchanged; the gallery opens videos here when you tap Play
```

The tab bar is hidden on pushed screens because they sit on the root Stack, above the tabs.

## Data layer: `src/lib/gallery.ts` + `src/hooks/use-gallery.ts`

- `GalleryItem = { id, uri, mediaType: 'image' | 'video', filename, width, height, duration, creationTime }`
- `getGalleryPage({ albumId?, filter, offset, limit })` builds a media-library v56 `Query`:
  `within(MEDIA_TYPE, [IMAGE, VIDEO])` (or `eq` for a single type), with optional `.album()`, ordered by
  `CREATION_TIME desc`, then `.limit().offset()`.
- **Paged loading** with `useInfiniteQuery` (pages of about 120). A gallery can hold tens of thousands of
  items, so the existing approach of loading a whole folder and calling `getInfo()` on every item
  won't scale here.
- `getGalleryAlbums()` returns every album that has at least one image or video: cover, title, image
  count and video count.
- `MediaLibrary.addListener` invalidates the gallery queries when the device library changes (a new
  photo, a download, a deletion).
- Deleting and sharing reuse `Asset.delete` and the `share-files` module. The share MIME type becomes
  `*/*` when the selection mixes images and videos.

## Gallery tab UI

**Header:** large "Gallery" title, item count, and a segmented control **Photos | Albums**.

**Photos view (timeline)**
- Filter chips: **All · Photos · Videos**
- A dense grid (3 columns, 2px gutters) with **sticky month headers** ("November 2026", "Today",
  "Yesterday"). Built as a flattened FlatList: header rows plus rows of N tiles, with
  `stickyHeaderIndices`.
- Tiles are square. Video tiles show a duration pill (`1:23`) and a play glyph.
- Infinite scroll (`onEndReached` fetches the next page). Pull to refresh.
- Pinch to change column count (2 ↔ 3 ↔ 4 ↔ 5); the choice is remembered. *(phase 2)*

**Albums view**
- 2-column grid of rounded cards: cover image, album title, "128 photos · 12 videos".
- Tap opens `album/[id]`, which is the same timeline grid scoped to that album.

**Selection (both views)**
- Long-press a tile to start selection mode; tap to toggle. A top bar shows the count, Share and Delete.
- Drag across tiles to select a range. *(phase 2)*
- Hardware back clears the selection first, the same as Home.

**Viewer (`viewer.tsx`)**
- Black, full-screen, horizontal pager over the same list you opened it from (swipe left and right).
- Images: `expo-image` `contentFit="contain"`, double-tap and pinch to zoom *(zoom in phase 2)*.
- Videos: a poster frame with a big Play button that opens the existing `player` (keeps gestures, resume
  and subtitles in one place).
- Tap toggles the chrome. Top bar: back and filename. Bottom bar: Share, Info (date, resolution, size),
  Delete.

## Thumbnails

- Images: `expo-image` straight from the `file://` URI. On Android it decodes at the tile's size, and
  caching is handled for us (`recyclingKey` = asset id).
- Videos: on Android, try `expo-image` with the video URI first (Glide can decode a frame). If that
  fails, fall back to the existing disk-cached `VideoThumbnail` (serial queue, so it can't run out of
  memory).

## Phases

1. **Foundation (this PR):** tabs and custom bar, move Home, the gallery data layer, the Photos
   timeline grid with filters and month headers, the Albums grid and album screen, multi-select with
   share and delete, and the basic viewer with share, delete and info.
2. **Polish:** pinch-to-zoom in the viewer, pinch to change column count, drag-to-select, favorites
   (`Asset.setFavorite`, Android 11+) with a "Favorites" filter, and a scroll-position scrubber for
   long timelines.
3. **Extras (optional):** search by filename, a "Screenshots / Camera / Downloads" quick-albums row,
   moving and copying to an album, and a `FlashList` swap if FlatList profiling shows jank.

## Risks / notes

- Permissions: `READ_MEDIA_IMAGES` is already in `app.config.js`, and `usePermissions()` asks for both.
  Users who chose "Selected photos" (`READ_MEDIA_VISUAL_USER_SELECTED`) only see what they picked; we
  show a banner offering "Allow all".
- Android's media-library change listener only reports *that* something changed, not what, so we
  invalidate everything and re-page.
- Work on Android-first; iOS `ph://` URIs can't be shared (same limitation as Home today).

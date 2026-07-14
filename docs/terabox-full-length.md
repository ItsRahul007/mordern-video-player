# TeraBox full-length download/stream — investigation & status

**Status:** unsolved for full length. The app currently downloads/streams only a
**~4-minute** slice of longer TeraBox videos. Root cause is a TeraBox-side
limitation plus a datacenter-IP block that kills every server-side workaround.
This doc records what was tried, the hard evidence, and the remaining options so
we don't re-derive it.

**Date:** 2026-07-14
**Branch:** `social-downloaders`
**Key files:** [src/lib/terabox.ts](../src/lib/terabox.ts),
[src/app/terabox.tsx](../src/app/terabox.tsx),
[terabox-worker/worker.js](../terabox-worker/worker.js)

---

## 1. The requirement

Download **and** stream the **full-length** video from a TeraBox share.
Quality is flexible — **480p or lower is fine** — the only hard requirement is
the **complete runtime**, not a truncated clip.

Test case used throughout: a share whose real video is **7:04** (424 s), original
file **93 MB**, `fsid=1078549812626383` (also earlier `143357910`).

---

## 2. Background — how the TeraBox downloader works

TeraBox blocks **datacenter IPs**: a server-side resolver is served a stub share
page (no `jsToken`) and anti-bot gates (`verify_v2`). So the resolve was moved
**on-device** (the phone's residential IP works). Two modes exist in the UI
([src/app/terabox.tsx](../src/app/terabox.tsx)) — **Fast** (transcoded HLS) and
**Original** (full-quality file):

- **Fast / HLS** — the device calls `/share/streaming` to get a transcoded
  `.m3u8`, then plays/downloads the segments. Segments live on an **open CDN**
  (`*-vdata.1024tera.com`) that needs **no cookies/headers**. This is the fast,
  reliable, fully on-device path.
- **Original** — the full file via a signed `dlink` from `/api/sharedownload`.
  Behind the account **login cookie** (httpOnly `ndus`) and **throttled to
  ~20–30 KB/s** for non-VIP accounts. Routed through an optional Cloudflare
  **Worker** ([terabox-worker/worker.js](../terabox-worker/worker.js)) that holds
  the cookie as a secret (`TERABOX_COOKIE`).

---

## 3. Symptom

Watching or downloading a long video yields only **~30 s** (originally), later
**~3–4 min** after fixes below — never the full runtime. Both Watch and Download
are affected because both consume the same `/share/streaming` manifest.

---

## 4. Investigation timeline & evidence

### 4.1 The manifest is a short byte-range **preview window**

The anonymous `/share/streaming` manifest is **not** the whole video. It returns
**3 segments (~20–30 s)** marked `#EXT-X-ENDLIST`, so the player stops there.
Each segment URL is a **byte-range slice** of the transcoded `.ts`:

```
#EXTM3U
#EXT-X-TARGETDURATION:15
#EXTINF:10,
https://kul-vdata.1024tera.com/.../<hash>?...&ts_size=4497900&...&len=256244&range=1844092-2100335&...&sign=<S>&xcode=<X>&...
#EXTINF:10,
https://kul-vdata.1024tera.com/.../<hash>?...&ts_size=4497900&...&len=274104&range=2100336-2374439&...&sign=<S>&xcode=<X>&...
...
#EXT-X-ENDLIST
```

Key observations:
- `ts_size` = full size of the transcoded `.ts` object.
- `range=<start>-<end>` / `len=` slice that object; the window covers only a
  small part of `ts_size`.
- **All segments in one manifest share the same `sign`/`xcode`** → the signature
  authorizes the **whole** object, not a specific range. `sign` embeds the file
  etag.

**Fix:** `expandTranscodedManifest()` in
[src/lib/terabox.ts](../src/lib/terabox.ts) rebuilds a full manifest by paging
contiguous byte windows over `0…ts_size`, reusing the same signed URL (rewriting
only `range`/`len`/`dtime`). Windows ≈10 s, aligned to the 188-byte MPEG-TS
packet size; `#EXTINF` durations extrapolated from the preview's bytes/second
(Σ`len` ÷ Σ`EXTINF`). `fetchFullStream()` wraps fetch+expand; both Watch
(`prepareTeraboxWatchUri`) and Download (`downloadHlsToFile`) use it.

**Result:** download now writes exactly `ts_size` with **0 short segments, no
errors** — i.e. we pull 100 % of the transcoded object. Confirmed by log:
`download done: wrote 6641664B of ts_size=6641664 (0 short segment(s))`.

### 4.2 `ts_size` **varies per call**; sample the largest

Repeated calls for the same video return **different-sized** transcode objects,
e.g. `ts_size` = 6,641,664 (6.3 MB) vs 8,846,904 (8.4 MB). A poll of 10 calls:

```
poll 1/10: ts_size=8846904 previewRange=7173704-7518307
poll 2/10: ts_size=8846904 previewRange=6807856-7173703
...
poll 7/10: ts_size=8846904 previewRange=0-154723
poll 9/10: ts_size=6641664 previewRange=4029028-4389611
poll done: max ts_size=8846904
```

- Max object across 10 polls = **8,846,904 B (~8.4 MB)** — never higher.
- `previewRange` values span **0 → ~7.85 M**, i.e. the windows sample the entire
  8.4 MB object → each object is complete in itself, just short.

**Fix:** `fetchFullStream()` samples a few times and keeps the largest object
(`STREAM_SAMPLE_ATTEMPTS`). Bought ~4 min instead of ~3 min.

### 4.3 The transcode itself is **length-capped (~4 min)** for anonymous

Downloading the largest object (8.4 MB) yields a file that plays **3:03–~4:04**,
vs the real **7:04**. Extrapolation matches: the 6.3 MB object played exactly
**3:03** → ~36 KB/s → 8.4 MB ≈ ~4 min. Full 7:04 at that bitrate would be
**~15 MB**, never observed.

**Conclusion:** the **anonymous** transcode is capped well below the full
runtime. Paging cannot fix this — the later minutes are simply not in the object.

### 4.4 Original file via Worker — resolve works, **download CDN blocks**

Attempted the full-quality original through the Worker, with the device supplying
the resolved share context so the Worker skips its (dead) resolve:

```
JSTOKEN try {"path":"/main","status":200,"htmlLen":115064,"found":true}
SHAREDOWNLOAD {"usedOwnToken":true,"errno":0,"hasDlink":true}
DOWNLOAD FAILED {"stage":"download","upstreamStatus":403,
  "upstreamUrl":"https://d.1024terabox.com/file/...&region=dm",
  "bodySnippet":"{\"error_code\":31045,\"error_msg\":\"user not exists\"}"}
```

- The Worker's cookie is **valid**: it fetches its own `jsToken` from `/main`
  and `sharedownload` returns `errno:0` with a real `dlink`.
- But fetching that `dlink` from `d.1024terabox.com` → **403 `error_code:31045
  "user not exists"`**. The **file CDN blocks the Worker's datacenter IP** (same
  root cause as the resolve block). `region=dm` on the dlink hints at
  region/IP binding.

**Conclusion:** the original file **cannot** be pulled through the Worker, ever.

### 4.5 Logged-in HLS via Worker — **streaming endpoint blocks**

Pivoted: since 480p-or-lower is acceptable, try to get the **full-length
transcode** by resolving `/share/streaming` in the Worker's **logged-in** session
(hypothesis: the ~4-min cap is anonymous-only; login lifts it; segments are
open-CDN so the device downloads them directly).

```
JSTOKEN try {"path":"/main","status":200,"htmlLen":115064,"found":true}
HLS_CTX {"status":200,"isManifest":false,"tsSize":0,"previewDur":0}
# app side:
proxy HLS not a manifest: {"errno":400141,"errmsg":"need verify"}
```

- Worker's logged-in `/share/streaming` → **errno 400141 "need verify"** — the
  anti-bot gate rejecting the **datacenter IP** on the streaming endpoint.
- The app **falls back** to the on-device anonymous stream automatically, so Fast
  mode still works (at the ~4-min cap).

**Conclusion:** the Worker (datacenter IP) is blocked at **every** endpoint that
would yield the full video — file CDN (`user not exists`) and streaming
(`need verify`). Only `sharedownload` tolerates the datacenter IP, and what it
returns is CDN-blocked.

---

## 5. Root cause (summary)

1. **Anonymous transcode is length-capped** (~4 min for the 7-min test video).
2. **TeraBox blocks datacenter IPs** at the streaming endpoint (`400141 need
   verify`) and the file CDN (`31045 user not exists`). So no **server/Worker**
   path can deliver the full video, regardless of a valid cookie.
3. The **full-length stream exists only for a logged-in session from a
   residential IP** — which is how TeraBox's own web player streams the full 7
   min. That means the **device** must be logged in; the server cannot stand in.

---

## 6. What works today

- **Fast / HLS on-device**, paging the **largest** anonymous transcode object:
  full download of that object (verified byte-exact), but only **~4 min** of a
  longer video.
- **Watch** uses the same manifest (also ~4 min).
- Automatic fallback: if the (currently blocked) logged-in Worker manifest fails,
  the app uses the on-device anonymous manifest — Fast mode never fully breaks.

---

## 7. Options for full length

All require the **device** to be logged in (residential IP + session). The server
is ruled out.

| # | Approach | Pros | Cons / risks |
|---|----------|------|--------------|
| A | **WebView login** (like the Instagram downloader in [src/components/instagram-webview.tsx](../src/components/instagram-webview.tsx)): user logs into TeraBox once in-app; resolve `/share/streaming` **inside the page context** so the login applies; download open-CDN segments on-device. | No cookie handling; cookies live in the WebView store; residential IP → no block; full speed; matches an existing proven pattern. | Biggest build; adds an in-app TeraBox login UX. |
| B | **Paste cookie into the app**: device uses it on-device (residential IP) for the logged-in `/share/streaming`. | Smaller build. | User must paste + refresh the cookie; cookie stored in-app (user previously preferred not to). |
| C | **Stop at ~4 min**: keep on-device anonymous HLS, remove diagnostics. | No further work. | Doesn't meet the full-length requirement. |

### Residual **unverified** hypothesis (applies to A and B)

We never made a **logged-in request from a residential IP**, so it is *strongly
likely but not proven* that logged-in `/share/streaming` returns the **full
length**. Evidence for: TeraBox's own web player streams the full 7 min to a
logged-in user. Cheap pre-check before building: in a logged-in browser, open the
share, play the video, and inspect the `/share/streaming` `.m3u8` in devtools —
confirm its `ts_size`/total duration is the full runtime (~15 MB / ~7 min), not
~8.4 MB / ~4 min.

If logged-in streaming is **also** capped, the full video would only exist in the
**original file**, which needs residential IP **+** cookie together (the file CDN
blocks datacenter IPs) — i.e. an on-device logged-in original download, throttled
to ~20–30 KB/s for a free account (~1 hr for 93 MB).

---

## 8. Code map

App — [src/lib/terabox.ts](../src/lib/terabox.ts):
- `resolveShareOnDevice` / `fetchShareInfo` — on-device (residential) share
  resolve → `sign`/`shareid`/`uk`/`timestamp`/`jsToken` per file.
- `fetchHlsManifest` → tries `fetchHlsManifestViaProxy` (logged-in Worker,
  currently blocked → returns null) then falls back to on-device anonymous.
- `fetchFullStream` — samples manifest(s), keeps largest `ts_size`, expands.
- `expandTranscodedManifest` — byte-range paging over `0…ts_size`.
- `downloadHlsToFile` — fetches each segment (open CDN), appends to one `.ts`.
- `prepareTeraboxWatchUri` — writes the rebuilt `.m3u8` for the player.
- `teraboxStreamUrl` / `originalContextQs` / `checkTeraboxOriginal` — Worker
  original-file plumbing (dead due to §4.4) + `resolve=1` preflight.

App — [src/app/terabox.tsx](../src/app/terabox.tsx):
- Fast/Original toggle; `ensureOriginalOk` preflight; `cookieExpired` amber
  warning banner.

Worker — [terabox-worker/worker.js](../terabox-worker/worker.js):
- `getSessionJsToken` (cached) — own `jsToken` from `/main` etc.
- `getDlinkFromContext` — `sharedownload` from device context + cookie (works,
  but the resulting dlink is CDN-blocked, §4.4).
- `handleHlsFromContext` — logged-in `/share/streaming` (blocked, §4.5).
- `isAuthErrno` — auth-errno → `cookie_expired` (guess; refine from logs).

---

## 9. Diagnostic logging to remove once resolved

Temporary `console.log`s added during the investigation (in
[src/lib/terabox.ts](../src/lib/terabox.ts) and
[terabox-worker/worker.js](../terabox-worker/worker.js)):
`expand:`, `picked largest object:`, `download:` / `download done:`,
`manifest q=…`, `HLS manifest via proxy`, and the Worker's `JSTOKEN try`,
`SHAREDOWNLOAD`, `HLS_CTX`. Remove these when the approach is finalized.

---

## 10. Known TeraBox errnos seen

| errno / code | Where | Meaning |
|---|---|---|
| `0` | `sharedownload` | success (dlink returned) |
| `400141 "need verify"` | `/share/streaming` (Worker) | anti-bot gate, datacenter IP |
| `400210 "need verify_v2"` | API w/o cookies | anti-bot gate (anonymous) |
| `31045 "user not exists"` | `d.1024terabox.com` file CDN | datacenter IP rejected on download |
| `130` | `/share/streaming` 720/1080 | quality needs VIP |
| `-9` / `105` | `shorturlinfo` | link invalid/expired |
| `-12` | `shorturlinfo` | password-protected share |

---

## 11. Decision pending

Which of §7 A / B / C to pursue. Recommendation: **A (WebView login)** — only
full-length path that needs no cookie handling and reuses the Instagram pattern —
after the cheap browser pre-check in §7 confirms logged-in streaming is
full-length.

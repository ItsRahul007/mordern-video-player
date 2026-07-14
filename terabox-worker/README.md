# TeraBox download proxy (Cloudflare Worker)

The app resolves TeraBox share links to a signed `dlink` on-device, but the final
file download needs the account's **httpOnly session cookie** — which a mobile app
can't read or send (Android hides httpOnly cookies, and TeraBox's CDN blocks the
WebView from reading the bytes cross-origin). This tiny Worker does that last
authenticated fetch server-side and streams the file back.

It's free (Cloudflare Workers free tier) and you own it.

## Deploy

```sh
cd terabox-worker
npx wrangler login          # first time only
npx wrangler deploy
```

Then set your TeraBox cookie as a secret:

```sh
npx wrangler secret put TERABOX_COOKIE
# paste your cookie, e.g.:  ndus=XXXXXXXXXXXXXXXX
```

To get the cookie: log in to https://www.terabox.com in a desktop browser →
DevTools → Application → Cookies → copy at least the `ndus` value (format
`ndus=...`). It's long-lived; re-run the command if downloads start failing with
auth errors.

Optional — gate the proxy with a shared secret so only your app can use it:

```sh
npx wrangler secret put PROXY_TOKEN   # paste any random string
```

## Point the app at it

After deploy, wrangler prints a URL like `https://terabox-proxy.<you>.workers.dev`.
Set these env vars for the app build (e.g. in a `.env` at the repo root):

```sh
EXPO_PUBLIC_TERABOX_PROXY_URL=https://terabox-proxy.<you>.workers.dev
# only if you set PROXY_TOKEN above:
EXPO_PUBLIC_TERABOX_PROXY_TOKEN=<the same random string>
```

Rebuild the app. The TeraBox downloader will route the file download through the
Worker; resolving the share (file list, thumbnail, size) still happens on-device.

## Endpoints

| Request | Returns |
|---|---|
| `GET /?surl=<id>&list=1` | The share's file list (JSON). |
| `GET /?surl=<id>&fs_id=<id>` | The **original file** streamed via its dlink (full quality; TeraBox throttles this to ~20-30 KB/s for non-VIP). |
| `GET /?surl=<id>&fs_id=<id>&hls=1` | The transcoded **HLS manifest** (`.m3u8`) for online playback. Segments are rewritten to route back through the Worker (`?seg=`). Fast, unthrottled — this is the path the TeraBox site itself plays. Add `&quality=720` / `1080` (needs a VIP cookie). |
| `GET /?surl=<id>&fs_id=<id>&hls=1&download=1` | The HLS segments concatenated into one **MPEG-TS** file (`.ts`), streamed as an attachment. Fast download at transcode quality. |
| `GET /?seg=<encoded-segment-url>` | Internal — proxies a transcode-CDN segment with the Referer/cookie. |
| `GET /?url=<dlink>` | Proxy a raw dlink. |
| `GET /?cookie=1&token=<PROXY_TOKEN>` | Returns `{ "cookie": "<TERABOX_COOKIE>" }` so the app can run logged-in on-device (full-length HLS). **Token-gated** — requires `PROXY_TOKEN` to be set; the cookie is a live session. |
| `GET /?debug=1` | Cookie health check. |

> **Runtime cookie (no rebuild on rotation):** the app fetches the cookie from
> `?cookie=1` at launch and caches it, instead of baking it into the bundle. When
> the cookie expires, just `wrangler secret put TERABOX_COOKIE` — the app picks up
> the new value on its next launch. This needs both `PROXY_TOKEN` (Worker secret)
> and `EXPO_PUBLIC_TERABOX_PROXY_TOKEN` (app env) set to the same value.

> **Why HLS?** TeraBox deliberately rate-caps the original-file dlink for non-VIP
> accounts, so both direct downloads and dlink-based playback crawl at ~20-30 KB/s.
> The site's own player instead streams a transcoded H.264 variant from a fast CDN
> (`/share/streaming` → `.m3u8`). The `hls=1` endpoints use that same path, so watch
> is smooth and the fast download runs at full CDN speed — at the cost of transcode
> quality (480p by default; higher needs VIP) and a `.ts` container (no ffmpeg in a
> Worker to re-mux to MP4).

## Test

```sh
# Original file via dlink (slow for non-VIP):
curl -L "https://terabox-proxy.<you>.workers.dev/?url=<URL-ENCODED-DLINK>" -o test.mp4

# HLS manifest (should print #EXTM3U...); if it prints JSON, check `wrangler tail`:
curl "https://terabox-proxy.<you>.workers.dev/?surl=<ID>&fs_id=<FSID>&hls=1"

# Fast transcoded download:
curl -L "https://terabox-proxy.<you>.workers.dev/?surl=<ID>&fs_id=<FSID>&hls=1&download=1" -o fast.ts
```

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

## Test

```sh
# Should stream the file (replace with a real dlink from the app logs):
curl -L "https://terabox-proxy.<you>.workers.dev/?url=<URL-ENCODED-DLINK>" -o test.mp4
```

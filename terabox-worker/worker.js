/**
 * Cloudflare Worker — TeraBox download/stream proxy + resolver.
 *
 * Why server-side: the signed `dlink` needs the account's httpOnly session
 * cookie, which a mobile app can't read or send. TeraBox sessions are also
 * DOMAIN-scoped, so this Worker resolves AND fetches on one domain (the cookie's)
 * to keep the session consistent.
 *
 * Endpoints:
 *   GET /?surl=<id>[&fs_id=<id>]            stream the file (download OR watch).
 *                                           Honors Range requests for seeking.
 *   GET /?surl=<id>&list=1                  return the file list (JSON).
 *   GET /?url=<dlink>                       proxy a raw dlink.
 *   GET /?debug=1                           cookie health check.
 *
 * Set the secret TERABOX_COOKIE to the FULL cookie header from a logged-in
 * browser (lang; ndus; ndut_fmt; csrfToken; browserid; …). See README.md.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BASE = "https://www.1024terabox.com";

const ALLOWED_DLINK_HOST = /(^|\.)(terabox|1024tera|1024terabox|teraboxapp|terafileshare)\.com$/i;

/**
 * HLS transcode variants TeraBox exposes via /share/streaming. This is the path
 * the terabox.app player itself uses — the transcoded stream is served from a
 * FAST, unthrottled CDN, unlike the original-file dlink which TeraBox rate-caps
 * to ~20-30 KB/s for non-VIP accounts. 480p works on any account; the 720/1080
 * variants only resolve for VIP cookies (they fall back to a JSON errno otherwise).
 */
const HLS_TYPES = {
  "480": "M3U8_FLV_264_480",
  "720": "M3U8_AUTO_720",
  "1080": "M3U8_FLV_264_1080",
};

/** Referer the transcode CDN accepts for the manifest + segment fetches. */
const HLS_REFERER = "https://www.terabox.com/";

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (url.searchParams.get("debug")) {
      const c = env.TERABOX_COOKIE || "";
      return json(
        {
          base: BASE,
          cookiePresent: !!c,
          cookieLen: c.length,
          cookieNames: c.split(";").map((p) => p.trim().split("=")[0]).filter(Boolean),
          hasProxyToken: !!env.PROXY_TOKEN,
        },
        200,
        cors,
      );
    }

    if (env.PROXY_TOKEN && url.searchParams.get("token") !== env.PROXY_TOKEN) {
      return json({ error: "unauthorized" }, 401, cors);
    }
    if (!env.TERABOX_COOKIE) {
      return json({ error: "Worker is missing the TERABOX_COOKIE secret" }, 500, cors);
    }

    const surl = url.searchParams.get("surl");
    const dlinkParam = url.searchParams.get("url");
    const segParam = url.searchParams.get("seg");
    const range = request.headers.get("Range");

    try {
      // A transcode-CDN segment, routed back through the Worker so it carries the
      // Referer/cookie (the rewritten HLS manifest points every segment here).
      if (segParam) {
        return proxySegment(segParam, env.TERABOX_COOKIE, cors, range);
      }
      if (surl) {
        const id = surl.replace(/^1/, "");
        if (url.searchParams.get("list")) {
          const r = await resolveShare(env, id);
          if (!r.ok) return json(r, 200, cors);
          return json({ errno: 0, list: r.info.list }, 200, cors);
        }
        // HLS path (fast transcoded stream — used for watch AND fast download).
        if (url.searchParams.get("hls")) {
          return handleHls(
            env,
            id,
            url.searchParams.get("fs_id"),
            url.searchParams.get("quality") || "480",
            !!url.searchParams.get("download"),
            url,
            cors,
          );
        }
        // Original file (download or watch): resolve a dlink (cached), stream it.
        // Full quality, but TeraBox throttles it hard for non-VIP accounts.
        const d = await getDlink(env, id, url.searchParams.get("fs_id"), ctx);
        if (!d.ok) return json(d, 200, cors);
        return streamFile(d.dlink, env.TERABOX_COOKIE, d.filename, cors, range);
      }
      if (dlinkParam) {
        return streamFile(dlinkParam, env.TERABOX_COOKIE, null, cors, range, true);
      }
      return json({ error: "pass ?surl=<id> or ?url=<dlink>" }, 400, cors);
    } catch (e) {
      return json({ error: String(e) }, 500, cors);
    }
  },
};

/** Resolve a share on the cookie's domain: jsToken, then shorturlinfo. */
async function resolveShare(env, surl) {
  const h = { "User-Agent": USER_AGENT, Cookie: env.TERABOX_COOKIE };

  const pageRes = await fetch(`${BASE}/s/1${surl}`, { headers: h, redirect: "follow" });
  const html = await pageRes.text();
  const origin = new URL(pageRes.url).origin;
  const jsToken = extractToken(html);
  if (!jsToken) {
    return { ok: false, stage: "jsToken", error: "no jsToken", pageStatus: pageRes.status, finalUrl: pageRes.url, htmlLen: html.length };
  }

  const qp = `app_id=250528&web=1&channel=dubox&clienttype=0&jsToken=${encodeURIComponent(jsToken)}&dp-logid=`;
  const apiH = { ...h, Referer: `${origin}/` };
  const info = await (await fetch(`${origin}/api/shorturlinfo?${qp}&shorturl=1${surl}&root=1`, { headers: apiH })).json();
  if (info.errno !== 0 || !info.shareid || !info.sign) {
    return { ok: false, stage: "shorturlinfo", errno: info.errno, errmsg: info.errmsg };
  }
  const files = (info.list || []).filter((f) => String(f.isdir) !== "1");
  return { ok: true, origin, qp, apiH, info, files, jsToken };
}

/**
 * Resolve and return the transcoded HLS stream for a file. For `download`, the
 * segments are concatenated server-side into one MPEG-TS file and streamed as an
 * attachment. Otherwise the M3U8 manifest is returned with every segment URL
 * rewritten to route back through this Worker (`?seg=`), so the player needs no
 * special headers — the Worker applies the Referer/cookie to each segment.
 */
async function handleHls(env, surl, fsIdWanted, quality, download, reqUrl, cors) {
  const r = await resolveShare(env, surl);
  if (!r.ok) return json(r, 200, cors);
  const file = fsIdWanted
    ? r.files.find((f) => String(f.fs_id) === String(fsIdWanted))
    : r.files[0];
  if (!file) {
    return json({ ok: false, stage: "pick", error: "file not found", fsIdWanted }, 200, cors);
  }

  const type = HLS_TYPES[quality] || HLS_TYPES["480"];
  const streamUrl =
    `${r.origin}/share/streaming?uk=${r.info.uk}&shareid=${r.info.shareid}` +
    `&type=${type}&fid=${file.fs_id}&sign=${encodeURIComponent(r.info.sign)}` +
    `&timestamp=${r.info.timestamp}&jsToken=${encodeURIComponent(r.jsToken)}` +
    `&isplayer=1&esl=1&ehps=1&clienttype=0&app_id=250528&web=1&channel=dubox`;

  const res = await fetch(streamUrl, { headers: { ...r.apiH, Referer: HLS_REFERER } });
  const text = await res.text();
  if (!text.trim().startsWith("#EXTM3U")) {
    // Not a manifest — usually a JSON errno (e.g. quality needs VIP, or expired).
    console.log("HLS FAILED", JSON.stringify({ status: res.status, type, body: text.slice(0, 300) }));
    return json({ stage: "streaming", type, status: res.status, body: text.slice(0, 400) }, 200, cors);
  }

  // Segment URIs in the manifest are absolute (a different CDN host); resolve any
  // relative ones against the manifest URL just in case.
  const segUrls = () =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (/^https?:\/\//.test(l) ? l : new URL(l, streamUrl).toString()));

  if (download) {
    return downloadHlsConcat(segUrls(), env.TERABOX_COOKIE, file.server_filename, cors);
  }

  const origin = reqUrl.origin;
  const token = reqUrl.searchParams.get("token");
  const tokenQ = token ? `&token=${encodeURIComponent(token)}` : "";
  const rewritten = text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const abs = /^https?:\/\//.test(t) ? t : new URL(t, streamUrl).toString();
      return `${origin}/hls/seg.ts?seg=${encodeURIComponent(abs)}${tokenQ}`;
    })
    .join("\n");

  const out = new Headers({ "Content-Type": "application/x-mpegURL" });
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(rewritten, { headers: out });
}

/** Fetch one transcode-CDN segment with the Referer/cookie and stream it back. */
async function proxySegment(segUrl, cookie, cors, range) {
  try {
    new URL(segUrl);
  } catch {
    return json({ error: "invalid seg url" }, 400, cors);
  }
  const headers = {
    "User-Agent": USER_AGENT,
    Referer: HLS_REFERER,
    Cookie: cookie,
    Accept: "*/*",
  };
  if (range) headers.Range = range;

  const upstream = await fetch(segUrl, { headers, redirect: "follow" });
  const out = new Headers();
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * Stream the HLS segments back-to-back as a single MPEG-TS download. Segments are
 * fetched one at a time and enqueued as they arrive, so memory stays flat even for
 * a large video (no whole-file buffering). Concatenated TS plays in expo-video and
 * most players; it isn't a re-muxed MP4 (no ffmpeg in a Worker).
 */
function downloadHlsConcat(segUrls, cookie, filename, cors) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const s of segUrls) {
          const up = await fetch(s, {
            headers: { "User-Agent": USER_AGENT, Referer: HLS_REFERER, Cookie: cookie, Accept: "*/*" },
            redirect: "follow",
          });
          if (!up.ok) throw new Error(`segment ${up.status}`);
          controller.enqueue(new Uint8Array(await up.arrayBuffer()));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  const base = (filename || "video").replace(/\.[^.]+$/, "");
  const name = `${base}.ts`.replace(/"/g, "");
  const out = new Headers({
    "Content-Type": "video/mp2t",
    "Content-Disposition": `attachment; filename="${name}"`,
  });
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(stream, { headers: out });
}

/**
 * Get a downloadable dlink for a file, caching it (~50 min) so repeated requests
 * — especially Range requests while streaming a video — don't re-resolve.
 */
async function getDlink(env, surl, fsIdWanted, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://terabox-cache.local/dlink?surl=${surl}&fs_id=${fsIdWanted || ""}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    return { ok: true, ...(await hit.json()) };
  }

  const r = await resolveShare(env, surl);
  if (!r.ok) return r;
  const file = fsIdWanted ? r.files.find((f) => String(f.fs_id) === String(fsIdWanted)) : r.files[0];
  if (!file) return { ok: false, stage: "pick", error: "file not found", fsIdWanted, count: r.files.length };

  const dl = await (await fetch(
    `${r.origin}/api/sharedownload?${r.qp}&shareid=${r.info.shareid}&uk=${r.info.uk}` +
      `&sign=${encodeURIComponent(r.info.sign)}&timestamp=${r.info.timestamp}` +
      `&primaryid=${r.info.shareid}&product=share&nozip=0&fid_list=[${file.fs_id}]`,
    { headers: r.apiH },
  )).json();
  const dlink = dl.dlink || (dl.list && dl.list[0] && dl.list[0].dlink);
  if (!dlink) return { ok: false, stage: "sharedownload", errno: dl.errno, errmsg: dl.errmsg };

  const data = { dlink, filename: file.server_filename };
  if (ctx) {
    ctx.waitUntil(
      cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { "Cache-Control": "max-age=3000" } })),
    );
  }
  return { ok: true, ...data };
}

/** Fetch the dlink (with cookie + Referer + optional Range) and stream it back. */
async function streamFile(dlink, cookie, filename, cors, range, validate) {
  let host;
  try {
    host = new URL(dlink).hostname;
  } catch {
    return json({ error: "invalid dlink" }, 400, cors);
  }
  if (validate && !ALLOWED_DLINK_HOST.test(host)) {
    return json({ error: "url is not a TeraBox host" }, 400, cors);
  }

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: `https://${host.replace(/^[^.]+\./, "www.")}/`,
    Cookie: cookie,
    Accept: "*/*",
  };
  if (range) headers.Range = range;

  const upstream = await fetch(dlink, { headers, redirect: "follow" });
  if (upstream.status !== 200 && upstream.status !== 206) {
    let snippet = "";
    try {
      snippet = (await upstream.text()).slice(0, 400);
    } catch {
      // ignore
    }
    const diag = { stage: "download", upstreamStatus: upstream.status, upstreamUrl: upstream.url, bodySnippet: snippet };
    console.log("DOWNLOAD FAILED", JSON.stringify(diag));
    return json(diag, 200, cors);
  }

  const out = new Headers();
  for (const k of ["Content-Type", "Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (filename) out.set("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  out.set("Accept-Ranges", "bytes");
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Extract the 256-hex jsToken from the share page HTML (fn("…")). */
function extractToken(html) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(html);
  } catch {
    decoded = html;
  }
  const patterns = [
    /%28%22([0-9a-fA-F]{60,})%22%29/,
    /fn\("([0-9a-fA-F]{60,})"\)/,
    /"jsToken"\s*:\s*"([0-9a-fA-F]{60,})"/,
    /jsToken%22%3A%22([0-9a-fA-F]{60,})%22/,
  ];
  for (const p of patterns) {
    const m = html.match(p) || decoded.match(p);
    if (m && m[1]) return m[1];
  }
  return "";
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

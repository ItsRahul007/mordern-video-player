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
    const range = request.headers.get("Range");

    try {
      if (surl) {
        const id = surl.replace(/^1/, "");
        if (url.searchParams.get("list")) {
          const r = await resolveShare(env, id);
          if (!r.ok) return json(r, 200, cors);
          return json({ errno: 0, list: r.info.list }, 200, cors);
        }
        // Stream (download or watch): resolve a dlink (cached) and stream it.
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
  return { ok: true, origin, qp, apiH, info, files };
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

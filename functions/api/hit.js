/**
 * /api/hit — privacy-first pageview beacon.
 *
 * What it stores (in KV, keyed by UTC day):
 *   pv:<YYYY-MM-DD>            total pageviews that day
 *   vis:<YYYY-MM-DD>          "visits" (first hit of a browser session)
 *   ref:<YYYY-MM-DD>:<source> views bucketed by referrer source
 *
 * What it NEVER stores: IP addresses, cookies, user agents, fingerprints,
 * or anything that identifies a person. Source is coarse (e.g. "x", "google",
 * "direct"). This is a counter, not a tracker.
 */

const DAY_TTL = 60 * 60 * 24 * 120; // keep daily counters ~120 days

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Map a referrer hostname (or explicit ?r= hint) to a coarse source bucket.
function sourceFrom(refParam, referer) {
  const raw = (refParam || "").toLowerCase().trim();
  if (raw) {
    if (/(^|\.)x\.com|twitter/.test(raw)) return "x";
    if (/t\.me|telegram/.test(raw)) return "telegram";
    if (/facebook|fb\.com/.test(raw)) return "facebook";
    if (/reddit/.test(raw)) return "reddit";
    if (/google/.test(raw)) return "google";
    if (/bing|duckduckgo|search/.test(raw)) return "search";
    if (raw === "direct") return "direct";
  }
  if (!referer) return "direct";
  let host = "";
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return "direct"; }
  if (!host) return "direct";
  if (host.includes("freeandindependentnews")) return "internal";
  if (/(^|\.)x\.com$|twitter/.test(host)) return "x";
  if (host.includes("t.co")) return "x";
  if (host.includes("t.me") || host.includes("telegram")) return "telegram";
  if (host.includes("facebook") || host.includes("fb.com")) return "facebook";
  if (host.includes("reddit")) return "reddit";
  if (host.includes("google")) return "google";
  if (host.includes("bing") || host.includes("duckduckgo")) return "search";
  // fall back to the bare host so we still learn where reach comes from
  return host.replace(/^www\./, "");
}

async function bump(env, key) {
  const cur = parseInt((await env.FEEDS.get(key)) || "0", 10) || 0;
  await env.FEEDS.put(key, String(cur + 1), { expirationTtl: DAY_TTL });
}

async function handle(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.FEEDS) return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const day = utcDay();
  const isVisit = url.searchParams.get("v") === "1"; // first hit of a session
  const source = sourceFrom(url.searchParams.get("r"), request.headers.get("Referer"));

  try {
    await bump(env, "pv:" + day);
    if (isVisit) await bump(env, "vis:" + day);
    await bump(env, "ref:" + day + ":" + source);
  } catch (_) { /* never block the page over a counter */ }

  return new Response(null, { status: 204, headers: cors });
}

export const onRequestGet = (ctx) => handle(ctx.request, ctx.env);
export const onRequestPost = (ctx) => handle(ctx.request, ctx.env);
export const onRequestOptions = (ctx) => handle(ctx.request, ctx.env);

/**
 * /api/stats — returns the dashboard numbers.
 *
 *   traffic:  pageviews & visits per day (last 14d) + 7d/today totals
 *   referrers: top sources over the last 7 days
 *   articles: how many fresh items the desk's RSS voices published in the
 *             last 24h / 7d (counted live at the edge, cached ~30 min in KV)
 *
 * The article count is computed by fetching each voice's feed from the
 * Cloudflare edge (no CORS / no sandbox limits here) and counting <pubDate>s.
 */

const RSS_VOICES = [
  ["The Underground", "https://feeds.buzzsprout.com/868255.rss"],
  ["Glenn Greenwald", "https://greenwald.substack.com/feed"],
  ["Whitney Webb", "https://unlimitedhangout.com/feed/"],
  ["Aaron Maté", "https://mate.substack.com/feed"],
  ["Michael Yon", "https://michaelyon.substack.com/feed"],
  ["Consortium News", "https://consortiumnews.com/feed/"],
  ["Chris Hedges", "https://chrishedges.substack.com/feed"],
  ["The Grayzone", "https://thegrayzone.com/feed/"],
  ["Catherine Austin Fitts", "https://solari.com/feed/"]
];
const ART_CACHE_KEY = "artstats:v1";
const ART_CACHE_MIN = 30;

function utcDay(d) { return d.toISOString().slice(0, 10); }
function dayKeyN(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return utcDay(d); }

function parseDates(xml) {
  const out = [];
  const re = /<(?:pubDate|published|updated|dc:date)>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const t = Date.parse(m[1].trim());
    if (!isNaN(t)) out.push(t);
  }
  return out;
}

async function countOneFeed(url, now) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "FreeAndIndependentNewsAgent/1.0", "Accept": "application/rss+xml, application/xml, text/xml" },
      cf: { cacheTtl: 600 }
    });
    if (!r.ok) return null;
    const xml = await r.text();
    const dates = parseDates(xml);
    let d24 = 0, d7 = 0, newest = 0;
    for (const t of dates) {
      const ageH = (now - t) / 3600000;
      if (t > newest) newest = t;
      if (ageH <= 24) d24++;
      if (ageH <= 24 * 7) d7++;
    }
    return { d24, d7, newest, total: dates.length };
  } catch (_) { return null; }
}

async function computeArticleStats(env) {
  const now = Date.now();
  const settled = await Promise.all(RSS_VOICES.map(([name, url]) =>
    countOneFeed(url, now).then(res => ({ name, res }))
  ));
  let last24 = 0, last7 = 0;
  const perVoice = [];
  for (const { name, res } of settled) {
    if (!res) { perVoice.push({ name, error: true }); continue; }
    last24 += res.d24; last7 += res.d7;
    perVoice.push({
      name, last24: res.d24, last7: res.d7,
      newest: res.newest ? new Date(res.newest).toISOString() : null
    });
  }
  const payload = {
    last24, last7, perDayAvg7: Math.round((last7 / 7) * 10) / 10,
    voicesReporting: perVoice.filter(v => !v.error).length,
    voicesTotal: RSS_VOICES.length,
    perVoice, computedAt: new Date(now).toISOString()
  };
  try { await env.FEEDS.put(ART_CACHE_KEY, JSON.stringify(payload), { expirationTtl: 3600 }); } catch (_) {}
  return payload;
}

async function getArticleStats(env) {
  try {
    const cached = await env.FEEDS.get(ART_CACHE_KEY, "json");
    if (cached && cached.computedAt) {
      const ageMin = (Date.now() - Date.parse(cached.computedAt)) / 60000;
      if (ageMin < ART_CACHE_MIN) return { ...cached, cached: true };
    }
  } catch (_) {}
  return await computeArticleStats(env);
}

async function getTraffic(env) {
  const days = [];
  for (let n = 13; n >= 0; n--) days.push(dayKeyN(n));
  const series = [];
  for (const d of days) {
    const pv = parseInt((await env.FEEDS.get("pv:" + d)) || "0", 10) || 0;
    const vis = parseInt((await env.FEEDS.get("vis:" + d)) || "0", 10) || 0;
    series.push({ day: d, views: pv, visits: vis });
  }
  const today = series[series.length - 1] || { views: 0, visits: 0 };
  const last7 = series.slice(-7);
  const views7 = last7.reduce((a, b) => a + b.views, 0);
  const visits7 = last7.reduce((a, b) => a + b.visits, 0);

  // Referrers over the last 7 days.
  const refTotals = {};
  for (const d of days.slice(-7)) {
    let cursor, more = true;
    while (more) {
      const list = await env.FEEDS.list({ prefix: "ref:" + d + ":", cursor });
      for (const k of list.keys) {
        const src = k.name.split(":").slice(2).join(":");
        const n = parseInt((await env.FEEDS.get(k.name)) || "0", 10) || 0;
        refTotals[src] = (refTotals[src] || 0) + n;
      }
      cursor = list.cursor; more = !list.list_complete;
    }
  }
  const referrers = Object.entries(refTotals).sort((a, b) => b[1] - a[1])
    .slice(0, 8).map(([source, views]) => ({ source, views }));

  return {
    today: { views: today.views, visits: today.visits },
    last7: { views: views7, visits: visits7 },
    series, referrers,
    hasData: views7 > 0 || today.views > 0
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=120"
  };
  if (!env.FEEDS) {
    return new Response(JSON.stringify({ error: "KV binding FEEDS missing" }), { status: 500, headers: cors });
  }
  const [traffic, articles] = await Promise.all([getTraffic(env), getArticleStats(env)]);
  return new Response(JSON.stringify({ traffic, articles, generatedAt: new Date().toISOString() }, null, 2), { headers: cors });
}

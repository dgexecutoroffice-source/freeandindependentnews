/**
 * /api/world — live international wire for the East and West rails.
 *
 * Fetches a small set of world-news RSS feeds at the Cloudflare edge (no CORS /
 * no sandbox limits here), parses the latest items, merges + sorts each side by
 * recency, and caches the result in KV (~15 min) so we don't hammer sources.
 *
 * Returns: { east: [{source,title,link,pubDate}], west: [...], generatedAt }
 */

const EAST = [
  ["Al Jazeera",      "https://www.aljazeera.com/xml/rss/all.xml"],
  ["TASS",            "https://tass.com/rss/v2.xml"],
  ["Press TV",        "https://www.presstv.ir/rss.xml"],
  ["Middle East Eye", "https://www.middleeasteye.net/rss"],
  ["Global Times",    "https://www.globaltimes.cn/rss/outbrain.xml"]
];
const WEST = [
  ["BBC World",    "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["The Guardian", "https://www.theguardian.com/world/rss"],
  ["France 24",    "https://www.france24.com/en/rss"],
  ["DW",           "https://rss.dw.com/rdf/rss-en-all"]
];
const CACHE_KEY = "world:v1";
const CACHE_MIN = 15;
const PER_FEED = 4;   // newest items to take from each feed
const PER_SIDE = 8;   // cap per rail after merge
const UA = "FreeAndIndependentNewsAgent/1.0 (+https://freeandindependentnews.com)";

function stripCDATA(s){ return (s||"").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim(); }
function stripHTML(s){ return (s||"").replace(/<[^>]+>/g," ").replace(/&[a-z]+;/gi," ").replace(/\s+/g," ").trim(); }
function tag(xml, name){
  const re = new RegExp("<"+name+"\\b[^>]*>([\\s\\S]*?)<\\/"+name+">","i");
  const m = xml.match(re); return m ? stripCDATA(m[1].trim()) : "";
}
function atomHref(xml){
  const m = xml.match(/<link\b[^>]*href=["']([^"']+)["']/i); return m ? m[1] : "";
}

function parseItems(xml, limit){
  const out = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks){
    const title = stripHTML(tag(b,"title"));
    let link = stripCDATA(tag(b,"link")) || atomHref(b);
    const pub = tag(b,"pubDate") || tag(b,"dc:date") || tag(b,"published") || tag(b,"updated");
    if (!title || !link) continue;
    const t = Date.parse(pub);
    out.push({ title, link, pubDate: pub, ts: isNaN(t) ? 0 : t });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchFeed(source, url){
  try{
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: 600 } });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseItems(xml, PER_FEED).map(it => ({ source, ...it }));
  } catch(_){ return []; }
}

async function buildSide(list){
  const settled = await Promise.all(list.map(([s,u]) => fetchFeed(s,u)));
  const all = settled.flat();
  all.sort((a,b) => b.ts - a.ts);
  const seen = new Set();
  const merged = [];
  for (const it of all){
    const key = it.title.toLowerCase().slice(0,60);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ source: it.source, title: it.title, link: it.link, pubDate: it.pubDate });
    if (merged.length >= PER_SIDE) break;
  }
  return merged;
}

async function compute(env){
  const [east, west] = await Promise.all([buildSide(EAST), buildSide(WEST)]);
  const payload = { east, west, generatedAt: new Date().toISOString() };
  try { await env.FEEDS.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: 1800 }); } catch(_){}
  return payload;
}

export async function onRequestGet(context){
  const { env } = context;
  const cors = { "Access-Control-Allow-Origin":"*", "Content-Type":"application/json", "Cache-Control":"public, max-age=300" };
  if (env.FEEDS){
    try{
      const cached = await env.FEEDS.get(CACHE_KEY, "json");
      if (cached && cached.generatedAt){
        const ageMin = (Date.now() - Date.parse(cached.generatedAt)) / 60000;
        if (ageMin < CACHE_MIN) return new Response(JSON.stringify({ ...cached, cached:true }), { headers: cors });
      }
    }catch(_){}
  }
  const payload = await compute(env);
  return new Response(JSON.stringify(payload), { headers: cors });
}

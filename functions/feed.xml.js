/**
 * /feed.xml — a real RSS feed for the whole desk, so readers can subscribe.
 * Pulls each voice's feed at the edge, takes the freshest items, merges +
 * sorts by date, caches ~15 min in KV, and emits valid RSS 2.0.
 */

const VOICES = [
  ["The Underground",        "https://feeds.buzzsprout.com/868255.rss"],
  ["Glenn Greenwald",        "https://greenwald.substack.com/feed"],
  ["Whitney Webb",           "https://unlimitedhangout.com/feed/"],
  ["Aaron Maté",             "https://mate.substack.com/feed"],
  ["Michael Yon",            "https://michaelyon.substack.com/feed"],
  ["Consortium News",        "https://consortiumnews.com/feed/"],
  ["Chris Hedges",           "https://chrishedges.substack.com/feed"],
  ["The Grayzone",           "https://thegrayzone.com/feed/"],
  ["Catherine Austin Fitts", "https://solari.com/feed/"]
];
const CACHE_KEY = "sitefeed:v1";
const CACHE_MIN = 15;
const PER_FEED = 3;
const MAX_ITEMS = 25;
const UA = "FreeAndIndependentNewsAgent/1.0 (+https://freeandindependentnews.com)";

function stripCDATA(s){ return (s||"").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim(); }
function stripHTML(s){ return (s||"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\s+/g," ").trim(); }
function tag(xml,name){ const m=xml.match(new RegExp("<"+name+"\\b[^>]*>([\\s\\S]*?)<\\/"+name+">","i")); return m?stripCDATA(m[1].trim()):""; }
function atomHref(xml){ const m=xml.match(/<link\b[^>]*href=["']([^"']+)["']/i); return m?m[1]:""; }
function xmlEsc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }

function parse(xml, source, limit){
  const out=[]; const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks){
    const title=stripHTML(tag(b,"title"));
    let link=stripCDATA(tag(b,"link"))||atomHref(b);
    const pub=tag(b,"pubDate")||tag(b,"dc:date")||tag(b,"published")||tag(b,"updated");
    let desc=stripHTML(tag(b,"description")||tag(b,"summary")||tag(b,"content:encoded")).slice(0,300);
    if(!title||!link) continue;
    const t=Date.parse(pub);
    out.push({ source, title, link, desc, ts:isNaN(t)?0:t, pub });
    if(out.length>=limit) break;
  }
  return out;
}

async function build(env){
  const settled = await Promise.all(VOICES.map(async ([s,u])=>{
    try{ const r=await fetch(u,{headers:{"User-Agent":UA,"Accept":"application/rss+xml, application/xml, text/xml"},cf:{cacheTtl:600}}); if(!r.ok) return []; return parse(await r.text(), s, PER_FEED); }
    catch(_){ return []; }
  }));
  const all=settled.flat().sort((a,b)=>b.ts-a.ts).slice(0,MAX_ITEMS);
  const now=new Date().toUTCString();
  const items=all.map(it=>{
    const date = it.ts ? new Date(it.ts).toUTCString() : now;
    return "    <item>\n"+
      "      <title>"+xmlEsc(it.source+": "+it.title)+"</title>\n"+
      "      <link>"+xmlEsc(it.link)+"</link>\n"+
      "      <guid isPermaLink=\"true\">"+xmlEsc(it.link)+"</guid>\n"+
      "      <dc:creator>"+xmlEsc(it.source)+"</dc:creator>\n"+
      "      <pubDate>"+date+"</pubDate>\n"+
      (it.desc?"      <description>"+xmlEsc(it.desc)+"</description>\n":"")+
      "    </item>";
  }).join("\n");
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">\n'+
    '  <channel>\n'+
    '    <title>Free and Independent News — The Desk</title>\n'+
    '    <link>https://freeandindependentnews.com/</link>\n'+
    '    <atom:link href="https://freeandindependentnews.com/feed.xml" rel="self" type="application/rss+xml"/>\n'+
    '    <description>A dozen independent voices, plus the East and West international wire. No algorithm.</description>\n'+
    '    <language>en</language>\n'+
    '    <lastBuildDate>'+now+'</lastBuildDate>\n'+
    items+'\n'+
    '  </channel>\n</rss>\n';
  try{ await env.FEEDS.put(CACHE_KEY, xml, { expirationTtl: 1800 }); await env.FEEDS.put(CACHE_KEY+":at", String(Date.now()), { expirationTtl: 1800 }); }catch(_){}
  return xml;
}

export async function onRequestGet(context){
  const { env } = context;
  const headers = { "Content-Type":"application/rss+xml; charset=utf-8", "Cache-Control":"public, max-age=600" };
  if (env.FEEDS){
    try{
      const at=parseInt(await env.FEEDS.get(CACHE_KEY+":at")||"0",10);
      if(at && (Date.now()-at)/60000 < CACHE_MIN){
        const cached=await env.FEEDS.get(CACHE_KEY);
        if(cached) return new Response(cached,{headers});
      }
    }catch(_){}
  }
  const xml = await build(env);
  return new Response(xml,{headers});
}

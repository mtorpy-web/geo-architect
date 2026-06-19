// api/audit.js  —  GEO Architect: single-file Vercel serverless function (v0.3.1).
// POST { "url": "https://any-business.com" }  -> crawls the site, derives
// name/location/services, runs SearchApi.io (local pack + organic + AI Overview)
// AND PageSpeed Insights (Core Web Vitals), returns an honesty-tagged DataBundle.
// Keys read from env, never returned. Zero dependencies. Node 18+ (global fetch).

export const config = { maxDuration: 60 }; // PageSpeed Lighthouse runs can be slow

const HONESTY = { VERIFIED: "VERIFIED", ASSUMED: "ASSUMED" };
const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/* ---------------- helpers: crawl ---------------- */
function domainOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}
const stripTags = (s) => (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) => (s || "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g," ").trim();
function typeToTerm(t){ if(!t||typeof t!=="string")return null; const g=new Set(["organization","localbusiness","corporation","thing","website","webpage"]); const term=t.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/[_-]+/g," ").toLowerCase().trim(); return g.has(term.replace(/\s/g,""))?null:term; }
function collectJsonLd(html){ const nodes=[]; const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m; while((m=re.exec(html))){ try{ const data=JSON.parse(m[1].trim()); const visit=(n)=>{ if(!n||typeof n!=="object")return; if(Array.isArray(n))return n.forEach(visit); nodes.push(n); if(n["@graph"])visit(n["@graph"]); }; visit(data);}catch{} } return nodes; }
const typesOf=(n)=>{ const t=n["@type"]; return (Array.isArray(t)?t:[t]).filter(Boolean).map(String); };
function deriveIdentityFromSchema(nodes){
  const isBiz=(n)=>typesOf(n).some((t)=>/organization|localbusiness|business|store|dentist|physician|clinic|hospital|legalservice|attorney|lawfirm|contractor|restaurant|service|medicalbusiness|professionalservice|homeandconstruction/i.test(t))||n.address||n.telephone;
  const biz=nodes.find(isBiz); if(!biz)return {};
  let location=null; const addr=Array.isArray(biz.address)?biz.address[0]:biz.address;
  if(addr&&typeof addr==="object"){ location=[addr.addressLocality,addr.addressRegion].filter(Boolean).join(", ")||null; }
  const services=[]; const offers=biz.makesOffer||biz.hasOfferCatalog?.itemListElement||biz.hasOfferCatalog||[]; const arr=Array.isArray(offers)?offers:[offers];
  for(const o of arr){ const name=o?.itemOffered?.name||o?.name||o?.item?.name; if(name)services.push(String(name)); }
  const industry=typesOf(biz).map(typeToTerm).find(Boolean)||null;
  return { name: biz.name?String(biz.name):null, location, services: services.slice(0,8), industry,
    source:{ name: biz.name?"schema":null, location: location?"schema":null, services: services.length?"schema":null } };
}
function parseSite(html, url){
  const domain=domainOf(url); const get=(re)=>{ const m=re.exec(html); return m?decode(m[1]):null; };
  const title=get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogSiteName=get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  const metaDesc=get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)||get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const grab=(tag)=>{ const out=[]; const re=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,"gi"); let m; while((m=re.exec(html))){ const t=decode(stripTags(m[1])); if(t)out.push(t); } return out; };
  const h1=grab("h1"), h2=grab("h2");
  const images=[]; { const re=/<img[^>]+src=["']([^"']+)["']/gi; let m; while((m=re.exec(html))){ const f=m[1].split("?")[0].split("/").pop(); if(f)images.push(f); } }
  const jsonld=collectJsonLd(html); const schemaTypes=[...new Set(jsonld.flatMap(typesOf))];
  const text=stripTags(html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")); const wordCount=text?text.split(/\s+/).length:0;
  const schemaId=deriveIdentityFromSchema(jsonld);
  const cleanTitle=title?title.split(/[|\u2013\u2014\-:]/)[0].trim():null;
  const name=schemaId.name||ogSiteName||cleanTitle||h1[0]||null;
  let services=schemaId.services?.length?schemaId.services:[]; if(!services.length&&schemaId.industry)services=[schemaId.industry];
  const identity={ domain, name, location: schemaId.location||null, services, industry: schemaId.industry||null,
    source:{ name: schemaId.source?.name||(ogSiteName?"og":cleanTitle?"title":h1[0]?"h1":null), location: schemaId.source?.location||null, services: schemaId.source?.services||(services.length?"type":null) } };
  const crawl={ available:true, url, title, metaDescription: metaDesc, h1, h2, headingCount:h1.length+h2.length, schemaTypes,
    hasLocalBusinessSchema: schemaTypes.some((t)=>/localbusiness|dentist|legalservice|clinic|restaurant|store|contractor|physician/i.test(t)),
    imageFilenames: images.slice(0,40), wordCount };
  return { crawl, identity };
}
async function fetchHtml(url,{signal,timeoutMs=12000}={}){
  const target=/^https?:\/\//i.test(url)?url:`https://${url}`;
  const ctrl=signal?null:new AbortController(); const t=ctrl?setTimeout(()=>ctrl.abort(),timeoutMs):null;
  try{ const res=await fetch(target,{headers:{"User-Agent":"GEOArchitectBot/0.3 (+audit)",Accept:"text/html,*/*"},redirect:"follow",signal:signal||ctrl.signal});
    if(!res.ok)throw new Error(`crawl HTTP ${res.status}`); const html=await res.text(); return { finalUrl: res.url||target, html }; }
  finally{ if(t)clearTimeout(t); }
}

/* ---------------- helpers: SearchApi ---------------- */
async function searchapi(engine, params, { apiKey, signal }){
  if(!apiKey) throw new Error("SEARCHAPI_KEY is not set");
  const url=new URL(SEARCHAPI_BASE); url.searchParams.set("engine",engine);
  for(const [k,v] of Object.entries(params)){ if(v!==undefined&&v!==null&&v!=="")url.searchParams.set(k,String(v)); }
  const res=await fetch(url,{headers:{Authorization:`Bearer ${apiKey}`,Accept:"application/json"},signal});
  if(!res.ok) throw new Error(`SearchApi ${engine} HTTP ${res.status}`);
  const json=await res.json(); const status=json?.search_metadata?.status;
  if(status&&status!=="Success") throw new Error(`SearchApi ${engine} status: ${status}`);
  return json;
}
async function getGoogleResults({q,apiKey,signal}){
  const googleJson=await searchapi("google",{q,gl:"us",hl:"en"},{apiKey,signal});
  let aiOverviewJson=null; const token=googleJson?.ai_overview?.page_token; const has=googleJson?.ai_overview?.text_blocks?.length;
  if(token&&!has){ try{ aiOverviewJson=await searchapi("google_ai_overview",{page_token:token},{apiKey,signal}); }catch{ aiOverviewJson=null; } }
  return { googleJson, aiOverviewJson };
}
const getLocalResults=({q,apiKey,signal})=>searchapi("google_local",{q,gl:"us",hl:"en"},{apiKey,signal});

/* ---------------- helpers: PageSpeed Insights ---------------- */
function normalizePageSpeed(json, strategy="mobile"){
  const lr=json?.lighthouseResult; if(!lr) return { available:false };
  const cat=lr.categories||{}; const a=lr.audits||{};
  const pct=(s)=> typeof s==="number" ? Math.round(s*100) : null;
  const lab={
    performanceScore: pct(cat.performance?.score), seoScore: pct(cat.seo?.score),
    lcpMs: a["largest-contentful-paint"]?.numericValue??null, lcpDisplay: a["largest-contentful-paint"]?.displayValue??null,
    cls: a["cumulative-layout-shift"]?.numericValue??null, clsDisplay: a["cumulative-layout-shift"]?.displayValue??null,
    tbtDisplay: a["total-blocking-time"]?.displayValue??null, fcpDisplay: a["first-contentful-paint"]?.displayValue??null,
    speedIndexDisplay: a["speed-index"]?.displayValue??null
  };
  const le=json.loadingExperience||json.originLoadingExperience||null; const m=le?.metrics||{};
  const field=(le && Object.keys(m).length) ? {
    hasData:true, overall: le.overall_category||null,
    lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile??null, lcpCategory: m.LARGEST_CONTENTFUL_PAINT_MS?.category??null,
    inpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile??null, inpCategory: m.INTERACTION_TO_NEXT_PAINT?.category??null,
    cls: (m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile!=null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile/100 : null),

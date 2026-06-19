// api/audit.js  —  GEO Architect: single-file Vercel serverless function (v0.3).
// POST { "url": "https://any-business.com" }  -> crawls the site, derives
// name/location/services, runs SearchApi.io (local pack + organic + AI Overview)
// AND PageSpeed Insights (Core Web Vitals), returns an honesty-tagged DataBundle.
// Keys read from env, never returned. Zero dependencies. Node 18+ (global fetch).

export const config = { maxDuration: 90 }; // PageSpeed Lighthouse runs can be slow

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
    cls: (m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile!=null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile/100 : null), clsCategory: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category??null
  } : { hasData:false };
  return { available:true, strategy, lab, field };
}
async function getPageSpeed(url,{apiKey,signal}={}){
  const ctrl=signal?null:new AbortController(); const t=ctrl?setTimeout(()=>ctrl.abort(),45000):null;
  try{
    const u=new URL(PSI_BASE);
    u.searchParams.set("url", /^https?:\/\//i.test(url)?url:`https://${url}`);
    u.searchParams.set("strategy","mobile");
    u.searchParams.append("category","PERFORMANCE"); u.searchParams.append("category","SEO");
    if(apiKey) u.searchParams.set("key",apiKey);
    const res=await fetch(u,{signal:signal||ctrl.signal,headers:{Accept:"application/json"}});
    if(!res.ok) throw new Error(`PageSpeed HTTP ${res.status}`);
    const json=await res.json();
    return normalizePageSpeed(json,"mobile");
  } finally { if(t)clearTimeout(t); }
}

/* ---------------- helpers: normalize + bundle ---------------- */
const sameDomain=(c,cl)=>!c||!cl?false:(c===cl||c.endsWith("."+cl)||cl.endsWith("."+c));
function normalizeOrganic(j){ const r=j?.organic_results; if(!Array.isArray(r))return []; return r.map((x)=>({position:x.position??null,title:x.title??null,link:x.link??null,domain:domainOf(x.link)||(x.domain?x.domain.replace(/^www\./,""):null),snippet:x.snippet??null})).filter((x)=>x.title||x.link); }
function normalizeLocal(j){ const r=j?.local_results; if(!Array.isArray(r))return []; return r.map((x)=>({position:x.position??null,title:x.title??null,domain:domainOf(x.website||x.link),rating:x.rating??null,reviews:x.reviews??null,address:x.address??null,type:x.type??null})); }
function normalizeAiOverview(g,a,client){ const src=a?.ai_overview||g?.ai_overview||null; const refsRaw=src?.reference_links||src?.references||[]; const references=(Array.isArray(refsRaw)?refsRaw:[]).map((r)=>({title:r.title??null,link:r.link??null,domain:domainOf(r.link)||(r.domain||r.source||null)})); const hasBody=!!(src&&(src.text_blocks?.length||references.length)); const citesClient=client?references.some((r)=>sameDomain(r.domain,client)):false; return { present:hasBody, citesClient, references }; }
function buildSerpSlice({googleJson,localJson,aiOverviewJson,clientDomain}){
  const organic=normalizeOrganic(googleJson), localPack=normalizeLocal(localJson), ai=normalizeAiOverview(googleJson,aiOverviewJson,clientDomain);
  const competitors=[], seen=new Set();
  for(const l of localPack){ if(clientDomain&&sameDomain(l.domain,clientDomain))continue; const k=(l.title||l.domain||"").toLowerCase(); if(!k||seen.has(k))continue; seen.add(k); competitors.push({name:l.title,domain:l.domain,source:"local_pack",position:l.position}); }
  for(const o of organic.slice(0,5)){ if(clientDomain&&sameDomain(o.domain,clientDomain))continue; const k=(o.domain||o.title||"").toLowerCase(); if(!k||seen.has(k))continue; seen.add(k); competitors.push({name:o.title,domain:o.domain,source:"organic",position:o.position}); }
  return { available:true, query: googleJson?.search_metadata?.request_url||null, localPack, organic,
    aiOverviewPresent: ai.present, aiOverviewCitesClient: ai.citesClient, aiOverviewReferences: ai.references,
    competitors: competitors.slice(0,10),
    clientOrganicPosition: clientDomain?(organic.find((o)=>sameDomain(o.domain,clientDomain))?.position??null):null,
    clientLocalPosition: clientDomain?(localPack.find((l)=>sameDomain(l.domain,clientDomain))?.position??null):null };
}
function deriveQueries(meta){ const service=(meta.services&&meta.services[0])||meta.industry||"services"; const location=(meta.locations&&meta.locations[0])||""; const inLoc=location?` in ${location}`:""; return { local:`${service}${inLoc}`.trim(), web:`best ${service}${inLoc}`.trim(), location }; }
function buildDataBundle(meta,{crawl,serp,pagespeed}){
  const bundle={ meta:{ businessName:meta.businessName??null, website:meta.website??null, domain:meta.domain??null, locations:meta.locations??[], services:meta.services??[], industry:meta.industry??null, detected:meta.detected??{} },
    crawl: crawl||{available:false}, serp: serp||{available:false}, pagespeed: pagespeed||{available:false},
    backlinks:{available:false}, youtube:{available:false}, aiEngines:{available:false}, gsc:{available:false}, gbp:{available:false} };
  const c=bundle.crawl.available, s=bundle.serp.available, p=bundle.pagespeed.available;
  bundle.honesty={ crawl:c?HONESTY.VERIFIED:HONESTY.ASSUMED, serp:s?HONESTY.VERIFIED:HONESTY.ASSUMED, aiOverview:s?HONESTY.VERIFIED:HONESTY.ASSUMED, pagespeed:p?HONESTY.VERIFIED:HONESTY.ASSUMED, aiEngines:HONESTY.ASSUMED, backlinks:HONESTY.ASSUMED, youtube:HONESTY.ASSUMED, gsc:HONESTY.ASSUMED, gbp:HONESTY.ASSUMED };
  return bundle;
}

/* ---------------- orchestrator ---------------- */
async function runAudit(body,{apiKey}={}){
  const overrides=body.overrides||{}; const warnings=[];
  let crawl={available:false}, identity={};
  try{ const {html,finalUrl}=await fetchHtml(body.url); const p=parseSite(html,finalUrl); crawl=p.crawl; identity=p.identity; }
  catch(e){ warnings.push(`crawl: ${e?.message||"failed"}`); identity={domain:null}; }
  const businessName=overrides.businessName||identity.name||null;
  const location=overrides.location||identity.location||null;
  const services=Array.isArray(overrides.services)&&overrides.services.length?overrides.services:overrides.service?[overrides.service]:identity.services?.length?identity.services:[];
  const industry=overrides.industry||identity.industry||null;
  const primaryService=services[0]||industry||null;
  const meta={ businessName, website:body.url, domain:identity.domain, locations:location?[location]:[], services, industry, detected:identity.source||{} };
  const needsInput=[]; if(!location)needsInput.push("location"); if(!primaryService)needsInput.push("service");

  // Fan out: PageSpeed always (URL only); SERP only when we know what + where.
  const psiUrl=(crawl.available&&crawl.url)?crawl.url:body.url;
  const runSerp=!!(location&&primaryService);
  const q=runSerp?deriveQueries({services,industry,locations:[location]}):null;
  const clientDomain=identity.domain;
  const tasks=[ getPageSpeed(psiUrl,{apiKey:process.env.PAGESPEED_API_KEY}) ];
  if(runSerp){ tasks.push(getGoogleResults({q:q.web,apiKey}), getLocalResults({q:q.local,apiKey})); }
  const settled=await Promise.allSettled(tasks);

  const psiRes=settled[0];
  let pagespeed = psiRes.status==="fulfilled" ? psiRes.value : {available:false};
  if(psiRes.status==="rejected") warnings.push(`pagespeed: ${psiRes.reason?.message||"failed"}`);

  let serp={available:false};
  if(runSerp){
    const g=settled[1], l=settled[2];
    if(g.status==="fulfilled"||l.status==="fulfilled"){ serp=buildSerpSlice({ googleJson:g.status==="fulfilled"?g.value.googleJson:null, aiOverviewJson:g.status==="fulfilled"?g.value.aiOverviewJson:null, localJson:l.status==="fulfilled"?l.value:null, clientDomain }); }
    if(g.status==="rejected")warnings.push(`google: ${g.reason?.message||"failed"}`);
    if(l.status==="rejected")warnings.push(`google_local: ${l.reason?.message||"failed"}`);
  }

  const bundle=buildDataBundle(meta,{crawl,serp,pagespeed});
  return { meta, bundle, generatedAt:new Date().toISOString(), warnings, needsInput };
}

/* ---------------- Vercel handler ---------------- */
export default async function handler(req, res){
  res.setHeader("Cache-Control","no-store");
  if(req.method==="GET"){
    return res.status(200).json({ service:"GEO Architect /api/audit", version:"0.3.1", method:"POST", body:{ url:"https://any-business.com", overrides:{ location:"City, ST (optional)", service:"optional" } }, searchApiKey: Boolean(process.env.SEARCHAPI_KEY), pageSpeedKey: Boolean(process.env.PAGESPEED_API_KEY), keyConfigured: Boolean(process.env.SEARCHAPI_KEY) });
  }
  if(req.method!=="POST") return res.status(405).json({ error:"Use POST with a JSON body { \"url\": \"...\" }" });
  if(!process.env.SEARCHAPI_KEY) return res.status(500).json({ error:"SEARCHAPI_KEY is not configured. Add it in Vercel → Settings → Environment Variables." });
  let body=req.body; if(typeof body==="string"){ try{ body=JSON.parse(body); }catch{ return res.status(400).json({ error:"Body must be valid JSON." }); } }
  if(!body||typeof body!=="object"||!body.url) return res.status(400).json({ error:"Provide a JSON body like { \"url\": \"https://example.com\" }" });
  try{
    const result=await runAudit(body,{ apiKey: process.env.SEARCHAPI_KEY });
    if(!result.bundle.crawl.available && !result.bundle.serp.available && !result.bundle.pagespeed.available) return res.status(502).json({ error:"Could not read that website.", warnings: result.warnings });
    if(result.needsInput.length) return res.status(200).json({ status:"needs_input", message:`Crawled the site, but couldn't auto-detect: ${result.needsInput.join(" and ")}. Re-send with overrides.`, needsInput: result.needsInput, detected: result.meta, bundle: result.bundle });
    return res.status(200).json(result);
  }catch(err){ return res.status(500).json({ error:"Unexpected error.", detail: err?.message }); }
}

export { parseSite, buildSerpSlice, buildDataBundle, deriveQueries, runAudit, normalizePageSpeed };

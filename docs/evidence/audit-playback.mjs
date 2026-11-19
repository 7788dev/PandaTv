// Read-only public CMS/HLS sampling. No credentials, media downloads, or source configuration writes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = new URL('./', import.meta.url);
const configPath = process.argv[2] ?? 'E:/dev/项目/见界/src-tauri/resources/play-sources.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const results = [];
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const sha = text => createHash('sha256').update(text).digest('hex');
async function request(url, cap = 3 * 1024 * 1024, range = false) {
  const started = performance.now();
  const response = await fetch(url, {signal: AbortSignal.timeout(10000), headers: {'User-Agent': userAgent, 'Referer': new URL('/',url).href, ...(range ? {'Range':'bytes=0-131071'} : {})}});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const {done,value} = await reader.read(); if (done) break;
    chunks.push(Buffer.from(value.subarray(0, cap-size))); size += Math.min(value.length, cap-size);
    if (size >= cap) { await reader.cancel(); break; }
  }
  return {body:Buffer.concat(chunks), url:response.url, status:response.status, ms:Math.round(performance.now()-started), type:response.headers.get('content-type')};
}
async function api(source,params) {
  const url = new URL(source.api); Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  const r = await request(url); return {json:JSON.parse(r.body.toString()), ms:r.ms};
}
const plain = s => String(s??'').replace(/<[^>]*>|\s/g,'');
function parse(text,base) {
  const lines = text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const segments = []; let duration=0; let block=0; let marker=false;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) duration=Number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-DISCONTINUITY') block++;
    else if (line.startsWith('# ppvod-ad-injected')) marker=true;
    else if (!line.startsWith('#')) { const url = new URL(line,base); segments.push({url:url.href,duration,block,path:url.pathname,host:url.hostname}); duration=0; }
  }
  return {lines,segments,marker};
}
function matchesFingerprint(segments,fingerprint,tolerance) {
  const found=[];
  for(let i=0;i<=segments.length-fingerprint.length;i++) if(fingerprint.every((n,k)=>Math.abs(n-segments[i+k].duration)<=tolerance)) found.push(i);
  return found;
}
async function inspect(source,raw,key) {
  let url=raw; let masterMs; let width; let height;
  for(let depth=0;depth<4;depth++) {
    const r=await request(url); const text=r.body.toString().trimStart();
    if(!text.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
    if(!masterMs) masterMs=r.ms;
    const {lines,segments,marker}=parse(text,r.url);
    const variant=lines.findIndex(x=>x.startsWith('#EXT-X-STREAM-INF'));
    if(variant>=0) { const res=/RESOLUTION=(\d+)x(\d+)/.exec(lines[variant]); width=Number(res?.[1])||undefined; height=Number(res?.[2])||undefined; url=new URL(lines[variant+1],r.url).href; continue; }
    const duration=segments.reduce((n,s)=>n+s.duration,0);
    const pathKeywords=['ad','ads','adv','advert','gg','guanggao','sponsor','promo','adjump'];
    const keywordHits=Object.fromEntries(pathKeywords.map(k=>[k,segments.filter(s=>s.path.toLowerCase().split(/[^a-z0-9]+/).includes(k)).length]));
    const fingerprints=(source.adRules?.adDurationFingerprints??[]).map(fp=>({sequence:fp,matches:matchesFingerprint(segments,fp,source.adRules.adDurationTolerance??0.15)}));
    const sampled=[];
    for(const index of [...new Set([0,Math.floor(segments.length/2),segments.length-1])]) {
      const s=segments[index]; if(!s) continue;
      try { const part=await request(s.url,128*1024,true); sampled.push({index,ok:true,status:part.status,bytes:part.body.length,ms:part.ms,host:new URL(part.url).host,signature:part.body.subarray(0,8).toString('hex'),sha256:sha(part.body)}); }
      catch(e) { sampled.push({index,ok:false,error:e.message}); }
    }
    const sanitized=lines.map(line=>line.startsWith('#') ? line.replace(/URI="([^"]+)"/g,(_,u)=>{const x=new URL(u,r.url);x.search='';return `URI="${x.href}"`;}) : (()=>{const x=new URL(line,r.url);x.search='';return x.href;})()).join('\n');
    await writeFile(new URL(`manifest-${key}.m3u8`,dir),sanitized+'\n');
    return {masterMs,playlistMs:r.ms,host:new URL(r.url).hostname,width,height,segments:segments.length,duration:Number(duration.toFixed(3)),encrypted:lines.some(x=>x.startsWith('#EXT-X-KEY:')&&!x.includes('METHOD=NONE')),endlist:lines.includes('#EXT-X-ENDLIST'),discontinuities:lines.filter(x=>x==='#EXT-X-DISCONTINUITY').length,ppvodMarker:marker,cueOut:lines.filter(x=>x.startsWith('#EXT-X-CUE-OUT')).length,keywordHits,fingerprints,hosts:[...new Set(segments.map(s=>s.host))],sha256:sha(text),sampled,manifest:`manifest-${key}.m3u8`};
  }
  throw new Error('Manifest nesting exceeds audit limit');
}
async function sample(source) {
  const result={key:source.key,name:source.name,enabled:source.enabled,api:source.api,checkedAt:new Date().toISOString(),queries:[]};
  for(const query of ['流浪地球2','凡人修仙传']) {
    const item={query};
    try {
      const r=await api(source,{ac:'videolist',wd:query,pg:'1'}); const rows=r.json.list??[];
      item.searchMs=r.ms; item.returned=rows.length; item.relevant=rows.filter(x=>plain(x.vod_name).includes(plain(query))).length;
      const row=rows.find(x=>plain(x.vod_name)===plain(query))??rows.find(x=>plain(x.vod_name).includes(plain(query)));
      if(!row) throw new Error('No relevant search match');
      const detail=await api(source,{ac:'videolist',ids:String(row.vod_id)});
      const exact=(detail.json.list??[]).find(x=>String(x.vod_id)===String(row.vod_id));
      if(!exact) throw new Error('Detail did not return requested ID');
      item.title=exact.vod_name;item.year=exact.vod_year;item.vodId=exact.vod_id;
      const lines=String(exact.vod_play_url??'').split('$$$').map((value,i)=>({name:String(exact.vod_play_from??'').split('$$$')[i],entries:value.split('#').map(x=>x.slice(x.indexOf('$')+1)).filter(x=>/^https?:\/\//.test(x)&&/\.m3u8(?:\?|$)/i.test(x))}));
      item.lines=lines.map(x=>({name:x.name,episodes:x.entries.length}));
      const playable=lines.find(x=>x.entries.length); if(!playable) throw new Error('No direct HLS line');
      item.media=await inspect(source,playable.entries[0],`${source.key}-${result.queries.length}`);item.ok=item.media.sampled.some(x=>x.ok);
      if(playable.entries[1]) { try { const next=await request(playable.entries[1]);item.nextEpisode={ok:next.body.toString().trimStart().startsWith('#EXTM3U'),status:next.status,ms:next.ms}; } catch(e) {item.nextEpisode={ok:false,error:e.message};} }
    } catch(e) {item.ok=false;item.error=e.message;}
    result.queries.push(item);
  }
  results.push(result);await writeFile(new URL('playback-audit.json',dir),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
  console.log(`${source.key}: ${result.queries.map(x=>`${x.query} ${x.ok?'OK':x.error??'segments unavailable'}`).join('; ')}`);
}
await mkdir(dir,{recursive:true});
for(let i=0;i<config.sources.length;i+=3) await Promise.allSettled(config.sources.slice(i,i+3).map(sample));

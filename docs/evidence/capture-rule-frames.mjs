import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = new URL('./', import.meta.url);
const detect=spawnSync('python',['-c','import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],{encoding:'utf8'});
const ffmpeg=process.env.FFMPEG_PATH??detect.stdout.trim();
for(const [name,needle] of [['ffzy-0','4.866667'],['ffzy-0-second','6.033333'],['ffzy-1','4.866667'],['dyttzy-1','5.567'],['lzi-0','ppvod'],['bfzy-0','adjump']]) {
  const baseName=name.replace('-second','');
  const lines=(await readFile(new URL(`manifest-${baseName}.m3u8`,dir),'utf8')).split('\n');
  let at=lines.findIndex(x=>x.includes(needle));
  while(at<lines.length&&!lines[at].startsWith('http')) at++;
  if(at===lines.length) continue;
  const response=await fetch(lines[at],{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Mozilla/5.0','Referer':new URL('/',lines[at]).href}});
  if(!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const frame=fileURLToPath(new URL(`rule-frame-${name}.jpg`,dir));
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i','pipe:0','-ss','1','-frames:v','1','-vf','scale=640:-2','-y',frame],{input:bytes,encoding:'utf8',maxBuffer:2*1024*1024});
  console.log(`${name}: ${r.status===0?'frame captured':r.stderr.slice(0,200)}`);
}

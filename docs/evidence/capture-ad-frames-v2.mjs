// Captures one frame from the first segment of each newly evidenced ad block (2026-11-16 re-audit),
// so a person can confirm the block is an advertisement before its rule ships.
// Segments are processed in memory; no video is stored. Usage: node docs/evidence/capture-ad-frames-v2.mjs
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = new URL('./', import.meta.url);
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const cases = [
  ['dyttzy-2', '#EXTINF:6.666667', 'dyttzy second fingerprint [6.667, 2.133, 3.233, 3.733]'],
  ['dyttzy-2', '#EXTINF:5.566667', 'dyttzy first fingerprint on a rotated CDN host'],
  ['ffzy-2', '#EXTINF:4.866667', 'ffzy fingerprint on a rotated CDN host'],
  ['lzi-2', '# ppvod-ad-injected', 'lzi marked block on a rotated CDN host'],
  ['bfzy-2', '# ppvod-ad-injected', 'bfzy marked block outside the adjump path'],
  ['bfzy-3', '/video/adjump/', 'bfzy adjump block inside an implicit-IV encrypted programme'],
  ['360zy-2', 'vod.360zyx.vip', '360zy out-of-directory block inside an encrypted programme'],
  ['360zy-3', 'vod.360zyx.vip', '360zy out-of-directory block'],
];
const seen = new Map();
for (const [name, needle, label] of cases) {
  const lines = (await readFile(new URL(`manifest-${name}.m3u8`, dir), 'utf8')).split('\n');
  let at = lines.findIndex(line => line.includes(needle));
  while (at >= 0 && at < lines.length && !lines[at].startsWith('http')) at++;
  if (at < 0 || at >= lines.length) { console.log(`${name}: ${label}: block not found`); continue; }
  const n = (seen.get(name) ?? 0) + 1; seen.set(name, n);
  const frame = fileURLToPath(new URL(`ad-frame-v2-${name}${n > 1 ? '-' + n : ''}.jpg`, dir));
  try {
    const response = await fetch(lines[at], { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL('/', lines[at]).href } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ss', '1', '-frames:v', '1', '-vf', 'scale=640:-2', '-y', frame], { input: bytes, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    console.log(`${name}: ${label}: ${run.status === 0 ? 'frame captured' : run.stderr.slice(0, 200)}`);
  } catch (error) { console.log(`${name}: ${label}: ${error.message}`); }
}

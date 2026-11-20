// Public catalogue names are query candidates, never a replacement for verified film metadata.
// Refresh the complete bundled index: npm run sync:search-titles -- [source keys, comma separated]
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pinyin, polyphonic } from 'pinyin-pro';
import { getText, WorkLimiter } from '../src/main/playback/network';
import { adultShelf } from '../src/main/adult';
import sourceConfig from '../resources/play-sources.json';

type Category = { type_id: number; type_pid: number; type_name: string };
type Record = { vod_id: string | number; vod_name: string; type_id: number; vod_time?: string };
type Page = { total: number; pagecount: number; limit: number; list: Record[]; class?: Category[] };
const root = process.cwd();
const scratch = join(root, '.tmp/search-title-sync');
const resources = join(root, 'resources');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const clean = (title: string) => title.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
const wanted = new Set((process.argv[2] ?? '360zy,subo').split(','));
const sources = sourceConfig.sources.filter(source => source.enabled && wanted.has(source.key));
if (sources.length !== wanted.size) throw new Error('Only configured, enabled catalogue sources may supply the title index');
mkdirSync(scratch, { recursive: true });

function checked(raw: unknown): Page {
  const page = raw as Page;
  if (!page || !Array.isArray(page.list) || !Number.isFinite(Number(page.total)) || !Number.isFinite(Number(page.pagecount))) throw new Error('Invalid catalogue listing');
  return { total: Number(page.total), pagecount: Number(page.pagecount), limit: Number(page.limit),
    list: page.list.filter(row => row && typeof row.vod_name === 'string').map(row => ({ vod_id: row.vod_id, vod_name: clean(row.vod_name), type_id: Number(row.type_id), vod_time: row.vod_time })),
    class: page.class };
}

function filmCategories(categories: Category[]): Category[] {
  const byId = new Map(categories.map(category => [Number(category.type_id), category]));
  return categories.filter(category => {
    if (adultShelf(category.type_name) || /短剧|漫剧|体育|足球|篮球|NBA/i.test(category.type_name)) return false;
    let current = category;
    for (let depth = 0; depth < 5 && Number(current.type_pid); depth++) {
      const parent = byId.get(Number(current.type_pid));
      if (!parent) return false;
      current = parent;
    }
    return /^(电影|连续剧|电视剧|剧集|综艺|动漫)$/.test(current.type_name) && !categories.some(child => Number(child.type_pid) === Number(category.type_id));
  });
}

async function collect(source: typeof sources[number]) {
  const limiter = new WorkLimiter(2);
  let nextStart = 0;
  let requests = 0;
  const get = (type: number | undefined, page = 1): Promise<Page> => limiter.run(async () => {
    const file = join(scratch, `${source.key}-${type ?? 'all'}-${page}.json`);
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      if (cached.at && Date.now() - cached.at < 6 * 60 * 60_000) return checked(cached.page);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Math.max(Date.now(), nextStart);
      nextStart = start + 500;
      await pause(Math.max(0, start - Date.now()));
      const url = new URL(source.api);
      url.search = new URLSearchParams({ ac: 'list', pg: String(page), pagesize: '100', ...(type == null ? {} : { t: String(type) }) }).toString();
      try {
        requests++;
        const value = checked(JSON.parse((await getText(url, { signal: AbortSignal.timeout(20_000), handshakeMs: 6500, timeoutMs: 12_000 }, 3 * 1024 * 1024)).text));
        if (value.list.length < Math.min(value.limit, value.total - (page - 1) * value.limit)) throw new Error('Partial catalogue page');
        writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), page: value }));
        renameSync(file + '.tmp', file);
        return value;
      } catch (error) {
        if (String(error).includes('(403)') || String(error).includes('(429)') || attempt === 2) throw error;
        await pause(1000 * (attempt + 1));
      }
    }
    throw new Error('Catalogue unavailable');
  });
  const first = await get(undefined);
  if (!Array.isArray(first.class)) throw new Error(`${source.key}: missing category vocabulary`);
  const categories = filmCategories(first.class);
  if (categories.length < 10) throw new Error(`${source.key}: incomplete film category vocabulary`);
  const records: Record[] = [];
  const evidence: Array<{ id: number; name: string; total: number; pages: number; records: number }> = [];
  for (const category of categories) {
    const type = Number(category.type_id);
    const head = await get(type);
    const pages = [head, ...await Promise.all(Array.from({ length: Math.max(0, head.pagecount - 1) }, (_, i) => get(type, i + 2)))];
    const rows = pages.flatMap(page => page.list).filter(row => row.type_id === type);
    records.push(...rows);
    evidence.push({ id: type, name: category.type_name, total: head.total, pages: pages.length, records: rows.length });
    console.log(`${source.key} ${category.type_name}: ${rows.length}/${head.total}, ${pages.length} pages`);
  }
  return { key: source.key, api: source.api, requests, categories: evidence, records };
}

function initialsData() {
  const variants: { [code: string]: string } = {};
  const ranges: Array<[number, string]> = [];
  for (const [from, end] of [[0x3400, 0xA000], [0xF900, 0xFB00]]) {
    let letters = '';
    for (let code = from; code < end; code++) {
      const character = String.fromCodePoint(code);
      const possible = [...new Set(polyphonic(character, { pattern: 'first', type: 'array', toneType: 'none' })[0].filter(letter => /^[a-z]$/.test(letter)))];
      const first = pinyin(character, { pattern: 'first', toneType: 'none' });
      letters += /^[a-z]$/.test(first) ? first : '?';
      if (possible.length > 1) variants[String(code)] = possible.join('');
    }
    ranges.push([from, letters]);
  }
  return { version: 1, library: 'pinyin-pro@3.29.5', ranges, variants };
}

function titleLine(title: string): string | undefined {
  if (!/[\u3400-\u9FFF\uF900-\uFAFF]/.test(title)) return;
  const letters = pinyin(title, { pattern: 'first', type: 'array', toneType: 'none' }).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  const options = polyphonic(title, { pattern: 'first', type: 'array', toneType: 'none' }).map(group => [...new Set(group.map(v => v.toLowerCase()).filter(v => /^[a-z0-9]$/.test(v)))].join('')).filter(Boolean);
  const characters = Array.from(title.replace(/[^\p{L}\p{N}]/gu, ''));
  if (letters.length < 2 || letters.length > 160 || options.length !== letters.length || characters.length !== letters.length) return;
  const variants = options.some((group, i) => group !== letters[i]) ? options.join('|') : '';
  return `${letters}\t${variants}\t${title.replace(/[\t\r\n]/g, ' ')}`;
}

async function main() {
  const startedAt = new Date().toISOString();
  // Each catalogue has its own two-request gate and 2 requests/s pace.
  const responses = await Promise.allSettled(sources.map(collect));
  const result = responses.flatMap(response => response.status === 'fulfilled' ? [response.value] : []);
  const failures = responses.flatMap((response, i) => response.status === 'rejected' ? [{ key: sources[i].key, error: String(response.reason) }] : []);
  if (!result.length) throw new Error('No complete catalogue was read; the existing index is unchanged');
  const byTitle = new Map<string, Record>();
  for (const source of result) for (const row of source.records) {
    if (!row.vod_name || row.vod_name.length > 160) continue;
    const previous = byTitle.get(row.vod_name);
    if (!previous || (row.vod_time ?? '') > (previous.vod_time ?? '')) byTitle.set(row.vod_name, row);
  }
  const records = [...byTitle.values()].sort((a, b) => (b.vod_time ?? '').localeCompare(a.vod_time ?? '') || (a.vod_name < b.vod_name ? -1 : 1));
  const lines = records.map(row => titleLine(row.vod_name)).filter((line): line is string => Boolean(line));
  if (lines.length < 20_000) throw new Error('Refusing to replace the full title index with a small or partial catalogue');
  const generatedAt = new Date().toISOString();
  const dictionary = initialsData();
  const body = `# Panda title index v1\n# ${generatedAt}\n` + lines.join('\n') + '\n';
  writeFileSync(join(resources, 'search-titles.tsv.tmp'), body);
  renameSync(join(resources, 'search-titles.tsv.tmp'), join(resources, 'search-titles.tsv'));
  writeFileSync(join(resources, 'search-initials.json'), JSON.stringify(dictionary) + '\n');
  const evidence = { startedAt, generatedAt, titles: lines.length, bytes: Buffer.byteLength(body), failures, sources: result.map(({ records, ...source }) => ({ ...source, rows: records.length })) };
  writeFileSync(join(root, 'docs/evidence/search-title-index.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ generatedAt, titles: lines.length, bytes: Buffer.byteLength(body) }));
}
main().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1); });

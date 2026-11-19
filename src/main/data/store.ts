import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Normalized } from './normalize';
import { normalize, positive, row, text } from './normalize';
import type { DataWarning } from './http';
import type { MediaType } from '../../../design/contract/types';

const TYPES = new Set<MediaType>(['tv', 'movie', 'variety', 'anime', 'doc']);

export interface CatalogRecord extends Normalized { updatedAt: number }

/** Real metadata only; URLs stay upstream URLs so app restarts never retain dead proxy handles. */
export class MetadataStore {
  private entries = new Map<string, CatalogRecord>();
  private writeChain: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  readonly ready: Promise<void>;
  constructor(private directory?: string, private warn: (warning: DataWarning) => void = () => {}) {
    this.ready = this.load();
  }

  get(id: string) { return this.entries.get(id); }

  set(records: Normalized[]) {
    for (const value of records) {
      const existing = this.entries.get(value.item.id);
      // Compact cards cannot erase previously fetched detailed metadata.
      const item = { ...existing?.item, ...value.item,
        genres: value.item.genres.length ? value.item.genres : existing?.item.genres ?? [],
        poster: value.item.poster ?? existing?.item.poster ?? null,
        backdrop: value.item.backdrop ?? existing?.item.backdrop ?? null,
      };
      this.entries.delete(item.id);
      this.entries.set(item.id, { ...existing, ...value, item, updatedAt: Date.now() });
    }
    while (this.entries.size > 2500) this.entries.delete(this.entries.keys().next().value!);
    if (this.directory) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 350);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.directory) return;
    await this.ready;
    const directory = this.directory;
    const records = [...this.entries.values()];
    let body = JSON.stringify({ version: 1, records });
    while (Buffer.byteLength(body) > 12 * 1024 * 1024 && records.length) { records.shift(); body = JSON.stringify({ version: 1, records }); }
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'metadata-v1.json');
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { encoding: 'utf8', flush: true });
      await rename(temporary, path);
    }).catch(() => this.warn({ code: 'STORAGE', operation: 'metadata:save', message: 'Metadata cache could not be saved', at: Date.now() }));
    await this.writeChain;
  }

  private async load() {
    if (!this.directory) return;
    try {
      const path = join(this.directory, 'metadata-v1.json');
      if ((await stat(path)).size > 12 * 1024 * 1024) throw new Error('oversized');
      const content = row(JSON.parse(await readFile(path, 'utf8')));
      if (content.version !== 1 || !Array.isArray(content.records)) throw new Error('invalid cache');
      for (const raw of content.records.slice(-2500)) {
        const record = row(raw);
        const it = row(record.item);
        if (record.kind !== 'tv' && record.kind !== 'movie') continue;
        const restored = normalize({
          id: text(it.id)?.replace(/^db-/, ''), title: it.title, type: record.kind,
          genres: it.genres, pic: { large: it.poster }, photos: it.backdrop ? [it.backdrop] : [],
          year: it.year, rating: { value: it.score }, countries: it.region ? [it.region] : [],
          original_title: it.originalTitle, intro: it.synopsis,
          durations: positive(it.runtime) ? [`${it.runtime}分钟`] : [],
          actors: Array.isArray(it.cast) ? it.cast.map(p => ({ name: row(p).name, character: row(p).role })) : [],
          directors: Array.isArray(it.directors) ? it.directors.map(name => ({ name })) : [],
          episodes_count: record.totalEpisodes,
          tags: record.tags,
          aka: record.aliases,
        });
        const updatedAt = positive(record.updatedAt);
        if (!restored || !updatedAt) continue;
        // The stored type was decided from the full upstream record (is_show etc.);
        // re-deriving it from genres alone would turn some shows back into dramas.
        if (TYPES.has(it.type as MediaType)) restored.item.type = it.type as MediaType;
        this.entries.set(restored.item.id, { ...restored, updatedAt });
      }
    } catch (error) {
      if (row(error).code !== 'ENOENT') this.warn({ code: 'STORAGE', operation: 'metadata:load', message: 'Metadata cache was invalid or unreadable', at: Date.now() });
    }
  }
}

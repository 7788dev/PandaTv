import type { ChannelFilters, ChannelQuery, DataSource, HomeFeed, MediaItem, MediaType, Page } from '../../../design/contract/types';
import type { Credit, Detail, PersonInfo } from '../../shared/api';
import { dataCopy } from '../../copy.extra';
import { t } from '../../../design/contract/copy';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError, DoubanHttp, type DataWarning } from './http';
import { landscapePhoto, list, normalize, personId, portraitUrl, positive, principalCredits, requiredArray, row, subjectId, text, type DoubanKind, type Normalized } from './normalize';
import { MetadataStore } from './store';
import { GENRES, LANES, REGIONS, matchesRegion, matchesYear, yearChoices, yearSpan } from './taxonomy';
import { combineHotQueries, hotQueries } from './hot-search';
import { initialQuery, suggestedSubjectIds } from '../../shared/title-search';
import { SearchTitleVocabulary } from './title-search';

const BASE = 'https://m.douban.com/rexxar/api/v2';
const LIST_TTL = 10 * 60_000;
const DETAIL_TTL = 24 * 60 * 60_000;
const SEARCH_TTL = 2 * 60_000;
const PAGE_SIZE = 30;
const HOME_FILE = 'home-v1.json';
const HOME_RETRY_MS = [2000, 6000];
const TYPES: MediaType[] = ['tv', 'movie', 'variety', 'anime', 'doc'];
/** A page is filled until it holds this many titles, within a bounded number of upstream pages. */
const PAGE_TARGET = 18;
const PAGE_ROUNDS = 4;
/**
 * Douban computes a filter combination it has not served recently on demand, and answers in
 * one of two ways: it holds the request until the page is ready (measured up to 14 s), or it
 * returns after about 1.2 s with a partial page: the right `total`, but only some of the titles
 * (often none) and not the first ones. It can then repeat that same partial page for a minute.
 * Warm pages always hold exactly what `total` implies. Measured on 2026-11-16 over 84 cold
 * combinations: 34 first pages were partial; 27 of those were complete when read again a second
 * later; in the other 7 the same range read as smaller pages completed while the 30-title page
 * was still stuck, with the same titles in the same order.
 *
 * So listing requests wait longer than other requests, a short page is read once more, and a
 * page that is still short is split into smaller pages (30 → 10 → 5). Short pages are never
 * cached. A range that cannot be completed that way is reported as an upstream timeout:
 * showing it would end the list early and skip the titles it left out.
 *
 * A person's works are listed the same way and behave the same way (measured 2026-11-17 on
 * three people with 134 to 316 works, docs/evidence/people-audit.json: a first read takes
 * 1.5 to 4.4 s; on a first walk 6 of 23 ranges came back short and were complete on the
 * second read; the first 60 works read as pages of 30, 10 and 5 are the same list in the
 * same order).
 */
const PARTIAL_REREAD_MS = 800;
const READ_SIZES = [PAGE_SIZE, 10, 5];
/** The field a listing keeps its rows in. */
type Rows = 'items' | 'works';
/** How many of a title's own billing stand in for its leading actors: as many as Douban's principal list holds. */
const LEAD_ACTORS = 6;
class PartialPage extends DataError {
  constructor(readonly rows: number, readonly total: number) { super('TIMEOUT', `Listing incomplete: ${rows} of ${total} titles`, true); }
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const endpoint = (path: string, params: Record<string, string | number> = {}) => `${BASE}/${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}` : ''}`;

interface SourceOptions {
  imageUrl: (url: string) => string;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  onWarning?: (warning: DataWarning) => void;
  /** Pause before re-reading a partial listing page. */
  partialWaitMs?: number;
  /** Called with a home feed newer than the one `home()` answered with. */
  onHome?: (feed: HomeFeed) => void;
  /** Pauses before reading a failed home shelf again. */
  homeRetryMs?: number[];
  /** Installed resource directory; standalone tools and tests default to the project resources. */
  searchTitlesDir?: string;
  onSearchDiagnostic?: (event: { stage: string; vocabulary?: number; candidates?: number; hints?: number; identities?: number; returned?: number }) => void;
}
const HOME_LISTS = ['tv', 'movies', 'variety', 'anime', 'doc', 'tvRank', 'movieRank', 'animeRank'] as const;
/** The titles the home page is composed from, with upstream image addresses. */
type HomePart = typeof HOME_LISTS[number];
type HomeLists = Record<HomePart, MediaItem[]>;
/** The lists behind each shelf of the home page, in page order. */
const HOME_SHELVES: HomePart[][] = [['tv'], ['tvRank', 'movieRank', 'animeRank'], ['movies'], ['variety'], ['anime'], ['doc']];
interface Cursor { fingerprint: string; offsets: number[]; done: boolean[] }

export class DoubanDataSource implements Omit<DataSource, 'playback'> {
  private readonly http: DoubanHttp;
  private readonly store: MetadataStore;
  private warnings: DataWarning[] = [];
  private flights = new Map<string, Promise<Detail>>();
  private homeLists?: { at: number; lists: HomeLists };
  private homeFlight?: { top: Promise<void>; all: Promise<void>; shown: () => HomeFeed };
  private homeSave: Promise<void> = Promise.resolve();
  private readonly homeReady: Promise<void>;
  private readonly searchTitles: SearchTitleVocabulary;
  private readonly fallbackHttp: DoubanHttp;
  private searchFallbackUntil = 0;

  constructor(private options: SourceOptions) {
    this.http = new DoubanHttp({ fetch: options.fetch });
    this.fallbackHttp = new DoubanHttp({ fetch: options.fetch, intervalMs: 1000, burst: 1, maxConcurrent: 2, maxEntries: 64, maxBytes: 2 * 1024 * 1024 });
    this.store = new MetadataStore(options.cacheDir, value => this.warn(value));
    this.searchTitles = new SearchTitleVocabulary(options.searchTitlesDir);
    this.homeReady = this.restoreHome();
  }

  getWarnings() { return structuredClone(this.warnings); }
  getMetadata(id: string) {
    const record = this.store.get(`db-${subjectId(id)}`);
    return record ? { kind: record.kind, totalEpisodes: record.totalEpisodes, aliases: record.aliases } : undefined;
  }
  async flush() { await Promise.all([this.store.flush(), this.homeSave]); }
  private warn(value: DataWarning) {
    this.warnings = [...this.warnings.slice(-49), value];
    if (this.options.onWarning) this.options.onWarning(value);
    else console.warn(`[douban] ${value.operation}: ${value.code} (${value.message})`);
  }
  private diagnostic(operation: string, error: unknown) {
    this.warn({ operation, code: error instanceof DataError ? error.code : 'UPSTREAM', message: error instanceof DataError ? error.message : 'Optional metadata unavailable', at: Date.now() });
  }
  private present(it: MediaItem): MediaItem {
    return { ...structuredClone(it), poster: it.poster ? this.options.imageUrl(it.poster) : null, backdrop: it.backdrop ? this.options.imageUrl(it.backdrop) : null };
  }
  /** `count` rows of a listing from `start`; rejects an answer shorter than its own total implies. */
  private page(path: string, params: Record<string, string>, start: number, count: number, field: Rows): Promise<Record<string, unknown>> {
    return this.http.json(endpoint(path, { start, count, ...params }), LIST_TTL, value => {
      const rows = requiredArray(value, field);
      const response = row(value);
      const total = positive(response.total) ?? 0;
      if (rows.length < Math.min(count, total - start)) throw new PartialPage(rows.length, total);
      return response;
    }, true);
  }
  /** One complete page of PAGE_SIZE rows from `start`. */
  private listing(path: string, params: Record<string, string>, start: number, field: Rows = 'items'): Promise<Record<string, unknown>> {
    const read = async (offset: number, level: number): Promise<Record<string, unknown>> => {
      const size = READ_SIZES[level];
      let partial: PartialPage | undefined;
      for (const again of [true, false]) {
        try { return await this.page(path, params, offset, size, field); } catch (error) {
          if (!(error instanceof PartialPage)) throw error;
          partial = error;
          if (again) await wait(this.options.partialWaitMs ?? PARTIAL_REREAD_MS);
        }
      }
      const smaller = READ_SIZES[level + 1];
      if (!partial || !smaller) throw partial;
      const offsets: number[] = [];
      for (let at = offset; at < Math.min(offset + size, partial.total); at += smaller) offsets.push(at);
      const parts = await Promise.all(offsets.map(at => read(at, level + 1)));
      return { ...parts[0], count: size, [field]: parts.flatMap(part => requiredArray(part, field)) };
    };
    return read(start, 0);
  }
  /** Stores the records and returns their merged items, image addresses still upstream. */
  private async keep(values: Normalized[]): Promise<MediaItem[]> {
    await this.store.ready;
    this.store.set(values);
    return values.map(value => this.store.get(value.item.id)!.item);
  }
  private async remember(values: Normalized[]) {
    return (await this.keep(values)).map(item => this.present(item));
  }

  /**
   * Ten upstream answers make one home page. Most take 0.2–0.6 s, but any of them takes
   * several seconds now and then (measured 2026-11-16: up to 4 s within three reads, 9 s once),
   * so a page that waits for all ten is as slow as the slowest.
   *
   * A page that was read before is answered from the last read at once: within LIST_TTL as it
   * is, later while a new read runs behind it, which reaches the interface through `onHome` when
   * it differs. The saved page is what Douban answered last time, never a substitute; when the
   * new read fails it stays and the interface is told that it shows saved information.
   *
   * Without a saved page the answer is the top of the page (the featured titles and the first
   * shelf); the shelves below follow through `onHome` in page order as their answers arrive.
   */
  async home(): Promise<HomeFeed> {
    await this.homeReady;
    const known = this.homeLists;
    if (known) {
      if (Date.now() - known.at >= LIST_TTL) this.readHome(known.lists);
      return this.feed(known.lists);
    }
    const read = this.readHome();
    await read.top;
    return read.shown();
  }
  /** One read at a time. `saved` is the page already on screen, which only a complete, different page replaces. */
  private readHome(saved?: HomeLists) {
    if (this.homeFlight) return this.homeFlight;
    const hot = (type: MediaType) => this.listChannel(type, { sort: 'hot' }).then(page => page.items.slice(0, 14));
    const top = (collection: string) => this.chartItems(collection).then(items => items.slice(0, 5));
    // On a first read a shelf below the top whose answer fails is read again, twice at most: a
    // line that drops for a moment would otherwise leave the page without it until it is opened
    // again. The top is not: when it fails the page says so at once and offers to retry, and
    // the shelves stop asking. Behind a saved page nothing is read again either: that page is
    // whole, and the sooner the interface says it shows saved information the better.
    let abandoned = false;
    const again = async (read: () => Promise<MediaItem[]>): Promise<MediaItem[]> => {
      for (const pause of saved ? [] : this.options.homeRetryMs ?? HOME_RETRY_MS) {
        try { return await read(); } catch (error) {
          if (abandoned || !(error instanceof DataError) || !error.retryable) throw error;
          await wait(pause);
          if (abandoned) throw error;
        }
      }
      return read();
    };
    // Asked in the order the page needs them: its top first, the last shelf last.
    const reads: Record<HomePart, Promise<MediaItem[]>> = {
      tv: hot('tv'), movies: this.chartItems('movie_latest', 20).then(items => items.slice(0, 14)),
      tvRank: again(() => top('tv_hot')), movieRank: again(() => top('movie_real_time_hotest')), animeRank: again(() => top('tv_animation')),
      variety: again(() => hot('variety')), anime: again(() => hot('anime')), doc: again(() => hot('doc')),
    };
    const lists: Partial<HomeLists> = {};
    const errors = new Map<HomePart, unknown>();
    let revealed = 0, answered = false;
    // Shelves appear from the top down: one whose answer is in waits for those above it, so
    // nothing on screen moves when a shelf arrives.
    const shown = () => {
      const visible = Object.fromEntries(HOME_LISTS.map(name => [name, [] as MediaItem[]])) as HomeLists;
      for (const group of HOME_SHELVES.slice(0, revealed)) for (const name of group) visible[name] = lists[name] ?? [];
      return this.feed(visible, lists.movies);
    };
    const parts = Object.fromEntries(HOME_LISTS.map(name => [name, reads[name].then(items => { lists[name] = items; }, error => { lists[name] = []; errors.set(name, error); }).then(() => {
      const before = revealed;
      while (revealed < HOME_SHELVES.length && HOME_SHELVES[revealed].every(part => part in lists)) revealed++;
      if (!saved && answered && revealed > before) this.options.onHome?.(shown());
    })])) as Record<HomePart, Promise<void>>;
    // The featured titles come from these two lists: without them there is no page to show.
    const topOfPage = Promise.all([parts.tv, parts.movies]).then(() => {
      const error = errors.get('tv') ?? errors.get('movies');
      if (!error) { answered = true; return; }
      // Asking again starts a new read; this one is not waited for.
      abandoned = true;
      if (this.homeFlight === flight) this.homeFlight = undefined;
      throw error;
    });
    topOfPage.catch(() => { /* Reported to whoever asked for the page. */ });
    const all = Promise.all(Object.values(parts)).then(() => {
      if (errors.size) {
        // A page with a shelf missing is shown as far as it came, but is not the page to keep.
        if (saved) this.warn({ code: 'CACHED', operation: 'home', message: 'Showing the saved home feed; a new one could not be read', at: Date.now() });
        else if (answered) for (const [name, error] of errors) this.diagnostic(`home:${name}`, error);
        return;
      }
      const complete = lists as HomeLists;
      this.homeLists = { at: Date.now(), lists: complete };
      this.saveHome();
      // Compared list by list: the two objects do not hold their lists in the same order.
      const same = saved && HOME_LISTS.every(name => JSON.stringify(complete[name]) === JSON.stringify(saved[name]));
      if (saved && !same) this.options.onHome?.(this.feed(complete));
    }).finally(() => { if (this.homeFlight === flight) this.homeFlight = undefined; });
    const flight = { top: topOfPage, all, shown };
    return this.homeFlight = flight;
  }
  /** `heroMovies` are the films for the featured titles when their own shelf is not shown yet. */
  private feed(lists: HomeLists, heroMovies: MediaItem[] = lists.movies): HomeFeed {
    const show = (items: MediaItem[]) => items.map(item => this.present(item));
    const tv = show(lists.tv), movies = show(lists.movies);
    const hero = [...tv.slice(0, 3), ...show(heroMovies.slice(0, 2))].filter(it => it.poster || it.backdrop);
    const boards = [
      { title: dataCopy.rankTv, more: '/channel/tv', items: show(lists.tvRank) },
      { title: dataCopy.rankMovie, more: '/channel/movie', items: show(lists.movieRank) },
      { title: dataCopy.rankAnime, more: '/channel/anime', items: show(lists.animeRank) },
    ].filter(board => board.items.length);
    const shelves: HomeFeed['shelves'] = [
      { id: 'continue', kind: 'continue' },
      { id: 'hot-tv', kind: 'poster', title: dataCopy.homeHotTv, more: '/channel/tv', items: tv },
      ...(boards.length ? [{ id: 'rank', kind: 'rank' as const, boards }] : []),
      { id: 'new-movie', kind: 'poster', title: dataCopy.homeNewMovie, more: '/channel/movie', items: movies },
      { id: 'variety', kind: 'wide', title: t.nav.variety, more: '/channel/variety', items: show(lists.variety) },
      { id: 'anime', kind: 'poster', title: t.nav.anime, more: '/channel/anime', items: show(lists.anime) },
      { id: 'doc', kind: 'wide', title: t.nav.doc, more: '/channel/doc', items: show(lists.doc) },
    ];
    // A shelf without titles (not read yet, or unreadable) is left out, never shown empty.
    return { hero, shelves: shelves.filter(shelf => !('items' in shelf) || shelf.items.length > 0) };
  }
  /** The saved page names its titles only; their records live in the metadata store. */
  private saveHome() {
    const directory = this.options.cacheDir, known = this.homeLists;
    if (!directory || !known) return;
    const body = JSON.stringify({ version: 1, at: known.at, lists: Object.fromEntries(HOME_LISTS.map(name => [name, known.lists[name].map(item => item.id)])) });
    this.homeSave = this.homeSave.then(async () => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, HOME_FILE);
      await writeFile(`${path}.${process.pid}.tmp`, body, 'utf8');
      await rename(`${path}.${process.pid}.tmp`, path);
    }).catch(() => this.warn({ code: 'STORAGE', operation: 'home:save', message: 'Home feed could not be saved', at: Date.now() }));
  }
  /** A saved page that cannot be read, or most of whose titles are gone, is simply not used. */
  private async restoreHome() {
    if (!this.options.cacheDir) return;
    try {
      const saved = row(JSON.parse(await readFile(join(this.options.cacheDir, HOME_FILE), 'utf8')));
      const at = positive(saved.at);
      if (saved.version !== 1 || !at) return;
      await this.store.ready;
      const lists = {} as HomeLists;
      for (const name of HOME_LISTS) {
        const ids = list(row(saved.lists)[name]).filter((id): id is string => typeof id === 'string').slice(0, 14);
        const items = ids.flatMap(id => this.store.get(id)?.item ?? []);
        if (!items.length || items.length * 2 < ids.length) return;
        lists[name] = items;
      }
      // A time ahead of the clock says nothing about age: read anew behind it.
      this.homeLists = { at: at > Date.now() ? 0 : at, lists };
    } catch { /* No saved page: the first read answers. */ }
  }

  private async chartItems(collection: string, count = 10): Promise<MediaItem[]> {
    const values = await this.http.json(endpoint(`subject_collection/${collection}/items`, { start: 0, count }), LIST_TTL, value => requiredArray(value, 'subject_collection_items'));
    return this.keep(values.flatMap(value => normalize(value) ?? []));
  }

  async filters(type: MediaType): Promise<ChannelFilters> {
    if (!TYPES.includes(type)) throw new DataError('INVALID_INPUT', 'Invalid channel');
    return { genres: [...GENRES[type]], regions: [...REGIONS[type]], years: yearChoices() };
  }

  async channel(type: MediaType, query: ChannelQuery, cursor?: string): Promise<Page<MediaItem>> {
    const page = await this.listChannel(type, query, cursor);
    return { items: page.items.map(item => this.present(item)), next: page.next };
  }
  private async listChannel(type: MediaType, query: ChannelQuery, cursor?: string): Promise<Page<MediaItem>> {
    if (!TYPES.includes(type) || !['hot', 'new', 'score'].includes(query.sort)) throw new DataError('INVALID_INPUT', 'Invalid channel query');
    // A filter is one upstream tag; separators would smuggle in additional ones.
    for (const value of [query.genre, query.region, query.year]) if (value !== undefined && (typeof value !== 'string' || value.length > 40 || /[,，\s]/.test(value))) throw new DataError('INVALID_INPUT', 'Invalid channel filter');
    if (query.year && !yearSpan(query.year)) throw new DataError('INVALID_INPUT', 'Invalid year filter');
    const lanes = LANES[type];
    const fingerprint = JSON.stringify([type, query.sort, query.genre ?? '', query.region ?? '', query.year ?? '']);
    let state: Cursor = { fingerprint, offsets: lanes.map(() => 0), done: lanes.map(() => false) };
    if (cursor) {
      try {
        if (cursor.length > 2000) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
        if (decoded.fingerprint !== fingerprint || decoded.offsets.length !== lanes.length || decoded.done.length !== lanes.length || !decoded.offsets.every(n => Number.isInteger(n) && n >= 0 && n <= 10000) || !decoded.done.every(x => typeof x === 'boolean')) throw new Error();
        state = decoded;
      } catch { throw new DataError('INVALID_INPUT', 'Invalid or outdated channel cursor'); }
    }
    const readLane = async (index: number): Promise<Normalized[]> => {
      const lane = lanes[index];
      const tags = [...new Set([...lane.tags, query.genre, query.region, query.year].filter((x): x is string => Boolean(x)))];
      const response = await this.listing(`${lane.kind}/recommend`, { sort: { hot: 'U', new: 'R', score: 'S' }[query.sort], tags: tags.join(',') }, state.offsets[index]);
      const rows = requiredArray(response, 'items');
      const total = positive(response.total);
      state.offsets[index] += positive(response.count) ?? PAGE_SIZE;
      state.done[index] = rows.length === 0 || total === undefined || state.offsets[index] >= total;
      // Douban's tag index decides genre membership. Type, year and region are re-checked
      // against each title's own record because user tags leak across formats.
      return rows.flatMap(value => normalize(value, lane.kind) ?? []).filter(value => {
        const it = value.item;
        // Movie is the film format channel and includes animated/documentary films;
        // the thematic anime/doc channels combine both formats. TV excludes shows.
        if (type === 'movie' ? value.kind !== 'movie' : it.type !== type) return false;
        return matchesYear(it.year, query.year) && matchesRegion(it.region, query.region);
      });
    };
    const merged: Normalized[] = [];
    const seen = new Set<string>();
    for (let round = 0; round < PAGE_ROUNDS && merged.length < PAGE_TARGET && !state.done.every(Boolean); round++) {
      const open = lanes.map((_, index) => index).filter(index => !state.done[index]);
      const results = await Promise.allSettled(open.map(readLane));
      const failed = results.filter(result => result.status === 'rejected');
      const buckets = results.map(result => result.status === 'fulfilled' ? result.value : []);
      // A lane failing with nothing to show is an error, never an empty channel.
      if (failed.length && !merged.length && !buckets.some(bucket => bucket.length)) throw failed[0].reason;
      results.forEach((result, i) => { if (result.status === 'rejected') this.diagnostic(`channel:${type}:${lanes[open[i]].kind}`, result.reason); });
      for (let i = 0; i < Math.max(0, ...buckets.map(x => x.length)); i++) for (const bucket of buckets) {
        const value = bucket[i];
        if (value && !seen.has(value.item.id)) { seen.add(value.item.id); merged.push(value); }
      }
      if (failed.length) break;
    }
    if (lanes.length > 1 && query.sort === 'score') merged.sort((a, b) => (b.item.score ?? 0) - (a.item.score ?? 0));
    if (lanes.length > 1 && query.sort === 'new') merged.sort((a, b) => (b.item.year ?? 0) - (a.item.year ?? 0));
    return { items: await this.keep(merged), next: state.done.every(Boolean) ? null : Buffer.from(JSON.stringify(state)).toString('base64url') };
  }

  async detail(id: string): Promise<Detail> {
    const rawId = subjectId(id);
    const existing = this.flights.get(rawId);
    if (existing) return existing;
    const work = this.loadDetail(rawId).finally(() => this.flights.delete(rawId));
    this.flights.set(rawId, work);
    return work;
  }
  /**
   * A title names everyone who worked on it: up to 96 people on the 45 titles measured
   * (docs/evidence/people-audit.json), and its full list (`celebrities`) can answer with a
   * different part of itself on the next read. What its page shows is the short list Douban
   * chose for it (`credits`): the same eight people at most on every read, with their photos.
   * The page shows those and nobody else.
   */
  private async readSubject(rawId: string): Promise<Normalized> {
    await this.store.ready;
    const known = this.store.get(`db-${rawId}`);
    const first = known?.kind ?? 'movie';
    let detail: Normalized | undefined;
    for (const kind of [first, first === 'movie' ? 'tv' : 'movie'] as DoubanKind[]) {
      try {
        detail = await this.http.json(endpoint(`${kind}/${rawId}`), DETAIL_TTL, value => {
          const normalized = normalize(value, kind);
          if (!normalized || normalized.item.id !== `db-${rawId}`) throw new DataError('NOT_FOUND', 'Douban subject not found');
          return normalized;
        });
        break;
      } catch (error) {
        if (!(error instanceof DataError) || error.code !== 'NOT_FOUND' || kind !== first) throw error;
      }
    }
    if (!detail) throw new DataError('NOT_FOUND', 'Douban subject not found');
    return detail;
  }
  private async loadDetail(rawId: string): Promise<Detail> {
    const detail = await this.readSubject(rawId);
    const path = `${detail.kind}/${rawId}`;
    const [credits, photos] = await Promise.allSettled([
      this.http.json(endpoint(`${path}/credits`), DETAIL_TTL, principalCredits),
      this.http.json(endpoint(`${path}/photos`, { count: 8 }), DETAIL_TTL, value => { requiredArray(value, 'photos'); return value; }),
    ]);
    const principal = credits.status === 'fulfilled' ? credits.value : undefined;
    if (credits.status === 'rejected') this.diagnostic(`credits:${rawId}`, credits.reason);
    // The leading actors are Douban's choice; without it, the head of the title's own billing.
    const cast = principal?.cast.length ? principal.cast : detail.item.cast?.slice(0, LEAD_ACTORS);
    if (cast?.length) detail.item.cast = cast;
    if (photos.status === 'fulfilled') detail.item.backdrop = landscapePhoto(photos.value);
    else this.diagnostic(`photos:${rawId}`, photos.reason);
    const item = (await this.remember([detail]))[0];
    // The people are not kept with the title: they come from the answer above on every call.
    const people = principal?.people.map((person): Credit => ({ ...person, ...(person.photo ? { photo: this.options.imageUrl(person.photo) } : {}) }));
    return people?.length ? { ...item, people } : item;
  }

  async person(id: string): Promise<PersonInfo> {
    const rawId = personId(id);
    return this.http.json(endpoint(`celebrity/${rawId}`), DETAIL_TTL, value => {
      const source = row(value), cover = row(source.cover);
      const name = text(source.title);
      if (!name || name.length > 100) throw new DataError('INVALID_RESPONSE', 'Missing name in person response');
      const photo = portraitUrl(row(cover.normal).url) ?? portraitUrl(row(cover.large).url);
      return { id: rawId, name, ...(photo ? { photo: this.options.imageUrl(photo) } : {}) };
    });
  }
  /** Everything the person worked on, in Douban's order: best rated first, unrated and unreleased last. */
  async personWorks(id: string, cursor?: string): Promise<Page<MediaItem>> {
    const rawId = personId(id);
    // The cursor is where the next page starts.
    if (cursor !== undefined && (!/^\d{1,5}$/.test(cursor) || Number(cursor) % PAGE_SIZE !== 0)) throw new DataError('INVALID_INPUT', 'Invalid works cursor');
    const start = Number(cursor ?? 0);
    const response = await this.listing(`celebrity/${rawId}/works`, {}, start, 'works');
    const values = requiredArray(response, 'works').flatMap(entry => normalize(row(entry).work) ?? []);
    const total = positive(response.total) ?? 0;
    return { items: await this.remember(values), next: start + PAGE_SIZE < total ? String(start + PAGE_SIZE) : null };
  }

  async related(id: string): Promise<MediaItem[]> {
    const rawId = subjectId(id);
    await this.store.ready;
    if (!this.store.get(`db-${rawId}`)) await this.detail(rawId);
    const kind = this.store.get(`db-${rawId}`)!.kind;
    const values = await this.http.json(endpoint(`${kind}/${rawId}/recommendations`, { count: 14 }), LIST_TTL, value => requiredArray(value));
    return this.remember(values.flatMap(value => normalize(value, kind) ?? []).filter(value => value.item.id !== `db-${rawId}`).slice(0, 14));
  }

  async byIds(ids: string[]): Promise<MediaItem[]> {
    if (!Array.isArray(ids) || ids.length > 2500) throw new DataError('INVALID_INPUT', 'Too many metadata IDs');
    const checked = ids.map(id => `db-${subjectId(id)}`);
    await this.store.ready;
    const output: MediaItem[] = [];
    for (const id of checked) {
      const cached = this.store.get(id);
      if (cached) {
        if (Date.now() - cached.updatedAt > DETAIL_TTL) this.warn({ code: 'CACHED', operation: `byIds:${id}`, message: 'Showing saved metadata; freshness is not guaranteed', at: Date.now() });
        output.push(this.present(cached.item));
      } else {
        try { output.push(await this.detail(id)); }
        catch (error) { if (error instanceof DataError && error.code === 'NOT_FOUND') this.diagnostic(`byIds:${id}`, error); else throw error; }
      }
    }
    return output;
  }

  private async searchPage(q: string, start: number, count: number) {
    return this.http.json(endpoint('search/movie', { q, start, count }), SEARCH_TTL, value => {
      requiredArray(value, 'items');
      if (text(row(value).banned)) throw new DataError('UPSTREAM', 'Search query was rejected');
      return row(value);
    });
  }
  private searchQuery(q: string) {
    if (typeof q !== 'string' || q.length > 100) throw new DataError('INVALID_INPUT', 'Invalid search query');
    return q.trim();
  }
  private async searchRows(q: string, count: number, paginate: boolean): Promise<Normalized[]> {
    if (this.searchFallbackUntil > Date.now()) return this.searchFallback(q, count);
    let first: Record<string, unknown>;
    try { first = await this.searchPage(q, 0, count); }
    catch (error) {
      if (!(error instanceof DataError) || error.code === 'INVALID_INPUT' || error.message === 'Search query was rejected') throw error;
      this.searchFallbackUntil = Date.now() + 60_000;
      this.diagnostic('search:primary', error);
      return this.searchFallback(q, count);
    }
    const pages = [first];
    const total = positive(first.total) ?? 0;
    if (paginate && total > count) {
      const remaining = await Promise.allSettled([count, count * 2, count * 3].filter(start => start < total).map(start => this.searchPage(q, start, count)));
      for (const response of remaining) {
        if (response.status === 'fulfilled') pages.push(response.value);
        else this.diagnostic('search:page', response.reason);
      }
    }
    return pages.flatMap(value => requiredArray(value, 'items')).flatMap(value => normalize(value) ?? []);
  }
  private async searchFallback(q: string, count: number): Promise<Normalized[]> {
    const hints = await this.fallbackHttp.json(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`, SEARCH_TTL, value => requiredArray(value), false, 1000);
    let ids = suggestedSubjectIds(hints).slice(0, count);
    this.options.onSearchDiagnostic?.({ stage: 'fallback', hints: hints.length, identities: ids.length });
    if (!ids.length) {
      const cards = await this.fallbackHttp.json(`https://www.douban.com/j/search_suggest?q=${encodeURIComponent(q)}`, SEARCH_TTL, value => requiredArray(value, 'cards'), false, 1000);
      ids = suggestedSubjectIds(cards).slice(0, count);
      this.options.onSearchDiagnostic?.({ stage: 'global-fallback', hints: cards.length, identities: ids.length });
    }
    if (!ids.length) return [];
    const replies = await Promise.allSettled(ids.map(id => this.readSubject(id)));
    const values = replies.flatMap(reply => reply.status === 'fulfilled' ? [reply.value] : []);
    if (!values.length) throw (replies[0] as PromiseRejectedResult).reason;
    for (const reply of replies) if (reply.status === 'rejected') this.diagnostic('search:subject', reply.reason);
    return values;
  }
  private async searchTitlesRows(q: string, suggestions: boolean): Promise<Normalized[]> {
    const count = suggestions ? 20 : 50;
    if (!initialQuery(q)) return this.searchRows(q, suggestions ? 8 : count, !suggestions);
    const vocabulary = await this.searchTitles.load().catch(error => { this.diagnostic('search:initials', error); return undefined; });
    if (!vocabulary) return this.searchRows(q, suggestions ? 8 : count, !suggestions);
    await this.store.ready;
    const score = (value: Normalized) => Math.min(...[value.item.title, value.item.originalTitle, ...(value.aliases ?? [])].filter((title): title is string => Boolean(title)).map(title => vocabulary.score(title, q)));
    const saved = this.store.values().filter(value => Number.isFinite(score(value)));
    const terms = vocabulary.terms(q, suggestions ? 4 : 6);
    this.options.onSearchDiagnostic?.({ stage: 'initials', vocabulary: vocabulary.size, candidates: terms.length });
    const responses = await Promise.allSettled([q, ...terms].map(term => this.searchRows(term, count, !suggestions)));
    const values = responses.flatMap(response => response.status === 'fulfilled' ? response.value.filter(value => !terms.length || Number.isFinite(score(value))) : []);
    this.options.onSearchDiagnostic?.({ stage: 'results', returned: values.length });
    if (!responses.some(response => response.status === 'fulfilled') && !saved.length) throw (responses[0] as PromiseRejectedResult).reason;
    if (saved.length && responses.every(response => response.status === 'rejected')) this.warn({ code: 'CACHED', operation: 'search:initials', message: 'Showing saved title matches while metadata queries are unavailable', at: Date.now() });
    const merged = new Map<string, Normalized>(saved.map(value => [value.item.id, value]));
    for (const value of values) merged.set(value.item.id, value);
    return [...merged.values()].sort((a, b) => score(a) - score(b)).slice(0, suggestions ? 8 : 200);
  }
  async search(query: string): Promise<MediaItem[]> {
    const q = this.searchQuery(query);
    if (!q) return [];
    const seen = new Set<string>();
    return this.remember((await this.searchTitlesRows(q, false)).filter(value => {
      if (seen.has(value.item.id)) return false;
      seen.add(value.item.id); return true;
    }));
  }
  async suggest(query: string): Promise<MediaItem[]> {
    const q = this.searchQuery(query);
    if (!q) return [];
    return this.remember((await this.searchTitlesRows(q, true)).slice(0, 8));
  }
  async titleHints(query: string): Promise<string[]> {
    const q = this.searchQuery(query);
    if (!initialQuery(q)) return [];
    return (await this.searchTitles.load()).hints(q);
  }
  async hotSearches(): Promise<string[]> {
    const boards = await Promise.all((['movie', 'teleplay'] as const).map(board =>
      this.http.json('https://top.baidu.com/api/board?platform=wise&tab=' + board, 15 * 60_000, raw => hotQueries(raw, board))
    ));
    return combineHotQueries(boards);
  }
}

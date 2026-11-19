import type { MediaItem, MediaType, Person } from '../../../design/contract/types';
import type { Credit } from '../../shared/api';
import { DataError } from './http';

export type Row = Record<string, unknown>;
export type DoubanKind = 'movie' | 'tv';
export interface Normalized {
  item: MediaItem; kind: DoubanKind; totalEpisodes?: number; tags?: string[];
  /** Other names Douban lists for the subject; play sources often file the work under one of them. */
  aliases?: string[];
}
export const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const positive = (value: unknown): number | undefined => {
  const n = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const strings = (value: unknown) => list(value).flatMap(x => text(x) ?? []).slice(0, 100);
export const subjectId = (value: string) => {
  const id = value.replace(/^db-/, '');
  if (!/^\d{1,16}$/.test(id)) throw new DataError('INVALID_INPUT', 'Invalid Douban subject ID');
  return id;
};
export const personId = (value: string) => {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) throw new DataError('INVALID_INPUT', 'Invalid Douban person ID');
  return value;
};

export const imageUrl = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !(url.hostname === 'doubanio.com' || url.hostname.endsWith('.doubanio.com'))) return null;
    return url.href;
  } catch { return null; }
};
/**
 * A person's photo. Douban keeps photos under `/view/`; for someone without one it answers the
 * address of a stock silhouette, a static file elsewhere on the same hosts. That is no photo.
 */
export const portraitUrl = (value: unknown): string | null => {
  const url = imageUrl(value);
  return url?.startsWith('https:') && new URL(url).pathname.startsWith('/view/') ? url : null;
};

const FORMAL_GENRES = new Set('剧情 喜剧 爱情 动作 科幻 悬疑 犯罪 惊悚 恐怖 冒险 奇幻 战争 历史 传记 音乐 歌舞 武侠 灾难 西部 家庭 运动 动画 纪录片 短片 儿童 同性 古装 真人秀 脱口秀 戏曲 舞台艺术 黑色电影 情色'.split(' '));
export function subtitleParts(value: unknown): { year?: number; region?: string; genres: string[] } {
  const parts = (text(value) ?? '').split('/').map(x => x.trim());
  const year = /^\d{4}$/.test(parts[0] ?? '') ? Number(parts.shift()) : undefined;
  // Certain legacy cards lead with a literal movie/tv category instead of a year.
  if (['电影', '电视剧', '综艺', '动漫', '纪录片'].includes(parts[0] ?? '')) parts.shift();
  return { ...(year ? { year } : {}), ...(parts[0] ? { region: parts[0] } : {}), genres: parts[1]?.split(/\s+/).filter(value => FORMAL_GENRES.has(value)) ?? [] };
}

export function mediaType(kind: DoubanKind, genres: string[], isShow?: boolean): MediaType {
  if (genres.includes('动画')) return 'anime';
  if (isShow || genres.some(g => ['真人秀', '脱口秀', '综艺'].includes(g))) return 'variety';
  if (genres.includes('纪录片')) return 'doc';
  return kind;
}

export function normalize(value: unknown, fallbackKind: DoubanKind = 'movie'): Normalized | null {
  const wrapper = row(value);
  const source = wrapper.target ? row(wrapper.target) : wrapper;
  if (wrapper.card && wrapper.card !== 'subject') return null;
  const rawKind = text(wrapper.target_type) ?? text(source.type) ?? fallbackKind;
  if (rawKind !== 'movie' && rawKind !== 'tv') return null;
  const id = text(source.id) ?? (typeof source.id === 'number' ? String(source.id) : undefined);
  const title = text(source.title);
  if (!id || !/^\d{1,16}$/.test(id) || !title || title.length > 300) return null;
  const subtitle = subtitleParts(source.card_subtitle);
  // A detail response lists at most three genres; its subtitle carries all of them. A work whose
  // fourth genre is 动画 or 纪录片 would otherwise change channel when its detail is opened.
  const genres = [...new Set([...strings(source.genres), ...subtitle.genres])];
  // Listings and details carry the poster as `pic`; some collections (movie_latest) carry it
  // as an object under `cover` instead, older rows as a plain `cover` or `cover_url` string.
  const poster = imageUrl(row(source.pic).large) ?? imageUrl(row(source.pic).normal) ?? imageUrl(source.cover_url) ?? imageUrl(source.cover) ?? imageUrl(row(source.cover).url);
  const yearValue = String(source.year ?? subtitle.year ?? '');
  const year = /^\d{4}$/.test(yearValue) ? Number(yearValue) : undefined;
  const score = positive(row(source.rating).value ?? source.rate);
  const region = strings(source.countries).join(' / ') || subtitle.region;
  const totalEpisodes = positive(source.episodes_count);
  const runtimeText = strings(source.durations)[0];
  const runtime = runtimeText ? /^(\d+)\s*分钟$/.exec(runtimeText)?.[1] : undefined;
  const directors = list(source.directors).flatMap(p => text(row(p).name) ?? []);
  const cast = list(source.actors).flatMap(p => {
    const name = text(row(p).name);
    const role = text(row(p).character);
    return name ? [{ name, ...(role ? { role } : {}) } satisfies Person] : [];
  });
  const item: MediaItem = {
    id: `db-${id}`, title, type: mediaType(rawKind, genres, source.is_show === true), genres, poster,
    backdrop: list(source.photos).map(imageUrl).find(Boolean) ?? null,
    ...(year ? { year } : {}), ...(region ? { region } : {}),
    ...(score && score <= 10 ? { score } : {}),
    ...(text(source.original_title) ? { originalTitle: text(source.original_title) } : {}),
    ...(text(source.intro) ? { synopsis: text(source.intro) } : {}),
    ...(runtime && Number(runtime) > 0 ? { runtime: Number(runtime) } : {}),
    ...(directors.length ? { directors } : {}), ...(cast.length ? { cast } : {}),
  };
  // episodes/status/episodeTitles refer to playable content in the design contract.
  // Never copy Douban's nominal count or vendor availability into these fields.
  const tags = list(source.tags).flatMap(value => typeof value === 'string' ? [value] : (text(row(value).name)?.split(/\s+/) ?? []));
  const aliases = strings(source.aka).filter(value => value.length <= 120).slice(0, 30);
  return { item, kind: rawKind, ...(totalEpisodes && Number.isInteger(totalEpisodes) ? { totalEpisodes } : {}), ...(tags.length ? { tags } : {}), ...(aliases.length ? { aliases } : {}) };
}

export function requiredArray(value: unknown, field?: string): unknown[] {
  const result = field ? row(value)[field] : value;
  if (!Array.isArray(result)) throw new DataError('INVALID_RESPONSE', `Missing ${field ?? 'array'} in metadata response`);
  return result;
}

/** The principal list is this long at most (measured 2026-11-17 on 45 titles: four to eight rows, docs/evidence/people-audit.json). */
const PRINCIPAL_ROWS = 8;
/**
 * The people Douban puts on a title's own page (`credits`): its directors, then its leading actors
 * in billing order, then the heads of other departments. Someone with several jobs has a row for
 * each; here they are one person whose jobs are joined. `cast` are the rows listed as actors.
 *
 * What stands under a name is Douban's own short text (`simple_character`): the job for the crew
 * (导演, 编剧), the part for an actor (饰 …, 配 …, 主持人, 自己).
 */
export function principalCredits(value: unknown): { people: Credit[]; cast: Person[] } {
  const people: Credit[] = [], cast: Person[] = [];
  const known = new Map<string, Credit>();
  for (const entry of requiredArray(value, 'items').slice(0, PRINCIPAL_ROWS)) {
    const source = row(entry);
    const name = text(source.name);
    if (!name || name.length > 100) continue;
    const rawId = text(source.id) ?? (typeof source.id === 'number' ? String(source.id) : '');
    const id = /^\d{1,16}$/.test(rawId) ? rawId : undefined;
    const category = text(source.category);
    const role = (text(source.simple_character) ?? category)?.slice(0, 200);
    if (category === '演员' && !cast.some(person => person.name === name)) cast.push({ name, ...(role ? { role } : {}) });
    const key = id ?? `name:${name}`;
    const listed = known.get(key);
    if (listed) {
      if (role && !listed.role?.split(' / ').includes(role)) listed.role = listed.role ? `${listed.role} / ${role}` : role;
      continue;
    }
    const photo = portraitUrl(row(source.avatar).normal) ?? portraitUrl(row(source.avatar).large);
    const person: Credit = { name, ...(role ? { role } : {}), ...(id ? { id } : {}), ...(photo ? { photo } : {}) };
    known.set(key, person);
    people.push(person);
  }
  return { people, cast };
}

export function landscapePhoto(value: unknown): string | null {
  const choices = requiredArray(value, 'photos').flatMap(p => {
    const im = row(row(p).image);
    const large = row(im.large);
    const width = positive(large.width);
    const height = positive(large.height);
    const url = imageUrl(large.url);
    if (im.is_animated === true || !width || !height || !url || width < 600 || width / height < 1.3 || width / height > 2.8) return [];
    return [{ url, fit: Math.min(width, 1920) - Math.abs(width / height - 16 / 9) * 200 }];
  });
  return choices.sort((a, b) => b.fit - a.fit)[0]?.url ?? null;
}

// Read-only live endpoint audit. Saves only public content metadata and response shapes.
import { writeFile } from 'node:fs/promises';

const mobile = 'https://m.douban.com';
const queries = [
  ['home-list', 'https://movie.douban.com/j/search_subjects?type=movie&tag=热门&sort=recommend&page_limit=8&page_start=0'],
  ['channel-tv', `${mobile}/rexxar/api/v2/tv/recommend?start=0&count=8&sort=U&tags=悬疑`],
  ['channel-movie', `${mobile}/rexxar/api/v2/movie/recommend?start=0&count=8&sort=S&tags=中国大陆,2025`],
  ['channel-variety', `${mobile}/rexxar/api/v2/tv/recommend?start=0&count=8&sort=U&tags=综艺`],
  ['channel-anime', `${mobile}/rexxar/api/v2/tv/recommend?start=0&count=8&sort=U&tags=动画`],
  ['channel-documentary', `${mobile}/rexxar/api/v2/movie/recommend?start=0&count=8&sort=U&tags=纪录片`],
  ['search', `${mobile}/rexxar/api/v2/search/movie?q=三体&start=0&count=20`],
  ['suggest-official', 'https://movie.douban.com/j/subject_suggest?q=三体'],
  ['suggest-mirror', 'https://movie.douban.cmliussss.net/j/subject_suggest?q=三体'],
  ['detail-tv', `${mobile}/rexxar/api/v2/tv/26647087`],
  ['detail-movie', `${mobile}/rexxar/api/v2/movie/1292052`],
  ['credits', `${mobile}/rexxar/api/v2/tv/26647087/celebrities`],
  ['photos', `${mobile}/rexxar/api/v2/tv/26647087/photos?count=8`],
  ['related-tv', `${mobile}/rexxar/api/v2/tv/26647087/recommendations?count=14`],
  ['related-movie', `${mobile}/rexxar/api/v2/movie/1292052/recommendations?count=14`],
  ['chart-real-time', `${mobile}/rexxar/api/v2/subject_collection/movie_real_time_hotest/items?start=0&count=10`],
  ['chart-tv', `${mobile}/rexxar/api/v2/subject_collection/tv_hot/items?start=0&count=10`],
  ['chart-weekly', `${mobile}/rexxar/api/v2/subject_collection/movie_weekly_best/items?start=0&count=10`],
  ['unavailable-hot-queries', `${mobile}/rexxar/api/v2/search/hot_queries`],
  ['ignored-year-range', `${mobile}/rexxar/api/v2/movie/recommend?start=0&count=4&sort=U&year_range=1900,2019`],
];

const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', Referer: 'https://m.douban.com/' };
const selectItem = (row) => {
  const it = row.target ?? row;
  return {
    id: it.id, title: it.title, type: row.target_type ?? it.type, year: it.year,
    score: it.rating?.value ?? it.rate, genres: it.genres, subtitle: it.card_subtitle,
    hasPoster: Boolean(it.pic?.normal || it.cover_url || it.cover),
    photoCount: it.photos?.length, episodeCount: it.episodes_count,
    episodeStatus: it.episodes_info, runtime: it.durations,
    actorCount: it.actors?.length, directorCount: it.directors?.length,
    hasSynopsis: Boolean(it.intro), originalTitle: it.original_title || undefined,
    fieldNames: Object.keys(it),
  };
};
const result = { checkedAt: new Date().toISOString(), runtime: process.version, source: 'live network, no cookies or keys supplied', rounds: [] };
for (let round = 1; round <= 2; round++) {
  const records = [];
  for (let i = 0; i < queries.length; i += 3) {
    records.push(...await Promise.all(queries.slice(i, i + 3).map(async ([name, url]) => {
      const started = Date.now();
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
        const body = await r.text();
        let value;
        try { value = JSON.parse(body); } catch { return { name, url, status: r.status, ms: Date.now() - started, error: 'non-JSON response' }; }
        const array = Array.isArray(value) ? value : value.items ?? value.subjects ?? value.subject_collection_items ?? value.photos;
        const rows = Array.isArray(array) ? array : undefined;
        return {
          name, url, status: r.status, ms: Date.now() - started, bytes: Buffer.byteLength(body),
          rootFields: Object.keys(value), count: rows?.length,
          subjectCount: rows?.filter(x => !x.card || x.card === 'subject').length,
          items: rows?.filter(x => !x.card || x.card === 'subject').slice(0, 3).map(selectItem),
          detail: value.id ? selectItem(value) : undefined,
          credits: value.actors ? { actorCount: value.actors.length, directorCount: value.directors?.length, firstActor: { name: value.actors[0]?.name, role: value.actors[0]?.character } } : undefined,
          categories: value.recommend_categories?.map(x => ({ type: x.type, choices: x.data?.map(y => y.text) })),
          error: value.msg, chartName: value.subject_collection?.name,
        };
      } catch (error) {
        return { name, url, ms: Date.now() - started, error: error.name };
      }
    })));
  }
  result.rounds.push({ round, records });
}
await writeFile(new URL('./douban-audit.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
for (const round of result.rounds) console.log(JSON.stringify({ round: round.round, results: round.records.map(({ name, status, ms, count, error }) => ({ name, status, ms, count, error })) }));

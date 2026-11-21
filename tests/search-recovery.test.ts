import { describe, expect, it, vi } from 'vitest';
import { DoubanDataSource } from '../src/main/data/douban';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const subject = (id: string, title: string) => ({ id, title, type: 'tv', genres: ['动画'], episodes_count: 10, rating: { value: 8.1 } });
const hint = (id: string, title: string, patch = {}) => ({ id, title, type: 'movie', url: `https://movie.douban.com/subject/${id}/`, ...patch });
const fetcher = (fn: (url: URL) => Response) => vi.fn((input: string | URL | Request) => fn(new URL(String(input)))) as unknown as typeof fetch;

describe('search endpoint recovery', () => {
  it('filters unrelated raw initials results while preserving ordinary English queries', async () => {
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (!url.pathname.endsWith('/search/movie')) throw new Error(`Unexpected request ${url.pathname}`);
      const q = url.searchParams.get('q');
      return reply({ total: 2, items: q === 'LBXX' ? [subject('1', '蜡笔小新'), subject('9', '暗域魔舰')]
        : q === '蜡笔小新' ? [subject('1', '蜡笔小新')]
        : q === 'Interstellar' ? [subject('10', '星际穿越'), subject('11', '星际穿越：从科学到银幕')]
        : [] });
    }) });
    expect((await data.search('LBXX')).map(item => item.id)).toEqual(['db-1']);
    expect((await data.search('Interstellar')).map(item => item.id)).toEqual(['db-10', 'db-11']);
  });

  it('recovers a blocked initials search from public suggestions and canonical metadata', async () => {
    const fetch = fetcher(url => {
      if (url.pathname.endsWith('/search/movie')) return reply({}, 403);
      if (url.pathname === '/j/subject_suggest') return reply(url.searchParams.get('q') === '蜡笔小新' ? [
        hint('1431683', '蜡笔小新'), hint('100', 'not a film', { type: 'celebrity' }),
        hint('200', 'invalid link', { url: 'https://movie.douban.com.attacker.invalid/subject/200/' }),
      ] : []);
      if (url.pathname.endsWith('/movie/1431683')) return reply(subject('1431683', '蜡笔小新'));
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const data = new DoubanDataSource({ fetch, imageUrl: url => url });
    const results = await data.search('LBXX');
    expect(results.map(item => item.id)).toEqual(['db-1431683']);
    expect(results[0].type).toBe('anime');
    expect(results[0].score).toBe(8.1);
    expect(results[0]).not.toHaveProperty('episodes');
    expect((await data.suggest('LBXX')).map(item => item.id)).toEqual(['db-1431683']);
    const requested = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(requested).not.toContain('/rexxar/api/v2/movie/100');
    expect(requested).not.toContain('/rexxar/api/v2/movie/200');
  });

  it('keeps verified matches when one fallback subject is unavailable', async () => {
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (url.pathname.endsWith('/search/movie')) return reply({}, 403);
      if (url.pathname === '/j/subject_suggest') return reply([hint('1', 'first'), hint('2', 'second')]);
      if (url.pathname.endsWith('/movie/1') || url.pathname.endsWith('/tv/1')) return reply({}, 404);
      if (url.pathname.endsWith('/movie/2')) return reply(subject('2', '第二部'));
      throw new Error(`Unexpected request ${url.pathname}`);
    }) });
    expect((await data.search('第二部')).map(item => item.id)).toEqual(['db-2']);
  });

  it('keeps the first search page when a later page is blocked', async () => {
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (url.pathname.endsWith('/search/movie') && url.searchParams.get('start') === '0') return reply({ total: 51, items: [subject('3', '蜡笔小新')] });
      if (url.pathname.endsWith('/search/movie')) return reply({}, 403);
      throw new Error('Successful first-page search should not need a fallback');
    }) });
    expect((await data.search('蜡笔小新')).map(item => item.id)).toEqual(['db-3']);
  });

  it('does not report an empty initials result when the Chinese query failed', async () => {
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (url.pathname.endsWith('/search/movie')) return url.searchParams.get('q') === 'LBXX'
        ? reply({ total: 0, items: [] }) : reply({}, 403);
      if (url.pathname === '/j/subject_suggest') return reply([hint('1431683', '蜡笔小新')]);
      if (url.pathname.endsWith('/movie/1431683')) return reply({}, 400);
      throw new Error(`Unexpected request ${url.pathname}`);
    }) });
    await expect(data.search('LBXX')).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('keeps a blocked search retryable when both suggestion fallbacks are empty', async () => {
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (url.pathname.endsWith('/search/movie')) return reply({}, 403);
      if (url.pathname === '/j/subject_suggest') return reply([]);
      if (url.pathname === '/j/search_suggest') return reply({ cards: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }) });
    await expect(data.search('未命中的查询')).rejects.toMatchObject({ code: 'UPSTREAM' });
    await expect(data.search('另一个查询')).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('retries the primary query immediately after fallback could not verify a match', async () => {
    let blocked = true;
    const data = new DoubanDataSource({ imageUrl: url => url, fetch: fetcher(url => {
      if (url.pathname.endsWith('/search/movie')) return blocked ? reply({}, 403)
        : reply({ total: 1, items: [subject('26647087', '三体')] });
      if (url.pathname === '/j/subject_suggest') return reply([]);
      if (url.pathname === '/j/search_suggest') return reply({ cards: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }) });
    await expect(data.search('三体')).rejects.toMatchObject({ code: 'UPSTREAM' });
    blocked = false;
    expect((await data.search('三体')).map(item => item.id)).toEqual(['db-26647087']);
  });
});

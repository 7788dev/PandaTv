import { createServer, type ServerResponse } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Source = 'a' | 'b' | 'c'
type Behaviour = 'normal' | 'json' | 'empty' | 'offline'
export type NetworkCall = { host: string; path: string; q?: string; start?: string; range?: string; status: number }
export function card(id: number, type = 'movie', genre = '剧情') {
  const first = id % 1000 === 1
  const title = type === 'tv' ? first ? '回归剧集' : id % 1000 === 2 ? '回归剧集 第二季' : `遥控与键盘回归剧集 第${id % 1000}部`
    : first ? '回归影片' : `中文与数字混排的布局回归影片 第${id % 1000}部`
  return { id: String(id), title, type, year: '2023', genres: [genre], countries: ['中国大陆'],
    rating: { value: 8.6 }, card_subtitle: `2023 / 中国大陆 / ${genre} / 回归导演`,
    cover: { url: `https://img1.doubanio.com/quality/${id}.png` }, pic: { large: `https://img1.doubanio.com/quality/${id}.png` },
    episodes_count: type === 'tv' ? 3 : undefined, durations: type === 'movie' ? ['2分钟'] : undefined,
    intro: '用于真实前端回归的网络响应：中文、数字 2023、长标题和分页都由应用本身渲染。' }
}
export async function qualityNetwork() {
  const media = resolve('.tmp/quality-fixtures/media')
  if (!statSync(join(media, '720/playback.mp4')).isFile()) throw new Error('Run scripts/generate-fixture-hls.py before fixture E2E')
  const calls: NetworkCall[] = []
  const state = { metadataOffline: false, metadataDelayMs: 0, sources: { a: 'json', b: 'normal', c: 'normal' } as Record<Source, Behaviour>, holdPlayback: false }
  const held = new Set<() => void>()
  const json = (res: ServerResponse, value: unknown, status = 200) => { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length }); res.end(body) }
  const server = createServer(async (req, res) => {
    const host = String(req.headers.host).split(':')[0]
    const url = new URL(req.url ?? '/', 'https://' + host)
    const record: NetworkCall = { host, path: url.pathname, q: url.searchParams.get('q') ?? url.searchParams.get('wd') ?? undefined,
      start: url.searchParams.get('start') ?? undefined, range: req.headers.range, status: 200 }
    calls.push(record)
    if (host.includes('.catalog.qa.')) {
      const source = host[0] as Source
      const title = url.searchParams.get('wd') || '回归影片'
      const tv = title.includes('剧集')
      const format = tv ? 'm3u8' : 'mp4'
      const titled = title.includes('第二季')
      const episodes = (tv ? [1, 2, 3] : [1]).map(n => `${titled ? ['序章', '转折', '回家'][n - 1] : `第${n}集`}$https://${source}.media.qa.example.org/episode-${n}.${format}`)
      if (tv && !titled) episodes.unshift(`彩蛋$https://${source}.media.qa.example.org/bonus.mp4`, episodes[0])
      const remake = { vod_id: 2, vod_name: title, vod_year: '2023', vod_area: '美国', type_name: '欧美剧', vod_play_from: format,
        vod_play_url: Array.from({ length: 8 }, (_, i) => `第${i + 1}集$https://${source}.media.qa.example.org/episode-9.${format}`).join('#') }
      json(res, { list: [...(tv ? [remake] : []), { vod_id: 1, vod_name: title, vod_year: '2023', vod_area: '中国大陆', type_name: tv ? '电视剧' : '电影', vod_play_from: format,
        vod_play_url: episodes.join('#') }], pagecount: 1 })
      return
    }
    if (host.includes('.media.qa.')) {
      const source = host[0] as Source, behaviour = state.sources[source]
      if (behaviour === 'offline') { record.status = 503; json(res, { error: 'Injected media failure' }, 503); return }
      if (behaviour === 'json') { json(res, { error: 'Successful HTTP response without media' }); return }
      if (behaviour === 'empty') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 0 }); res.end(); return }
      const quality = source === 'c' ? '1080' : source === 'b' ? '720' : '480'
      if (/episode-\d+\.m3u8$/.test(url.pathname)) {
        const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=854x480\n480/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=1280x720\n720/index.m3u8\n' + (source === 'c' ? '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080/index.m3u8\n' : '')
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(body); return
      }
      const relative = url.pathname.endsWith('.mp4') ? `${quality}/playback.mp4` : url.pathname.replace(/^\//, '')
      const file = join(media, relative)
      if (!file.startsWith(media + '\\') && !file.startsWith(media + '/')) throw new Error('Invalid media fixture path')
      let body: Buffer
      try { body = readFileSync(file) } catch { record.status = 404; json(res, { error: 'Missing transport fixture' }, 404); return }
      if (relative.endsWith('.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(body); return }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      if (start >= body.length) { record.status = 416; res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return }
      const selected = body.subarray(start, end + 1)
      const headers: Record<string, string | number> = { 'content-type': relative.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t', 'content-length': selected.length, 'accept-ranges': 'bytes' }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${body.length}`
      record.status = range ? 206 : 200
      res.writeHead(record.status, headers)
      if (state.holdPlayback && relative.endsWith('.mp4') && req.headers.range !== 'bytes=0-16383' && start === 0) {
        let at = 0
        while (at + 8 <= body.length && body.toString('ascii', at + 4, at + 8) !== 'mdat') { const size = body.readUInt32BE(at); if (size < 8) break; at += size }
        const prefix = Math.min(selected.length, at + 4096)
        res.write(selected.subarray(0, prefix))
        let cursor = prefix
        // Keep the transport alive while the decoder still lacks a complete
        // first sample. These are original file bytes, never inserted padding.
        const pulse = setInterval(() => { if (!res.destroyed && cursor < selected.length) res.write(selected.subarray(cursor, ++cursor)) }, 1000)
        const release = () => { clearInterval(pulse); held.delete(release); if (!res.destroyed) res.end(selected.subarray(cursor)) }
        held.add(release); res.once('close', () => { clearInterval(pulse); held.delete(release) })
      } else res.end(selected)
      return
    }
    if (host === 'img1.doubanio.com') { const body = readFileSync(join(media, 'poster.png')); res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length }); res.end(body); return }
    if (state.metadataDelayMs) await new Promise(resolve => setTimeout(resolve, state.metadataDelayMs))
    if (res.destroyed) return
    if (state.metadataOffline) { record.status = 503; json(res, { error: 'Injected metadata outage' }, 503); return }
    if (host === 'movie.douban.com' && url.pathname === '/j/subject_suggest') {
      json(res, [2001, 1001].map(id => ({ id: String(id), title: card(id, id === 2001 ? 'tv' : 'movie').title, type: 'movie', url: `https://movie.douban.com/subject/${id}/` }))); return
    }
    if (host === 'www.douban.com' && url.pathname === '/j/search_suggest') {
      json(res, { cards: [2001, 1001].map(id => ({ id: String(id), type: 'movie', url: `https://movie.douban.com/subject/${id}/` })) }); return
    }
    const path = url.pathname.replace(/^\/(?:rexxar\/)?api\/v2\//, '')
    const type = /(?:^|[_/])tv|animation|variety|documentary/.test(path) ? 'tv' : 'movie'
    const base = type === 'tv' ? 2001 : 1001
    const start = Number(url.searchParams.get('start') ?? 0), count = Number(url.searchParams.get('count') ?? 30)
    const genre = decodeURIComponent(url.search).includes('动作') ? '动作' : '剧情'
    const rows = Array.from({ length: Math.max(0, Math.min(count, 60 - start)) }, (_, i) => card(base + start + i, type, genre))
    if (/^celebrity\/\d+\/works$/.test(path)) { json(res, { total: 60, count, works: rows.map(work => ({ work })) }); return }
    if (/^celebrity\/\d+$/.test(path)) { json(res, { title: '回归影人', cover: { normal: { url: 'https://img1.doubanio.com/quality/person.png' } } }); return }
    if (/\/(?:credits)$/.test(path)) { json(res, { items: [{ id: '1001', name: '回归影人', category: '演员', simple_character: '饰 主角', avatar: { normal: 'https://img1.doubanio.com/quality/person.png' } }] }); return }
    if (/\/photos$/.test(path)) { json(res, { photos: [{ image: { large: { width: 854, height: 480, url: 'https://img1.doubanio.com/quality/backdrop.png' } } }] }); return }
    if (/\/recommendations$/.test(path)) { json(res, rows); return }
    const subject = /^(movie|tv)\/(\d+)$/.exec(path)
    if (subject) { const id = Number(subject[2]); json(res, card(id, id >= 2000 && id < 3000 ? 'tv' : 'movie')); return }
    if (/search|suggest/.test(path)) { json(res, { total: 2, count: 50, items: [card(2001, 'tv'), card(1001)] }); return }
    if (host === 'top.baidu.com') { json(res, { success: true, data: { cards: [] } }); return }
    json(res, { total: 60, count, items: rows, subjects: rows, subject_collection_items: rows })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, state, calls,
    releasePlayback: () => { state.holdPlayback = false; for (const release of [...held]) release() },
    close: async () => { for (const release of [...held]) release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

import { expect, it } from 'vitest'
import { hlsChapters, mp4Chapters } from '../src/main/playback/chapters'

it('maps VOD date ranges to the media clock using segment anchors', () => {
  const text = [
    '#EXTM3U', '#EXTINF:4,', '1.ts', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T08:00:00+08:00',
    '#EXT-X-DATERANGE:ID="a,b",X-TITLE="片头",START-DATE="2026-01-01T00:00:01Z",DURATION=2.5',
    '#EXT-X-DATERANGE:ID="ed",CLASS="chapter.credits",START-DATE="2026-01-01T00:00:04Z"',
    '#EXTINF:6,', '2.ts', '#EXT-X-ENDLIST',
  ].join('\n')
  expect(hlsChapters(text)).toEqual({ intro: { start: 5, end: 7.5 }, outro: 8 })
  expect(hlsChapters(text.replace('#EXT-X-ENDLIST', ''))).toEqual({})
  expect(hlsChapters(text.replace('PROGRAM-DATE-TIME', 'UNKNOWN'))).toEqual({})
  expect(hlsChapters(text.replace('DURATION=2.5', 'DURATION=200'))).toEqual({ outro: 8 })
})

it('reads named MP4 chapters inside moov/udta and declines incomplete or unrecognized metadata', () => {
  function box(type: string, data: Buffer) {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length + 8); header.write(type, 4, 'ascii')
    return Buffer.concat([header, data])
  }
  function mark(seconds: number, label: string) {
    const text = Buffer.from(label), header = Buffer.alloc(9)
    header.writeBigUInt64BE(BigInt(seconds) * 10_000_000n); header[8] = text.length
    return Buffer.concat([header, text])
  }
  const entries = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 3]), mark(0, 'Opening'), mark(4, '正片'), mark(18, '片尾')])
  const movie = box('moov', box('udta', box('chpl', entries)))
  expect(mp4Chapters(movie, 20)).toEqual({ intro: { start: 0, end: 4 }, outro: 18 })
  expect(mp4Chapters(movie.subarray(0, -1), 20)).toEqual({})
  expect(mp4Chapters(box('mdat', movie), 20)).toEqual({})
  expect(mp4Chapters(movie, 10)).toEqual({})
})

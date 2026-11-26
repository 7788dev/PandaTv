import { describe, expect, it } from 'vitest'
import { hlsDuration, manifestFingerprint, mp4Duration } from '../src/main/playback/duration'

describe('source duration', () => {
  it('adds every filtered EXTINF value', () => {
    const text = '#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:12.5,\nb.ts\n#EXT-X-ENDLIST\n'
    const reading = hlsDuration(text)
    expect(reading.source).toBe('hls-extinf')
    expect(reading.seconds).toBe(22.5)
    expect(reading.fingerprint).toBe(manifestFingerprint(text))
  })

  it('does not invent a duration for a playlist without segments', () => {
    const reading = hlsDuration('#EXTM3U\n#EXT-X-ENDLIST\n')
    expect(reading).toEqual({ seconds: null, source: 'missing', fingerprint: null })
  })

  it('does not treat a rolling live playlist window as the episode duration', () => {
    const reading = hlsDuration('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n')
    expect(reading).toEqual({ seconds: null, source: 'missing', fingerprint: null })
  })

  it('reads a version 0 mvhd box', () => {
    const head = Buffer.alloc(40)
    head.writeUInt32BE(40, 0)
    head.write('mvhd', 4, 'ascii')
    head[8] = 0
    head.writeUInt32BE(1000, 20)
    head.writeUInt32BE(120_000, 24)
    expect(mp4Duration(head)).toMatchObject({ seconds: 120, source: 'mp4-moov' })
  })

  it('reads a version 1 mvhd box', () => {
    const head = Buffer.alloc(48)
    head.writeUInt32BE(48, 0)
    head.write('mvhd', 4, 'ascii')
    head[8] = 1
    head.writeUInt32BE(1000, 28)
    head.writeBigUInt64BE(120_000n, 32)
    expect(mp4Duration(head)).toMatchObject({ seconds: 120, source: 'mp4-moov' })
  })

  it.each([0, 1])('treats an incomplete version %i mvhd as missing', version => {
    const required = version === 1 ? 40 : 28
    const head = Buffer.alloc(required)
    head.write('mvhd', 4, 'ascii')
    head[8] = version
    head.writeUInt32BE(1000, version === 1 ? 28 : 20)
    if (version === 1) head.writeBigUInt64BE(120_000n, 32)
    else head.writeUInt32BE(120_000, 24)
    for (let length = 0; length < required; length++) {
      expect(mp4Duration(head.subarray(0, length)), `prefix of ${length} bytes`).toEqual({
        seconds: null, source: 'missing', fingerprint: null,
      })
    }
    expect(mp4Duration(head)).toMatchObject({ seconds: 120, source: 'mp4-moov' })
  })

  it('does not interpret an unsupported mvhd version as version 0', () => {
    const head = Buffer.alloc(40)
    head.write('mvhd', 4, 'ascii')
    head[8] = 2
    head.writeUInt32BE(1000, 20)
    head.writeUInt32BE(120_000, 24)
    expect(mp4Duration(head).source).toBe('missing')
  })

  it('returns missing when the header has no moov', () => {
    expect(mp4Duration(Buffer.from('000000186674797069736f6d', 'hex'))).toEqual({
      seconds: null,
      source: 'missing',
      fingerprint: null,
    })
  })
})

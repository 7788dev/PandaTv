import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { clearHead, pictureOf } from '../src/main/playback/picture'
import captured from './fixtures/segment-heads.json'

describe('the picture a segment holds', () => {
  it.each(captured.heads.map(entry => [entry.source, entry.title, entry.picture, entry.head] as const))('reads %s, %s: %s', (_source, _title, picture, head) => {
    const size = pictureOf(Buffer.from(head, 'base64'))
    expect(size && `${size.width}x${size.height}`).toBe(picture)
  })

  it('reads it from the head of a segment that is encrypted whole, whatever length has arrived', () => {
    const clear = Buffer.from(captured.heads[0]!.head, 'base64')
    const key = Buffer.from('0123456789abcdef'), iv = Buffer.alloc(16, 9)
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    const sealed = Buffer.concat([cipher.update(Buffer.concat([clear, Buffer.alloc(5000, 1)])), cipher.final()])
    expect(pictureOf(sealed)).toBeUndefined()
    // 1001 bytes is not a whole number of cipher blocks: the complete ones are read.
    expect(pictureOf(clearHead(sealed.subarray(0, 1001), key, iv))).toEqual({ width: 1920, height: 1080 })
    expect(clearHead(sealed.subarray(0, 10), key, iv)).toHaveLength(0)
    expect(pictureOf(clearHead(sealed.subarray(0, 1001), Buffer.alloc(16, 1), iv))).toBeUndefined()
    expect(clearHead(sealed, Buffer.alloc(5), iv)).toHaveLength(0)
  })

  it('says nothing of what it cannot read', () => {
    const head = Buffer.from(captured.heads[0]!.head, 'base64')
    expect(pictureOf(Buffer.alloc(0))).toBeUndefined()
    expect(pictureOf(Buffer.from('<html>not a segment</html>'))).toBeUndefined()
    expect(pictureOf(Buffer.alloc(4000, 0x47))).toBeUndefined()
    // The first three packets are tables; the picture is described in the fourth.
    expect(pictureOf(head.subarray(0, 564))).toBeUndefined()
    // A parameter set cut off anywhere is not guessed at.
    for (let cut = 565; cut < 620; cut += 3) {
      const size = pictureOf(head.subarray(0, cut))
      expect(size === undefined || (size.width === 1920 && size.height === 1080)).toBe(true)
    }
    // An audio stream that happens to contain the same bytes is not a picture.
    const audio = Buffer.from(head)
    for (let at = 0; at + 188 <= audio.length; at += 188) {
      const from = at + 4 + ((audio[at + 3]! >> 4) & 2 ? 1 + audio[at + 4]! : 0)
      if (audio[from] === 0 && audio[from + 1] === 0 && audio[from + 2] === 1 && (audio[from + 3]! & 0xf0) === 0xe0) audio[from + 3] = 0xc0
    }
    expect(pictureOf(audio)).toBeUndefined()
  })
})

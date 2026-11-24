import { expect, it } from 'vitest'
import { isMp4Head } from '../src/main/playback/media-head'

const ftyp = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
it('accepts MP4 headers without depending on a front-positioned movie index', () => {
  expect(isMp4Head(ftyp)).toBe(true)
  expect(isMp4Head(Buffer.concat([Buffer.from('0000000866726565', 'hex'), ftyp]))).toBe(true)
  expect(isMp4Head(Buffer.from('000000106d6461740001020304050607', 'hex'))).toBe(true)
  expect(isMp4Head(Buffer.from('000000006d64617400010203', 'hex'))).toBe(true)
  expect(isMp4Head(Buffer.from('0000000166747970000000000000002069736f6d00000000', 'hex'))).toBe(true)
})
it.each([Buffer.alloc(0), Buffer.from('{}'), Buffer.from('<html>offline</html>'), Buffer.alloc(24), ftyp.subarray(0, 7), ftyp.subarray(0, 12), Buffer.from('000000046674797069736f6d00000000', 'hex'), Buffer.from('0000000177696465ffffffffffffffff', 'hex')])('rejects empty, non-media and malformed or incomplete headers (%#)', head => {
  expect(isMp4Head(head)).toBe(false)
})

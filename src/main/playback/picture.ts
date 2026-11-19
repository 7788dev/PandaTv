import { createDecipheriv } from 'node:crypto'

export interface Picture { width: number; height: number }

/** Bits of an H.264 parameter set. Reading past the end throws: the data is whatever a source sent. */
class Bits {
  private at = 0
  constructor(private readonly bytes: number[]) {}
  bit(): number {
    if (this.at >= this.bytes.length * 8) throw new RangeError('parameter set ends early')
    const value = (this.bytes[this.at >> 3]! >> (7 - (this.at & 7))) & 1
    this.at++
    return value
  }
  read(count: number): number { let value = 0; for (let i = 0; i < count; i++) value = value * 2 + this.bit(); return value }
  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0
    while (!this.bit()) if (++zeros > 31) throw new RangeError('parameter set is not Exp-Golomb coded')
    return 2 ** zeros - 1 + (zeros ? this.read(zeros) : 0)
  }
  /** Signed Exp-Golomb. */
  se(): number { const value = this.ue(); return value & 1 ? (value + 1) / 2 : -(value / 2) }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134])

/** The picture size an H.264 sequence parameter set declares (ITU-T H.264, 7.3.2.1.1), cropping applied. */
function sequencePicture(nal: Uint8Array): Picture {
  // Without the emulation prevention bytes (00 00 03 → 00 00) and the one-byte NAL header.
  const bytes: number[] = []
  for (let i = 1; i < nal.length; i++) { if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; bytes.push(nal[i]!) }
  const bits = new Bits(bytes)
  const profile = bits.read(8); bits.read(16); bits.ue()
  let chroma = 1
  if (HIGH_PROFILES.has(profile)) {
    chroma = bits.ue(); if (chroma === 3) bits.bit()
    bits.ue(); bits.ue(); bits.bit()
    if (bits.bit()) for (let list = 0; list < (chroma !== 3 ? 8 : 12); list++) {
      if (!bits.bit()) continue
      let last = 8, next = 8
      for (let j = 0; j < (list < 6 ? 16 : 64); j++) { if (next) next = (last + bits.se() + 256) % 256; last = next || last }
    }
  }
  bits.ue()
  const order = bits.ue()
  if (order === 0) bits.ue()
  else if (order === 1) { bits.bit(); bits.se(); bits.se(); const cycle = bits.ue(); if (cycle > 255) throw new RangeError('implausible parameter set'); for (let i = 0; i < cycle; i++) bits.se() }
  bits.ue(); bits.bit()
  const widthUnits = bits.ue() + 1, heightUnits = bits.ue() + 1, frames = bits.bit()
  if (!frames) bits.bit()
  bits.bit()
  let left = 0, right = 0, top = 0, bottom = 0
  if (bits.bit()) { left = bits.ue(); right = bits.ue(); top = bits.ue(); bottom = bits.ue() }
  const cropX = chroma === 0 || chroma === 3 ? 1 : 2, cropY = (chroma === 1 ? 2 : 1) * (2 - frames)
  return { width: widthUnits * 16 - (left + right) * cropX, height: (2 - frames) * heightUnits * 16 - (top + bottom) * cropY }
}

/**
 * The size of the picture in the head of an MPEG-TS segment, read from its first H.264
 * sequence parameter set. This is what the stream holds, which is not always what its playlist
 * says: sources were measured declaring 1080x608 over 1920x1080 pictures and the reverse.
 * Undefined when the head is not MPEG-TS, carries no H.264 video, or does not reach that far.
 */
export function pictureOf(head: Uint8Array): Picture | undefined {
  try {
    let start = 0
    while (start + 188 < head.length && !(head[start] === 0x47 && head[start + 188] === 0x47)) start++
    const streams = new Map<number, Uint8Array[]>()
    for (let at = start; at + 188 <= head.length; at += 188) {
      if (head[at] !== 0x47) continue
      const pid = ((head[at + 1]! & 0x1f) << 8) | head[at + 2]!, adaptation = (head[at + 3]! >> 4) & 3
      let from = at + 4
      if (adaptation & 2) from += 1 + head[at + 4]!
      if (!(adaptation & 1) || from >= at + 188) continue
      const parts = streams.get(pid) ?? []
      parts.push(head.subarray(from, at + 188)); streams.set(pid, parts)
    }
    for (const parts of streams.values()) {
      const first = parts[0]!
      // Video only: a packetized elementary stream whose id is E0–EF.
      if (first.length < 4 || first[0] !== 0 || first[1] !== 0 || first[2] !== 1 || (first[3]! & 0xf0) !== 0xe0) continue
      const data = Buffer.concat(parts)
      for (let i = 0; i + 4 < data.length; i++) {
        // A start code, then a NAL header: forbidden bit clear, type 7.
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1 || (data[i + 3]! & 0x9f) !== 7) continue
        const next = data.indexOf(Buffer.from([0, 0, 1]), i + 4)
        try {
          const picture = sequencePicture(data.subarray(i + 3, next < 0 ? Math.min(data.length, i + 3 + 256) : next))
          if (picture.width >= 64 && picture.width <= 16384 && picture.height >= 64 && picture.height <= 16384) return picture
        } catch { /* cut off, or not a parameter set after all: keep looking */ }
      }
    }
  } catch { /* nothing readable */ }
  return undefined
}

/** The readable start of a segment encrypted whole with AES-128 (CBC): every complete block of `head`. */
export function clearHead(head: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const whole = head.subarray(0, head.length - head.length % 16)
  if (key.length !== 16 || iv.length !== 16 || !whole.length) return Buffer.alloc(0)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(whole), decipher.final()])
}

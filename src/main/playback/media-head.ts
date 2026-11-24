/** A bounded signature check, independent of the codec or where the MP4 keeps its index. */
export function isMp4Head(head: Uint8Array): boolean {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  for (let at = 0; at + 8 <= head.length;) {
    const shortSize = view.getUint32(at)
    const type = String.fromCharCode(...head.subarray(at + 4, at + 8))
    const header = shortSize === 1 ? 16 : 8
    if (at + header > head.length) return false
    const size = shortSize === 1 ? view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12) : shortSize
    if (!Number.isSafeInteger(size) || (size !== 0 && size < header)) return false
    if (type === 'ftyp') return size >= header + 8 && at + header + 8 <= head.length
    // QuickTime-compatible files may begin with their movie or media box.
    if (['moov', 'mdat', 'moof'].includes(type)) return (size === 0 || size > header) && at + header < head.length
    if (!['free', 'wide', 'skip', 'uuid'].includes(type) || size === 0 || at + size > head.length) return false
    at += size
  }
  return false
}

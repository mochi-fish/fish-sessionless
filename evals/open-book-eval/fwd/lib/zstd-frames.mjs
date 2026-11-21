// DSH 的会话日志（*.zstd）是一条记录一个 zstd 帧、一帧接一帧往后追加的。Node 的 zstdDecompressSync / createZstdDecompress
// 只解第一帧（2026-11-19 实测：42 个日志各只解出约 190 字节的开头一行），所以这里先按 RFC 8878 的帧格式切开，再逐帧解。
// 尾巴上不完整的帧（拷的时候正在写）丢掉；可跳过帧（0x184D2A50–5F）跳过。只读帧头和块头，不解释内容。
import zlib from 'node:zlib'

const MAGIC = 0xFD2FB528

/** 从 off 开始的一帧有多长；不完整或认不出回 -1。 */
function frameLength (buf, off) {
  if (off + 4 > buf.length) return -1
  const magic = buf.readUInt32LE(off)
  if ((magic & 0xFFFFFFF0) >>> 0 === 0x184D2A50) {
    if (off + 8 > buf.length) return -1
    const n = 8 + buf.readUInt32LE(off + 4)
    return off + n <= buf.length ? n : -1
  }
  if (magic !== MAGIC) return -1
  let p = off + 4
  if (p >= buf.length) return -1
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  for (;;) {
    if (p + 3 > buf.length) return -1
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >>> 3
    if (type === 3) return -1
    p += type === 1 ? 1 : size
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p <= buf.length ? p - off : -1
}

/** 逐帧解开，拼成一个字符串。stats 里给帧数、丢掉的尾巴字节数。 */
export function zstdDecompressAll (buf) {
  const parts = []
  let off = 0
  let frames = 0
  let bad = 0
  while (off < buf.length) {
    const n = frameLength(buf, off)
    if (n < 0) break
    if (buf.readUInt32LE(off) === MAGIC) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + n))); frames++ } catch { bad++ }
    }
    off += n
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, badFrames: bad, droppedTailBytes: buf.length - off }
}

// 种子随机数：sha256(种子 + 计数) 串出来的，跨机器、跨 Node 版本都一样。
import { createHash } from 'node:crypto'

export function makeRng (seed) {
  let counter = 0
  let buf = Buffer.alloc(0)
  let off = 0
  const refill = () => { buf = createHash('sha256').update(`${seed}\u0000${counter++}`).digest(); off = 0 }
  const u32 = () => { if (off + 4 > buf.length) refill(); const v = buf.readUInt32BE(off); off += 4; return v }
  const rnd = () => u32() / 0x100000000
  return {
    rnd,
    int: (a, b) => a + Math.floor(rnd() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(rnd() * arr.length)],
    chance: (p) => rnd() < p,
    hex: (n = 6) => { let s = ''; while (s.length < n) s += u32().toString(16).padStart(8, '0'); return s.slice(0, n) },
    shuffle: (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a },
    /** 从 arr 里不重复地取 n 个 */
    sample: (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out },
    fork: (tag) => makeRng(`${seed}/${tag}`),
  }
}

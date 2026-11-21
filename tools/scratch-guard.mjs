// 临时目录的守卫：只认「本工具自己的、专用的」临时目录，才清空、才删。
//
// claimScratchDir(dir, { prefix, keep }) 过了才把 dir 清空重建、放一个记号文件，返回绝对路径；不过就抛（code 'REFUSE'）。
// 条件（字符串那几道先查完、不碰盘，再碰盘）：
//   1. 不是 \\ 开头；不在受保护的数据目录（见 forbiddenRoots）下面。
//   2. 目录名以 prefix 开头（比如 recall-eval-home-）：$TEMP、$TEMP/foo、~/Templates 这类名字一律不认。
//   3. 在 os.tmpdir() 下面，而且不等于它本身。
//   4. 不等于、也不是 keep 里任何一个（包目录、脚本目录、当前目录）的上层；也不在它们下面。
//   5. 存在的那一层取 realpath，也得在 os.tmpdir() 的 realpath 下面（防目录联接）；dir 本身存在的话不许是链接 / 联接。
//   6. dir 存在时，必须是空目录，或者里面有本工具放的记号文件（上一次跑剩下的）。否则不删、不动。
// releaseScratchDir(dir)：只有里面有记号文件才删。
//
// 另外导出两道路径守卫，给「只许读拷贝、不许碰原件」的工具用：
//   refuseByString(p, roots, what)   只比字符串，不碰盘
//   refuseByRealpath(p, roots, what) 存在的那一层取 realpath 再比（防目录联接、符号链接）
// 受保护的目录（forbiddenRoots）：DSH 和 dsh-fish 的数据目录（~/.dsh、~/.dsh-fish、DSH_HOME、DSH_FISH_HOME、dsh-fish 的搬家指针
// ~/.dsh-fish-location.json 里写的根），再加环境变量 SCRATCH_GUARD_EXTRA_FORBIDDEN 里用分号隔开的路径（只能加，不能减）。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const SCRATCH_MARK = '.scratch-guard-mark'

class Refuse extends Error { constructor (msg) { super(msg); this.code = 'REFUSE' } }

const win = process.platform === 'win32'
const norm = (p) => {
  let s = resolve(String(p))
  if (win) s = s.replace(/\//g, '\\').toLowerCase()
  while (s.length > 3 && s.endsWith(sep)) s = s.slice(0, -1)
  return s
}
const under = (p, root) => p.startsWith(root.endsWith(sep) ? root : root + sep)
const underOrSame = (p, root) => p === root || under(p, root)
const real = (p) => { try { return norm(realpathSync.native(p)) } catch { return null } }

/** 受保护的数据目录（字符串，未取 realpath）。 */
export function forbiddenRoots () {
  const h = homedir()
  const roots = [join(h, '.dsh-fish'), join(h, '.dsh')]
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  if (process.env.DSH_FISH_HOME) roots.push(process.env.DSH_FISH_HOME)
  // dsh-fish 的搬家指针（~/.dsh-fish-location.json 的 root）。指针本身不是数据，它指的地方是。
  const loc = process.env.DSH_FISH_LOCATION || join(h, '.dsh-fish-location.json')
  try {
    const v = String(JSON.parse(readFileSync(loc, 'utf8'))?.root ?? '').trim()
    if (v) roots.push(v)
  } catch { /* 没有指针 */ }
  // 只能加，不能减
  for (const p of String(process.env.SCRATCH_GUARD_EXTRA_FORBIDDEN ?? '').split(';')) if (p.trim()) roots.push(p.trim())
  return roots
}

/** 第一道：只比字符串，不碰盘。 */
export function refuseByString (p, roots, what) {
  const raw = String(p ?? '')
  if (!raw) throw new Refuse(`${what}没给`)
  if (/^[\\/]{2}/.test(raw)) throw new Refuse(`${what}用盘符写（\\\\ 开头的路径不认）`)
  const n = norm(raw)
  for (const r of roots) if (underOrSame(n, norm(r))) throw new Refuse(`${what}在受保护的数据目录下面（${r}），拒绝：要先拷出来，再指向拷贝`)
}

/** 第二道：存在的路径取 realpath 再比（防目录联接、符号链接）。 */
export function refuseByRealpath (p, roots, what) {
  let cur = resolve(String(p))
  // 不存在的（比如还没写的输出文件）往上找到存在的那一层
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) return; cur = up }
  const rp = real(cur)
  if (rp === null) throw new Refuse(`${what}取不到真实路径`)
  for (const r of roots) {
    const rr = real(r) ?? norm(r)
    if (underOrSame(rp, rr) || underOrSame(rp, norm(r))) throw new Refuse(`${what}实际指向受保护的数据目录（${r}），拒绝`)
  }
}

export function claimScratchDir (dir, { prefix, keep = [], what = '临时目录' } = {}) {
  if (!prefix) throw new Error('claimScratchDir 要给 prefix')
  const raw = String(dir ?? '')
  // ---- 只比字符串，不碰盘
  refuseByString(raw, forbiddenRoots(), what)
  const abs = resolve(raw)
  const n = norm(abs)
  if (!basename(abs).toLowerCase().startsWith(prefix.toLowerCase())) throw new Refuse(`${what}的名字要以 ${prefix} 开头（这个工具只清它自己的专用目录）`)
  const tmp = norm(tmpdir())
  if (!under(n, tmp)) throw new Refuse(`${what}要在 ${tmpdir()} 下面，而且不能是它本身`)
  for (const k of keep) {
    if (!k) continue
    const nk = norm(k)
    if (n === nk || under(nk, n) || under(n, nk)) throw new Refuse(`${what}和 ${k} 重叠，会删掉它，拒绝`)
  }
  // ---- 碰盘：存在的那一层取 realpath
  let cur = abs
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; cur = up }
  const rc = real(cur)
  const rt = real(tmpdir()) ?? tmp
  const inTmp = (r) => under(r, rt) || under(r, tmp)
  const isTmp = (r) => r === rt || r === tmp
  // 存在的那一层：dir 本身在的话它得在 tmpdir 下面；dir 不在的话，找到的上层可以就是 tmpdir
  if (rc === null || !(inTmp(rc) || (cur !== abs && isTmp(rc)))) throw new Refuse(`${what}实际不在 ${tmpdir()} 下面（目录联接？），拒绝`)
  if (existsSync(abs)) {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) throw new Refuse(`${what}是链接或目录联接，拒绝`)
    if (!st.isDirectory()) throw new Refuse(`${what}已经有了，而且不是目录，拒绝`)
    const ra = real(abs)
    if (ra !== n) throw new Refuse(`${what}实际指向别处，拒绝`)
    for (const k of keep) {
      const rk = k && existsSync(k) ? real(k) : null
      if (rk && (rk === ra || under(rk, ra) || under(ra, rk))) throw new Refuse(`${what}实际和 ${k} 重叠，拒绝`)
    }
    const names = readdirSync(abs)
    if (names.length && !names.includes(SCRATCH_MARK)) throw new Refuse(`${what}已经有东西、又没有本工具的记号（${SCRATCH_MARK}），不清它：换一个新名字，或者自己看过再删`)
    rmSync(abs, { recursive: true, force: true })
  }
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, SCRATCH_MARK), '')
  return abs
}

/** 只删有记号的。 */
export function releaseScratchDir (abs) {
  try {
    if (!lstatSync(abs).isSymbolicLink() && existsSync(join(abs, SCRATCH_MARK))) rmSync(abs, { recursive: true, force: true })
  } catch { /* 没有就算了 */ }
}

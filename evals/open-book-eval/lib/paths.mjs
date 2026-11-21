// 开卷评测架子的固定位置。
// 实验目录：环境变量 OB_EXPERIMENTS；没给就是 %LOCALAPPDATA%/open-book-eval（Windows）或 ~/.local/share/open-book-eval（别的系统）。
// 家目录按系统账户取（os.userInfo().homedir），不跟着 HOME / USERPROFILE 走：
// 架子起子进程时会把 HOME / USERPROFILE / LOCALAPPDATA 换成假家目录，那时再算路径就会算到假的里面去。
// 日子一律按 UTC+8 算（世界日历、账本的时刻都是这个时区），不靠本机时区。
import os from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)))
/** 本仓库的 tools/（offline-guard、netguard、run-exclusive 在那里）。 */
export const REPO_TOOLS = resolve(HERE, '..', '..', 'tools')

/** 本机真正的家目录：按系统账户取，不看 USERPROFILE / HOME（那两个在子进程里会被换掉）。 */
export const REAL_HOME = os.userInfo().homedir
export const EXPERIMENTS = process.env.OB_EXPERIMENTS
  ? resolve(process.env.OB_EXPERIMENTS)
  : (process.platform === 'win32' ? join(REAL_HOME, 'AppData', 'Local', 'open-book-eval') : join(REAL_HOME, '.local', 'share', 'open-book-eval'))

/** UTC+8 的日期 YYYYMMDD。 */
export function localDay (ms = Date.now()) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}
export function experimentRoot (day = localDay()) {
  if (!/^\d{8}$/.test(String(day))) throw new Error(`bad day ${day}`)
  return join(EXPERIMENTS, `open-book-${day}`)
}

/** 跑守卫用的预加载和排队工具（本仓库 tools/ 里的，只读）。 */
export const SOURCES = Object.freeze({
  offlineGuard: join(REPO_TOOLS, 'offline-guard.mjs'),
  netguard: join(REPO_TOOLS, 'netguard.mjs'),
  runExclusive: join(REPO_TOOLS, 'run-exclusive.mjs'),
  // 本架子自己的：碰线上的根就抛
  noLiveFs: join(HERE, 'guards', 'no-live-fs.mjs'),
})

/** 线上代理（billion-context）的端口段：不许连、不许听（它首选 18787，被占往上顺延）。 */
export const LIVE_PORT_LO = 18780
export const LIVE_PORT_HI = 18799
/** 代理拷贝的端口区底（BILI_ZONE_PORT）：放在线上那一段以外，顺延 17 次也碰不到。 */
export const ZONE_PORT = 28787

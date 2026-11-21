// 起转发器：按配置算出网名单（FWD_EGRESS_ALLOW），带 egress-guard 预加载起 forwarder.mjs。
// 这个进程自己不出网、不读凭据；子进程的 stdout 原样转出来（第一行是 {ready, port, fingerprintId, tokenFile}）。
// 用法：node fwd/start.mjs --config <配置>
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expectedAllow, loadConfig } from './lib/config.mjs'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const i = process.argv.indexOf('--config')
if (i < 0 || !process.argv[i + 1]) { console.error('usage: start.mjs --config <file>'); process.exit(2) }
const cfgPath = resolve(process.argv[i + 1])
const cfg = loadConfig(cfgPath)
// 复核 A4 / A8：单独起的转发器不经编排器的全局账、付费锁和守卫，所以只许 testMode / offline、或者上限全是 0（免费的 scarletkc）。
// 付费跑一律经 bin/run.mjs → ob.mjs run。
const paidCaps = Object.entries(cfg.caps ?? {}).filter(([, v]) => Number(v) > 0).map(([k]) => k)
if (!cfg.testMode && !cfg.offline && paidCaps.length) { console.error(`start.mjs: refusing a standalone paid forwarder (caps > 0 for ${paidCaps.join(',')}); paid runs go through bin/run.mjs ob.mjs run`); process.exit(2) }
export function forwarderSpawnArgs (cfgFile, c) {
  return {
    args: ['--import', pathToFileURL(join(HERE, 'lib', 'egress-guard.mjs')).href, join(HERE, 'forwarder.mjs'), '--config', cfgFile],
    env: { ...process.env, FWD_EGRESS_ALLOW: expectedAllow(c).join(','), FWD_EGRESS_LOG: join(c.stateDir, 'egress.log') },
  }
}
const { args, env } = forwarderSpawnArgs(cfgPath, cfg)
const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true })
child.on('exit', (code) => process.exit(code ?? 1))
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill())

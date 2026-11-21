// 把 tools/test 下面的测试挨个跑一遍（每个文件一个子进程，挂着两道出网挡板），最后汇总。
// 用法：node tools/test/run-all.mjs
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const guards = ['offline-guard.mjs', 'netguard.mjs'].flatMap((g) => ['--import', pathToFileURL(join(TOOLS, g)).href])
let bad = 0; let passed = 0; let failed = 0
for (const f of readdirSync(HERE).filter((n) => /^test-.*\.mjs$/.test(n)).sort()) {
  const r = spawnSync(process.execPath, [...guards, join(HERE, f)], { encoding: 'utf8', timeout: 600000 })
  const m = /(\d+) passed, (\d+) failed/.exec(String(r.stdout))
  if (m) { passed += Number(m[1]); failed += Number(m[2]) }
  const ok = r.status === 0
  if (!ok) bad += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}${m ? `  ${m[1]} passed, ${m[2]} failed` : ''}`)
  if (!ok) console.log(String(r.stdout).split('\n').filter((l) => l.startsWith('FAIL')).join('\n') + String(r.stderr).slice(0, 500))
}
console.log(`\n${passed} passed, ${failed} failed, ${bad} file(s) not ok`)
process.exit(bad === 0 ? 0 : 1)

// 把 billion-context（MIT，Copyright (c) 2026 ranxianglei）内核里四家协议的消息转换函数「只读地拷出来」打成一份 ESM：fwd/vendor/kernel-wire.mjs。
//   1. git archive <提交> kernel/src（只读取对象库，不碰那个仓库的工作区，也不在那里构建）
//      解到实验目录的 fwd-build/kernel-src-<提交>/；
//   2. 用工作树里装好的 esbuild（只读加载 node_modules/esbuild）把 anthropicToCore / coreToGoogle / coreToOpenai 等
//      连同它们的依赖打成一个文件，acp-kernel 只有 type 引用、不进包（打完核一遍输出里没有它）；
//   3. 写 kernel-wire.manifest.json：完整 commit、每个输入文件的 sha256、esbuild 版本、输出的 sha256。转发器启动时核这份清单，
//      对不上就不起（指纹里记 outputSha256）。
// 跑法（第三方代码，套 offline-guard + netguard）：
//   node --import <tools/offline-guard.mjs 的 file:/// 网址> --import <tools/netguard.mjs 的 file:/// 网址> \
//        fwd/vendor/build-kernel-wire.mjs <billion-context 仓库目录（装好依赖，有 node_modules/esbuild）> [<提交，缺省 5bb25bf>]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { experimentRoot } from '../../lib/paths.mjs'
import { sha256 } from '../lib/util.mjs'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const BC = process.argv[2] ? resolve(process.argv[2]) : null
if (!BC) { console.error('usage: build-kernel-wire.mjs <billion-context repo dir> [<commit>]'); process.exit(2) }
const COMMIT = process.argv[3] ?? '5bb25bf'
const OUT = join(HERE, 'kernel-wire.mjs')
const MANIFEST = join(HERE, 'kernel-wire.manifest.json')

const git = (...a) => execFileSync('git', ['-C', BC, ...a], { encoding: 'utf8', windowsHide: true }).trim()
const full = git('rev-parse', `${COMMIT}^{commit}`)
if (!full.startsWith(COMMIT)) throw new Error('commit mismatch')

const work = join(experimentRoot(), 'fwd-build', `kernel-src-${COMMIT}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const tarFile = join(work, 'src.tar')
const ar = spawnSync('git', ['-C', BC, 'archive', '--format=tar', '-o', tarFile, full, 'kernel/src', 'kernel/package.json'], { windowsHide: true })
if (ar.status !== 0) throw new Error('git archive failed: ' + String(ar.stderr))
const tx = spawnSync('tar', ['-xf', 'src.tar'], { cwd: work, windowsHide: true })
if (tx.status !== 0) throw new Error('tar failed: ' + String(tx.stderr))
rmSync(tarFile)

const entry = join(work, 'entry.ts')
writeFileSync(entry, [
  'export { anthropicToCore, extractSystem } from "./kernel/src/wire/anthropic.js";',
  'export { coreToGoogle, injectGoogleSystem, normalizeGoogleUserPartOrder } from "./kernel/src/wire/google.js";',
  'export { coreToOpenai, injectOpenaiSystem } from "./kernel/src/wire/openai.js";',
  'export { detectWireFormat } from "./kernel/src/wire/formats.js";',
  '',
].join('\n'))

const esbuildMain = join(BC, 'node_modules', 'esbuild', 'lib', 'main.js')
const esbuildVersion = JSON.parse(readFileSync(join(BC, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version
const esbuild = (await import(pathToFileURL(esbuildMain).href)).default ?? (await import(pathToFileURL(esbuildMain).href))
const res = await esbuild.build({
  entryPoints: [entry],
  absWorkingDir: work,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  metafile: true,
  external: ['acp-kernel'],
  legalComments: 'inline',
  banner: { js: `// 生成文件，别手改。来源：billion-context（MIT，Copyright (c) 2026 ranxianglei；见 ../../THIRD-PARTY-NOTICES.md）fork 提交 ${full} 的 kernel/src/wire（git archive 只读拷出），esbuild ${esbuildVersion}。\n// 重新生成：node --import <offline-guard> --import <netguard> tools/open-book-eval/fwd/vendor/build-kernel-wire.mjs` },
  logLevel: 'silent',
})
const code = res.outputFiles[0].text
if (/from\s*["']acp-kernel["']|require\(["']acp-kernel["']\)/.test(code)) throw new Error('bundle still imports acp-kernel at runtime')
writeFileSync(OUT, code)
const inputs = Object.keys(res.metafile.inputs).sort().map((p) => {
  const abs = resolve(work, p)
  return { path: relative(work, abs).replace(/\\/g, '/'), sha256: sha256(readFileSync(abs)) }
})
const manifest = {
  generatedBy: 'fwd/vendor/build-kernel-wire.mjs',
  sourceRepo: 'billion-context fork (MIT, Copyright (c) 2026 ranxianglei; read-only git archive of kernel/src)',
  commit: full,
  esbuild: esbuildVersion,
  exports: ['anthropicToCore', 'extractSystem', 'coreToGoogle', 'injectGoogleSystem', 'normalizeGoogleUserPartOrder', 'coreToOpenai', 'injectOpenaiSystem', 'detectWireFormat'],
  inputs,
  outputSha256: sha256(readFileSync(OUT)),
  outputBytes: readFileSync(OUT).length,
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n')
// 自检：能 import、导出齐全
const mod = await import(pathToFileURL(OUT).href + '?t=' + Date.now())
for (const k of manifest.exports) if (typeof mod[k] !== 'function') throw new Error('missing export ' + k)
console.log(JSON.stringify({ ok: true, commit: full.slice(0, 12), inputs: inputs.length, outputSha256: manifest.outputSha256, bytes: manifest.outputBytes, work: existsSync(work) }))

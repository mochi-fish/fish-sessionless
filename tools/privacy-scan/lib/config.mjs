// 公开配置：仓库根上的 .privacy-scan.json（可以没有）+ 本目录的 fake-ids.json。
//
// .privacy-scan.json 的键（都可省）：
//   maxBytes       单个文件的体积上限（字节），默认 1 MiB
//   crlfAllowed    允许 CRLF 的路径 glob，默认 ["**/*.bat", "**/*.cmd"]
//   allowBinary    允许的二进制路径 glob，默认 []
//   allowLarge     允许超过体积上限的路径 glob，默认 []
//   fakeIds        追加的假号：{ "ids": ["…"], "ranges": [[lo, hi]] }
//   allow          [{ "path": glob, "rule": 规则 id, "reason": "…" }]：只能放过公开规则的命中，
//                  私有层、原话指纹、禁发关键词的命中这里放不过
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp } from './glob.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CONFIG_NAME = '.privacy-scan.json'

export function loadFakeIds (extra) {
  const base = JSON.parse(readFileSync(join(HERE, '..', 'fake-ids.json'), 'utf8'))
  const ids = [...(base.ids ?? []), ...(extra?.ids ?? [])].map(String)
  const ranges = [...(base.ranges ?? []), ...(extra?.ranges ?? [])]
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !(Number.isInteger(r[0]) && Number.isInteger(r[1])) || String(r[0]).length !== String(r[1]).length) {
      throw new Error('fakeIds.ranges 每项要是 [lo, hi]，两头位数一样')
    }
  }
  return { set: new Set(ids), ranges }
}

/** raw：已经解析好的 .privacy-scan.json 对象（git 模式下从要推的提交里取，不看工作树） */
export function makeConfig (raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_NAME} 要是一个对象`)
  const known = new Set(['maxBytes', 'crlfAllowed', 'allowBinary', 'allowLarge', 'fakeIds', 'allow', '$comment'])
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`${CONFIG_NAME} 里有认不出的键：${k}`)
  const allow = (raw.allow ?? []).map((a) => {
    if (!a || typeof a.path !== 'string' || typeof a.rule !== 'string') throw new Error('allow 每项要有 path 和 rule')
    if (!a.reason) throw new Error('allow 每项要写 reason')
    return { re: globToRegExp(a.path), rule: a.rule }
  })
  return {
    maxBytes: Number.isInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : 1024 * 1024,
    crlfAllowed: (raw.crlfAllowed ?? ['**/*.bat', '**/*.cmd']).map(globToRegExp),
    allowBinary: (raw.allowBinary ?? []).map(globToRegExp),
    allowLarge: (raw.allowLarge ?? []).map(globToRegExp),
    fakeIds: loadFakeIds(raw.fakeIds),
    allow,
  }
}

export function loadConfigFromDir (root) {
  const f = join(root, CONFIG_NAME)
  return makeConfig(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {})
}

export const matchesAny = (path, res) => res.some((re) => re.test(path))

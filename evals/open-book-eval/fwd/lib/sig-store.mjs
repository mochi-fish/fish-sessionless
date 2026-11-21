// 思考签名登记（只追加，跑的目录里一份）：
//   own：这次跑里目标模型自己产出的思考块签名（存 sha256，不存原串）。变换时只留这些，别家（DeepSeek）的去掉。
//   g  ：Gemini 的 thoughtSignature 挂在 functionCall / 正文上时，Anthropic 的块没地方放，按 tool_use id / 正文 sha 记在这里，
//        下一轮发回 Gemini 时原样挂回去（Gemini 3 起会核 functionCall 上的签名）。
import { join } from 'node:path'
import { appendJsonl, readJsonl, sha256 } from './util.mjs'

export class SigStore {
  constructor (dir) {
    this.file = join(dir, 'signatures.jsonl')
    this.own = new Set()
    this.texts = new Set()
    this.g = new Map()
    for (const r of readJsonl(this.file)) {
      if (r.k === 'own') this.own.add(r.h)
      else if (r.k === 't') this.texts.add(r.h)
      else if (r.k === 'g') this.g.set(r.key, r.sig)
    }
  }

  /** 离线重放：把源头那次跑登记过的签名读进内存（不写回本次的文件）。 */
  importFrom (dir) {
    for (const r of readJsonl(join(dir, 'signatures.jsonl'))) {
      if (r.k === 'own') this.own.add(r.h)
      else if (r.k === 't') this.texts.add(r.h)
      else if (r.k === 'g' && !this.g.has(r.key)) this.g.set(r.key, r.sig)
    }
  }

  isOwn (sig) { return typeof sig === 'string' && sig !== '' && this.own.has(sha256(sig)) }
  addOwn (sig) {
    if (typeof sig !== 'string' || sig === '') return
    const h = sha256(sig)
    if (this.own.has(h)) return
    this.own.add(h)
    appendJsonl(this.file, { k: 'own', h })
  }

  /** 目标模型自己写出来的字（存 sha256，不存原文）：隐私闸的片段查重跳过它们。 */
  isOwnText (s) { return typeof s === 'string' && s !== '' && this.texts.has(sha256(s)) }
  addOwnText (s) {
    if (typeof s !== 'string' || s.length < 12) return
    const h = sha256(s)
    if (this.texts.has(h)) return
    this.texts.add(h)
    appendJsonl(this.file, { k: 't', h })
  }

  getG (key) { return this.g.get(key) }
  setG (key, sig) {
    if (typeof sig !== 'string' || sig === '' || this.g.get(key) === sig) return
    this.g.set(key, sig)
    appendJsonl(this.file, { k: 'g', key, sig })
  }
}

/** 测试和离线重放用：只在内存里。 */
export class MemorySigStore {
  constructor () { this.own = new Set(); this.texts = new Set(); this.g = new Map() }
  isOwn (sig) { return typeof sig === 'string' && sig !== '' && this.own.has(sha256(sig)) }
  isOwnText (s) { return typeof s === 'string' && s !== '' && this.texts.has(sha256(s)) }
  addOwnText (s) { if (typeof s === 'string' && s.length >= 12) this.texts.add(sha256(s)) }
  addOwn (sig) { if (typeof sig === 'string' && sig) this.own.add(sha256(sig)) }
  getG (key) { return this.g.get(key) }
  setG (key, sig) { if (typeof sig === 'string' && sig) this.g.set(key, sig) }
}

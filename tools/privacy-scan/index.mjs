// privacy-scan 的程序接口（push 入口、测试都从这里取）
import { git } from './lib/git.mjs'
import { makeConfig, loadConfigFromDir, CONFIG_NAME } from './lib/config.mjs'

export { createScanner, formatReport } from './lib/engine.mjs'
export { makeConfig, loadConfigFromDir, CONFIG_NAME } from './lib/config.mjs'
export { loadProvider, validateLayer, termId, buildTermMatcher, digitHash } from './lib/private.mjs'
export { canonWidth, decodeView } from './lib/decode.mjs'
export {
  FP_DEFAULTS, normalizeUnits, normalizedString, windowHash, forEachWindow, buildFingerprintSet, matchRuns,
  writeFingerprintFile, readFingerprintFile,
} from './lib/fingerprint.mjs'
export { TEXT_RULES, isPlaceholderName, isPrivateIPv4, isAllowedEmail, isFakeId, looksFakeSecret } from './lib/rules.mjs'
export { collectGit, revParse } from './lib/git.mjs'

export const SCANNER_VERSION = '0.2.0'

/** git 模式的配置从要推的那个提交里取（不看工作树，免得工作树里改了配置放过东西） */
export function configFromCommit (repo, commit) {
  let raw = {}
  try {
    raw = JSON.parse(String(git(repo, ['show', `${commit}:${CONFIG_NAME}`])))
  } catch (e) {
    if (!/does not exist|exists on disk, but not in|bad revision|fatal: path/.test(String(e.message))) throw e
  }
  return makeConfig(raw)
}

/** 关键词文件：一行一个，# 开头的是注释，空行不算。命中报「<前缀>#<行号>」，不报词本身 */
export function parseKeywordFile (text, prefix = 'embargo') {
  const out = []
  String(text).split(/\r?\n/).forEach((ln, i) => {
    const v = ln.trim()
    if (!v || v.startsWith('#')) return
    out.push({ kind: prefix, value: v, label: `${prefix}#${i + 1}`, layer: prefix })
  })
  return out
}

export { loadConfigFromDir as configFromDir }

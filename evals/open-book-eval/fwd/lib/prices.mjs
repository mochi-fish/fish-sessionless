// 单价表（每百万 token）。都没上官方价目页核过（verified:false），批预算前要再核一次（eval.md 10.2）。
// 预留（reserve）一律按上限算；结账（settle）按提供方回报的用量 × 这里的单价。币种跟着提供方走：DeepSeek 记人民币，其余记美元。
// 改了这张表，指纹里的 pricesSha 跟着变（预算口径不同的两次跑不混）。
export const PRICES = Object.freeze({
  deepseek: {
    currency: 'CNY', verified: false,
    note: 'deepseek-flash 走 DeepSeek 账号（x-dsh-auth-token）怎么计费没核；按 eval.md 10.2 的上限：未命中 ¥1、命中 ¥0.1、输出 ¥8',
    inputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1, outputPerM: 8,
  },
  anthropic: {
    currency: 'USD', verified: false,
    note: 'claude-opus-5-5：输入 $4、5 分钟缓存写 $5、缓存读 $0.20、输出 $20（claude-api 技能的价表）',
    inputPerM: 4, cacheReadPerM: 0.2, cacheWritePerM: 5, outputPerM: 20,
  },
  gemini: {
    currency: 'USD', verified: false,
    note: 'gemini-4-argon 全部未核；按 eval.md 10.2 区间的上限，20 万以上的提示按长上下文一档（输入 ×2、输出 ×1.5）预留',
    inputPerM: 2.5, cacheReadPerM: 0.625, cacheWritePerM: 2.5, outputPerM: 15,
    longContext: { thresholdTokens: 200000, inputPerM: 5, cacheReadPerM: 1.25, outputPerM: 22.5 },
  },
  openai: {
    currency: 'CNY', verified: true,
    note: 'scarletkc 跑在自建的推理机（vLLM），API 不收钱',
    inputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, outputPerM: 0,
  },
})

// 预留时把「DeepSeek 计数」换算成目标模型的计数用的系数（上限；eval.md 10.2「×1.15–1.35【推断】」）
export const TOKENIZER_FACTOR = Object.freeze({ deepseek: 1.0, anthropic: 1.35, gemini: 1.25, openai: 1.2 })

/** 规整后的用量 { input, cacheRead, cacheWrite, output } → 钱（提供方的币种）。 */
export function costOf (provider, u) {
  const p = PRICES[provider]
  if (!p) throw new Error(`no price for ${provider}`)
  const promptTotal = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  const lc = p.longContext && promptTotal > p.longContext.thresholdTokens ? p.longContext : null
  const inP = lc?.inputPerM ?? p.inputPerM
  const crP = lc?.cacheReadPerM ?? p.cacheReadPerM
  const cwP = lc?.cacheWritePerM ?? p.cacheWritePerM
  const outP = lc?.outputPerM ?? p.outputPerM
  const c = ((u.input ?? 0) * inP + (u.cacheRead ?? 0) * crP + (u.cacheWrite ?? 0) * cwP + (u.output ?? 0) * outP) / 1e6
  return Math.round(c * 1e6) / 1e6
}

/** 预留上限：输入全按「最贵的那种输入价」（Anthropic 是缓存写）、输出按 max_tokens 满额。 */
export function reserveOf (provider, deepseekInputTokens, maxTokens) {
  const p = PRICES[provider]
  const inTok = Math.ceil(deepseekInputTokens * (TOKENIZER_FACTOR[provider] ?? 1.5))
  const lc = p.longContext && inTok > p.longContext.thresholdTokens ? p.longContext : null
  const inP = Math.max(lc?.inputPerM ?? p.inputPerM, lc?.cacheWritePerM ?? p.cacheWritePerM)
  const outP = lc?.outputPerM ?? p.outputPerM
  const c = (inTok * inP + (maxTokens ?? 0) * outP) / 1e6
  return { amount: Math.round(c * 1e6) / 1e6, inputTokensEst: inTok, inputPart: Math.round(inTok * inP) / 1e6 }
}

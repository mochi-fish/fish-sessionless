// 用量回报（eval.md 3.6）。代理拷贝按回报的用量决定什么时候折、要不要截断，所以这里决定了「代理眼里这份视图有多大」。
//   pinned：报 DeepSeek 会数出来的那个数（按实测校准：K_TEXT × 非图字节 + 每张图 500），各家模型下代理的行为一样；
//           输出照报目标模型自己的输出数。
//   real  ：照报目标模型的真用量，映射到 Anthropic 的字段（input_tokens 是没命中的那部分）。
// 两种都从同一份缓存的上游原文算出来，所以同一批调用能离线按另一种口径重放（forwarder --cache-from）。

// 校准用的一次实测：一份 2,429,665 字节、261 张图（每块约 75 字节）的请求，DeepSeek 数出 733,506
export const K_TEXT = (733506 - 261 * 500) / (2429665 - 261 * 75)
export const IMAGE_TOKENS = 500
export const IMAGE_BLOCK_BYTES = 75

export function countImages (body) {
  let n = 0
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'image') n++
      else if (b.type === 'tool_result') walk(b.content)
    }
  }
  for (const m of body?.messages ?? []) walk(typeof m.content === 'string' ? [] : m.content)
  return n
}

/** DeepSeek 会数出来的输入 token（rawBytes：代理发来的请求体原样的字节数）。 */
export function pinnedInputTokens (rawBytes, images) {
  return Math.max(1, Math.round(K_TEXT * Math.max(0, rawBytes - IMAGE_BLOCK_BYTES * images) + IMAGE_TOKENS * images))
}

/** 各家的用量 → { input（没命中）, cacheRead, cacheWrite, output, reasoning? }。 */
export function normalizeUsage (provider, raw) {
  const u = raw ?? {}
  switch (provider) {
    case 'deepseek':
    case 'anthropic':
      return { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    case 'gemini': {
      const prompt = u.promptTokenCount ?? 0
      const cached = u.cachedContentTokenCount ?? 0
      return { input: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), reasoning: u.thoughtsTokenCount ?? 0 }
    }
    case 'openai': {
      const prompt = u.prompt_tokens ?? 0
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0
      return { input: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? undefined }
    }
    default: throw new Error(`unknown provider ${provider}`)
  }
}

/** 回给代理的 Anthropic 用量字段。 */
export function toAnthropicUsage (mode, { pinnedInput, norm }) {
  if (mode === 'pinned') return { input_tokens: pinnedInput, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: norm?.output ?? 0 }
  if (mode === 'real') return { input_tokens: norm?.input ?? 0, cache_creation_input_tokens: norm?.cacheWrite ?? 0, cache_read_input_tokens: norm?.cacheRead ?? 0, output_tokens: norm?.output ?? 0 }
  throw new Error(`unknown usage mode ${mode}`)
}

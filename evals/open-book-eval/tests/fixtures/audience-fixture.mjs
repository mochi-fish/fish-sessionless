// 判分测试用的门表样本（编的，只有测试用到的几行）。
// 判分只用门模块的两样导出：GATE_TEXT（门挡下时给模型的那句话）和 GATE_TABLE（工具名 → allow / deny / args）。
// 真跑时用 score-run.mjs --audience <你的门模块>，它要导出同样的这几样。
export const AUDIENCE_VERSION = 'fixture-1'

export const GATE_TEXT = '这一下在这一轮不开，没有结果给你。没拿到不等于没有，别把这一下当成「查过、没有」。'

const exactRow = (name, origin, v) => Object.freeze({ id: name, match: 'exact', name, origin, v })
const prefixRow = (prefix, origin, v) => Object.freeze({ id: prefix + '*', match: 'prefix', prefix, origin, v })

export const GATE_TABLE = Object.freeze([
  exactRow('read', 'host', 'args'),
  exactRow('web_fetch', 'host', 'deny'),
  exactRow('her_recall', 'dsh-fish', 'deny'),
  exactRow('her_note', 'dsh-fish', 'args'),
  exactRow('im_send', 'bridge', 'allow'),
  exactRow('qq_history', 'bridge', 'args'),
  exactRow('compress', 'billion-context', 'allow'),
  exactRow('acp_status', 'billion-context', 'args'),
  exactRow('search_context', 'billion-context', 'deny'),
  exactRow('decompress', 'billion-context', 'deny'),
  exactRow('mcp__nowledge_mem__memory_search', 'nowledge-mem', 'allow'),
  prefixRow('mcp__nowledge_mem__', 'nowledge-mem', 'allow'),
  prefixRow('mcp__', 'mcp', 'deny'),
  prefixRow('acp_', 'billion-context', 'deny'),
])

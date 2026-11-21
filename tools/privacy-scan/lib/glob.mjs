// 极简 glob：** 跨目录，* 和 ? 不跨 /。路径一律用正斜杠、相对仓库根。
export function globToRegExp (glob) {
  let re = ''
  const g = String(glob).replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

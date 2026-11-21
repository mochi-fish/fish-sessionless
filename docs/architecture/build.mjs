#!/usr/bin/env node
// 把 src/ 里的分段 HTML 拼成一张自带全部样式和脚本的静态页 index.html，并做机械检查。
// 用法：node docs/architecture/build.mjs [--check]
//   --check  只检查、不写 index.html；有问题退出码 1。
// 只用 Node 自带模块。页面不加载任何外部脚本、样式、字体或图片，可以直接放到 GitHub Pages。

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const outFile = join(here, 'index.html');
const checkOnly = process.argv.includes('--check');

const order = [
  'part-01-head.html',
  'part-02-top.html',
  'part-03-overview.html',
  'part-04-chains.html',
  'part-05-gate.html',
  'part-06-memory.html',
  'part-07-water.html',
  'part-08a-items.html',
  'part-08b-handoff.html',
  'part-08c-roadmap.html',
  'part-09-sources.html',
  'part-10-limits.html',
  'part-12-foot.html',
];

const problems = [];
const ch = (...codes) => String.fromCharCode(...codes);
const BOM = ch(0xfeff);
const LS = ch(0x2028);
const PS = ch(0x2029);

const parts = order.map((name) => {
  const raw = readFileSync(join(srcDir, name), 'utf8');
  if (raw.startsWith(BOM)) problems.push(`${name}: 开头有 BOM`);
  if (raw.includes('\r')) problems.push(`${name}: 有 CR（要用 LF）`);
  if (raw.includes(LS) || raw.includes(PS)) problems.push(`${name}: 有 U+2028 / U+2029`);
  return { name, text: raw.replace(/\r\n/g, '\n') };
});

const [head, ...body] = parts;
const html = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  head.text.trimEnd(),
  '</head>',
  '<body>',
  ...body.map((p) => p.text.trimEnd()),
  '</body>',
  '</html>',
  '',
].join('\n');

// ---- 检查：出现在哪一段 ----
const where = (re) => {
  const hits = [];
  for (const p of parts) {
    const lines = p.text.split('\n');
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${p.name}:${i + 1}`);
    });
  }
  return hits;
};
const forbid = (label, re) => {
  const hits = where(re);
  if (hits.length) problems.push(`${label}：${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ` 等 ${hits.length} 处` : ''}`);
};

// 公开材料不写的称呼（用码位拼，免得这个文件自己带上这些字）
const bannedNames = new RegExp([ch(0x732b), ch(0x54c8, 0x57fa, 0x7c73)].join('|'));
forbid('出现了不该公开的称呼', bannedNames);
// 主人在公开文字里用中性的叫法；「其他」「吉他」除外
forbid('出现了「他」', /(?<![其吉])他/);
// 长串数字（像号码）。#rrggbb 颜色、小数、标识符里的不算
forbid('出现了 6 位以上的长数字', /(?<![#\w.-])\d{6,}(?![\w])/);
// 部署日期、进度、待定这类只属于某一处部署的字
forbid('出现了日期', /\b20\d\d-\d\d-\d\d\b|\d{1,2} ?月 ?\d{1,2} ?日|\b\d{1,2}-\d{1,2} \d{1,2}:\d\d\b/);
forbid('出现了部署状态的字', /data-now|更新日志|已上线|副本验过|等你定|现状和证据/);
// 路径、邮箱、密钥样子的东西
forbid('出现了用户目录路径', /[A-Za-z]:[\\/]+Users[\\/]|\/Users\/|\/home\/[a-z]/);
forbid('出现了邮箱', /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/);
forbid('出现了像密钥的东西', /Bearer\s+[\w.-]{8,}|access_token|\bsk-[A-Za-z0-9]{16,}|SESSDATA|bili_jct/);
// 外部资源：页面要自带一切
forbid('引用了外部资源', /<(?:script|link|img|iframe|source|video|audio)\b[^>]*\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
forbid('样式里引用了外部资源', /@import|url\(\s*["']?(?:https?:)?\/\//i);
// 内联 style 只许 --w
for (const p of parts) {
  for (const m of p.text.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) {
    if (!/^\s*--w:\s*[\d.]+\s*;?\s*$/.test(m[1])) problems.push(`${p.name}: 内联 style 只许 --w，见到「${m[1].slice(0, 30)}」`);
  }
}

// id 唯一；页内锚点和 url(#…) 都指得到
const ids = new Map();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
for (const [id, n] of ids) if (n > 1) problems.push(`id 重复：${id} ×${n}`);
for (const m of html.matchAll(/href="#([^"]*)"/g)) if (!ids.has(m[1])) problems.push(`锚点指不到：#${m[1]}`);
for (const m of html.matchAll(/url\(#([^)]+)\)/g)) if (!ids.has(m[1])) problems.push(`url(#) 指不到：#${m[1]}`);
for (const m of html.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g)) {
  for (const id of m[1].split(/\s+/)) if (!ids.has(id)) problems.push(`aria 指不到：${id}`);
}

// 标签成对
const tags = ['html', 'head', 'body', 'header', 'nav', 'main', 'footer', 'section', 'figure', 'figcaption', 'div', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'svg', 'g', 'defs', 'marker', 'text', 'p', 'span', 'h1', 'h2', 'h3', 'button', 'script', 'style', 'code', 'strong', 'b'];
for (const t of tags) {
  const open = (html.match(new RegExp(`<${t}(?=[\\s>])[^>]*?(?<!/)>`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${t}>`, 'g')) || []).length;
  if (open !== close) problems.push(`<${t}> 开 ${open} 关 ${close}，对不上`);
}

const sha = createHash('sha256').update(html).digest('hex');
if (problems.length) {
  console.error(`检查没过，${problems.length} 处：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (!checkOnly) writeFileSync(outFile, html);
console.log(`${checkOnly ? '检查通过（没写文件）' : '写好 index.html'}：${parts.length} 段，${Buffer.byteLength(html)} 字节，sha256 ${sha}`);

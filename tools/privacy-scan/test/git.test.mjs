import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createScanner, configFromCommit, revParse } from '../index.mjs'
import { FAKE, winHome, mail, tmp, rmrf, gitInit, gitCommitAll, sh, runScan } from './helpers.mjs'

function scanRepo (dir, opts = {}) {
  const head = revParse(dir, 'HEAD')
  return createScanner({ config: configFromCommit(dir, head) }).scanGit(dir, { revs: [head], ...opts })
}

test('历史里删掉的脏文件也算；只看树时才放过', () => {
  const d = tmp('git-hist')
  try {
    gitInit(d)
    writeFileSync(join(d, 'notes.md'), `路径 ${winHome()}\n`)
    gitCommitAll(d, 'add notes')
    rmSync(join(d, 'notes.md'))
    writeFileSync(join(d, 'README.md'), '# 干净\n')
    gitCommitAll(d, 'clean up')
    const full = scanRepo(d)
    assert.deepEqual(full.findings.map((f) => f.rule), ['user-path'])
    assert.match(full.findings[0].path, /notes\.md @[0-9a-f]{10}/)
    assert.equal(full.stats.commits, 2)
    const head = scanRepo(d, { history: false })
    assert.deepEqual(head.findings, [])
  } finally { rmrf(d) }
})

test('refs/replace 换掉的脏对象：扫描看原样（git push 推的是原样）', () => {
  const d = tmp('git-replace')
  try {
    gitInit(d)
    writeFileSync(join(d, 'notes.md'), `路径 ${winHome()}\n`)
    gitCommitAll(d, 'add notes')
    const dirtyBlob = sh(d, 'git', ['rev-parse', 'HEAD:notes.md']).trim()
    writeFileSync(join(d, 'clean.txt'), '干净\n')
    const cleanBlob = sh(d, 'git', ['hash-object', '-w', 'clean.txt']).trim()
    sh(d, 'git', ['replace', dirtyBlob, cleanBlob])
    assert.deepEqual(scanRepo(d).findings.map((f) => f.rule), ['user-path'])
  } finally { rmrf(d) }
})

test('提交说明、作者邮箱都扫', () => {
  const d = tmp('git-meta')
  try {
    gitInit(d, mail('zed.quill', 'gmail.com'))
    writeFileSync(join(d, 'a.txt'), 'ok\n')
    gitCommitAll(d, `fix for qq ${FAKE.qq}`)
    const r = scanRepo(d)
    const rules = r.findings.map((f) => `${f.rule}:${f.path.replace(/[0-9a-f]{10}/, 'X')}`).sort()
    assert.deepEqual(rules, ['email:<commit X author>', 'email:<commit X committer>', 'qq-context:<commit X message>'])
  } finally { rmrf(d) }
})

test('配置从要推的提交里取，工作树里改的不算', () => {
  const d = tmp('git-cfg')
  try {
    gitInit(d)
    writeFileSync(join(d, 'a.md'), mail('zed', 'gmail.com') + '\n')
    gitCommitAll(d, 'a')
    writeFileSync(join(d, '.privacy-scan.json'), JSON.stringify({ allow: [{ path: '**', rule: 'email', reason: '想偷偷放过' }] }))
    assert.equal(scanRepo(d).findings.length, 1)
    gitCommitAll(d, 'allow')
    assert.equal(scanRepo(d).findings.length, 0)
  } finally { rmrf(d) }
})

test('命令行 --git：脏退 1，干净退 0，坏仓库退 2', () => {
  const d = tmp('git-cli')
  try {
    gitInit(d)
    writeFileSync(join(d, 'a.md'), '# ok\n')
    gitCommitAll(d, 'a')
    assert.equal(runScan(['--git', d]).status, 0)
    writeFileSync(join(d, 'b.md'), `owner qq ${FAKE.qq}\n`)
    gitCommitAll(d, 'b')
    const r = runScan(['--git', d, '--json'])
    assert.equal(r.status, 1)
    assert.ok(!r.stdout.includes(FAKE.qq))
    assert.equal(runScan(['--git', join(d, 'nope')]).status, 2)
    assert.equal(runScan(['--git', d, '--rev', 'no-such-ref']).status, 2)
    sh(d, 'git', ['tag', '-a', 'v1', '-m', `tagged by ${mail('zed', 'gmail.com')}`])
    const t = runScan(['--git', d, '--tags', '--json'])
    assert.ok(JSON.parse(t.stdout).findings.some((f) => f.path === '<tag refs/tags/v1>' && f.rule === 'email'))
  } finally { rmrf(d) }
})

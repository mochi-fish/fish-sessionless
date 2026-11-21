// 扫描器自己的源码和测试也得过公开规则：测试里的脏样本都要在运行时拼，不许写成完整的字面量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScanner, configFromDir } from '../index.mjs'
import { TOOL } from './helpers.mjs'

test('privacy-scan 目录自扫干净', () => {
  const r = createScanner({ config: configFromDir(TOOL) }).scanDir(TOOL)
  assert.deepEqual(r.findings, [])
})

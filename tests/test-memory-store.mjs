// dsh-memory store.js 纯助手函数单测：sessionSlug（含正斜杠 cwd 归一）、
// memoryRoot（设置项优先，回落 $DSH_HOME/dsh-memory）、isDateStamp /
// workspaceLabel / resolveDiary（日记寻址，含片段模糊匹配与歧义拒绝）。
// store.js import 了 @deepseek-ai/dsh-home-paths，须经桩加载器导入
// （dshHomePath 桩返回 MEM_TEST_HOME）。
// 用法：node --import ./tests/register-mem-test.mjs tests/test-memory-store.mjs
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDateStamp, memoryRoot, resolveDiary, sessionSlug, workspaceLabel } from '../src/store.js'

// dshHomePath() 是桩：指向 $MEM_TEST_HOME，本测试用它做回落断言的基准。
process.env.MEM_TEST_HOME = join(tmpdir(), 'dsh-mem-store-home-')

assert.equal(sessionSlug('D:\\Project\\x'), '--D-Project-x--', 'sessionSlug 与既有约定一致（Win32 反斜杠）')
assert.equal(sessionSlug('D:/Project/x'), '--D-Project-x--', 'Git Bash 正斜杠 cwd 归一到同一 slug（2026-08-28 修复）')
assert.equal(sessionSlug(''), '--general--', '空 cwd 落 general 桶')
assert.equal(sessionSlug(undefined), '--general--', '缺 cwd 落 general 桶')

// --- memoryRoot（2026-09-01：设置项，不再是环境变量） ---------------------------
assert.ok(memoryRoot('').endsWith(join('dsh-memory')), '空设置 → 回落 $DSH_HOME/dsh-memory')
assert.ok(!memoryRoot('').endsWith(join('dsh-memory', 'x')), '回落路径不含多余片段')
assert.equal(memoryRoot('   '), memoryRoot(''), '纯空白设置等同未设置')
assert.equal(memoryRoot('D:\\agent\\memory'), 'D:\\agent\\memory', '非空设置原样采用')
assert.equal(memoryRoot('  D:\\agent\\memory  '), 'D:\\agent\\memory', '设置两侧空白被裁掉')
assert.equal(memoryRoot(), memoryRoot(''), '不传参等同空设置')

// --- isDateStamp ---------------------------------------------------------------
assert.ok(isDateStamp('2026-08-31'), '合法日期戳')
assert.ok(!isDateStamp('2026-13-45'), '月份/日期越界')
assert.ok(!isDateStamp('2026-8-31'), '必须补零（目录名格式）')
assert.ok(!isDateStamp('topics'), '非日期目录名')
assert.ok(!isDateStamp('../evil'), '路径穿越')
assert.ok(!isDateStamp(''), '空串')

// --- workspaceLabel ------------------------------------------------------------
assert.equal(workspaceLabel('--D-Project-x--.md'), 'D-Project-x', '剥掉 slug 书挡与扩展名')
assert.equal(workspaceLabel('--D-Project-x--'), 'D-Project-x', '无扩展名同样处理')
assert.equal(workspaceLabel('note.md'), 'note', '普通文件名')

// --- resolveDiary：寻址（含片段模糊匹配） ---------------------------------------
const root = mkdtempSync(join(tmpdir(), 'dsh-mem-store-'))
const DAY = '2026-08-31'
const seed = (name) => {
  mkdirSync(join(root, DAY), { recursive: true })
  writeFileSync(join(root, DAY, name), '# x\n\nbody')
}
seed('--D-Project-dsh-plugin-dsh-memory--.md')
seed('--D-Project-other-repo--.md')

// 空 label → 调用方自己工作区的日记
assert.equal(
  resolveDiary(root, DAY, '', 'D:\\Project\\dsh-plugin\\dsh-memory').file,
  join(root, DAY, '--D-Project-dsh-plugin-dsh-memory--.md'),
  '空 label 落本会话工作区',
)
// 全形标签
assert.equal(
  resolveDiary(root, DAY, 'D-Project-other-repo').file,
  join(root, DAY, '--D-Project-other-repo--.md'),
  '全形标签精确命中',
)
// 片段标签（agent 抄不全也能命中）
assert.equal(
  resolveDiary(root, DAY, 'other-repo').file,
  join(root, DAY, '--D-Project-other-repo--.md'),
  '片段标签模糊命中（唯一匹配）',
)
assert.equal(
  resolveDiary(root, DAY, '--D-Project-other-repo--.md').file,
  join(root, DAY, '--D-Project-other-repo--.md'),
  '带书挡与扩展名的原始形式也接受',
)
// 拒绝：歧义 / 不存在 / 非法 date
const ambiguous = resolveDiary(root, DAY, 'D-Project')
assert.equal(ambiguous.ok, false, '多匹配必须报错')
assert.match(ambiguous.error, /matches 2 workspaces/)
const missing = resolveDiary(root, DAY, 'nope')
assert.equal(missing.ok, false)
assert.match(missing.error, /no note for/)
assert.match(resolveDiary(root, '2026-13-45', '').error, /YYYY-MM-DD/)
assert.match(resolveDiary(root, 'topics', '').error, /YYYY-MM-DD/, '非日期目录不可寻址')
const emptyDay = resolveDiary(root, '2020-01-01', 'x')
assert.equal(emptyDay.ok, false)
assert.match(emptyDay.error, /no notes for/, '该日无任何笔记时给出明确错误')

// 解析出的路径必须在记忆根内（防穿越的兜底断言）
for (const label of ['', 'other-repo', 'D-Project-other-repo']) {
  const hit = resolveDiary(root, DAY, label, 'D:\\Project\\dsh-plugin\\dsh-memory')
  assert.ok(hit.ok && hit.file.startsWith(root), `解析结果留在记忆根内：${label}`)
  assert.ok(existsSync(hit.file), `解析结果真实存在：${label}`)
}

rmSync(root, { recursive: true, force: true })
console.log('ALL PASS')

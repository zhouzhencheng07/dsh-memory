// dsh-memory store.js 纯助手函数单测：sessionSlug（含正斜杠 cwd 归一）。
// store.js import 了 @deepseek-ai/dsh-home-paths，须经桩加载器导入（本测试不触盘，
// dshHomePath 桩返回的 MEM_TEST_HOME 不会被用到）。
// （2026-08-28：splitPreamble / mergeSourceComment 随来源注释机制一起删除，
// 对应用例一并移除。）
// 用法：node --import ./tests/register-mem-test.mjs tests/test-memory-store.mjs
import { strict as assert } from 'node:assert'
import { sessionSlug } from '../src/store.js'

assert.equal(sessionSlug('D:\\Project\\x'), '--D-Project-x--', 'sessionSlug 与既有约定一致（Win32 反斜杠）')
assert.equal(sessionSlug('D:/Project/x'), '--D-Project-x--', 'Git Bash 正斜杠 cwd 归一到同一 slug（2026-08-28 修复）')
assert.equal(sessionSlug(''), '--general--', '空 cwd 落 general 桶')
assert.equal(sessionSlug(undefined), '--general--', '缺 cwd 落 general 桶')

console.log('ALL PASS')

// dsh-memory store.js 纯助手函数单测：splitPreamble / mergeSourceComment / sessionSlug。
// store.js import 了 @deepseek-ai/dsh-home-paths，须经桩加载器导入（本测试不触盘，
// dshHomePath 桩返回的 MEM_TEST_HOME 不会被用到）。
// 用法：node --import ./tests/register-mem-test.mjs tests/test-memory-store.mjs
import { strict as assert } from 'node:assert'
import { splitPreamble, mergeSourceComment, sessionSlug } from '../src/store.js'

{
  const { preamble, body } = splitPreamble('<!-- 会话来源: s1 -->\n\n# T\nbody')
  assert.equal(preamble, '<!-- 会话来源: s1 -->', 'splitPreamble 取到首行注释')
  assert.equal(body, '# T\nbody', 'splitPreamble 正文从头标题开始')
}
{
  const merged = mergeSourceComment('<!-- 会话来源: s1 , s2 -->\n杂项行', 's1')
  assert.equal(merged, '杂项行\n<!-- 会话来源: s1, s2 -->', 'mergeSourceComment 去重合并 + 保留杂项前导行')
}
assert.equal(sessionSlug('D:\\Project\\x'), '--D-Project-x--', 'sessionSlug 与既有约定一致')

console.log('ALL PASS')

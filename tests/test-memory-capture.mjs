// memory 三模式文件工具验证（2026-08-28）：
//   1) 无参 = 读今日笔记：不存在返回 ABSENT（含现有 topic 列表）且零写盘；
//      存在返回全文并记录观察；
//   2) mode:"write" 镜像原生 createIfAbsent/CAS：未读已存在拒绝、读后整替换、
//      读后外部改动拒绝；原子写（无 .tmp 残留）；
//   3) mode:"edit" 镜像原生 FS_NOT_OBSERVED/唯一匹配：未读拒绝、多处拒绝、
//      replace_all 放行、找不到拒绝、ABSENT 观察后编辑拒绝（not found）；
//   4) topic 参数：定位 topics/<topic>.md（可被检索索引）；非法 topic 拒绝；
//   5) 无会话调用：读自由、写仅 create、edit 恒拒（镜像原生 owner 语义）；
//      跨会话 CAS：A 读 → B 写 → A 编辑被拒；
//   6) 每轮提醒 = systemPrompt.context 贡献（2026-08-29 恢复）：文案只讲时机
//      （必须用 memory 工具），autoMemory 开关 / 子代理 / 无 agent 控制空文本；
//   7) 工具面：memory + memory_search 注册、描述承载机制与组织规则（无"必须"）、
//      参数面完整；固化指引由检索结果组成驱动（不在描述里）；零 host hook
//      （ctx.on 即失败）。
// 插件侧 node:fs 直写自己的数据根（依据见 src/index.js 头注），不子派发
// 原生工具，因此测试直接对 MEM_TEST_HOME 沙箱真实读写——任何权限模式下
// 捕获均可用，不存在"workspace-write 拒写"路径。每个用例独占一个 cwd
// （即独占一个今日文件），避免共享路径上的状态污染。
// 用法：node --import ./tests/register-mem-test.mjs tests/test-memory-capture.mjs
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-mem-capture-'))
process.env.MEM_TEST_HOME = home

const { apply, name } = await import('../src/index.js')
const { memoryRoot, sessionSlug, todayStamp, walkMemory } = await import('../src/store.js')

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`ok   ${label}`)
}

function boot() {
  const registered = []
  let contextReg = null
  apply({
    tools: { register: (tool) => registered.push(tool) },
    inject: (_deps, cb) => {
      cb({ systemPrompt: { context: (reg) => { contextReg = reg } } })
      return { dispose() {} }
    },
    effect: (fn) => fn(),
    on: () => { throw new Error('dsh-memory must not register host event hooks') },
  })
  const memory = registered.find((x) => x.name === 'memory')
  const search = registered.find((x) => x.name === 'memory_search')
  assert.ok(memory && search, 'memory + memory_search registered')
  return { memory, search, contextReg }
}

function makeExec(sessionId = 's1', cwd = 'C:\\work') {
  return {
    callId: 'root-call-1',
    rootCallId: 'root-call-1',
    token: Symbol('token'),
    ...(sessionId
      ? { agent: { session: { id: sessionId, header: { cwd } } } }
      : {}),
    signal: new AbortController().signal,
  }
}

const dailyFile = (cwd) => join(memoryRoot(), todayStamp(), `${sessionSlug(cwd)}.md`)

/** Seed a file on the real sandbox fs. */
function seed(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

const { memory, search: searchTool } = boot()

// --- 无参 = 读今日笔记 ---------------------------------------------------------
await check('不存在时：ABSENT + 建file指引 + 现有 topic 提示，零写盘', async () => {
  const out = await memory.execute({}, makeExec('s1', 'C:\\absent'))
  assert.match(out, /^ABSENT /)
  assert.ok(out.includes(dailyFile('C:\\absent')), 'ABSENT 指今日文件绝对路径')
  assert.match(out, /mode:"write"/, '指引创建')
  assert.match(out, /topics\/<topic>\.md/, '提及长期主题文件')
  assert.ok(!existsSync(dailyFile('C:\\absent')), 'read 绝不创建文件')
})

await check('存在时：返回全文 + 维护指引', async () => {
  const cwd = 'C:\\read-exists'
  const note = '# 主题甲\n\n正文一行'
  seed(dailyFile(cwd), note)
  const out = await memory.execute({}, makeExec('s2', cwd))
  assert.ok(out.startsWith(dailyFile(cwd)), '以路径开头')
  assert.ok(out.includes(note), '返回全文')
  assert.match(out, /mode:"edit"/, '指引就地维护')
})

// --- mode:"write" --------------------------------------------------------------
await check('write：不存在 → 创建，无 .tmp 残留', async () => {
  const cwd = 'C:\\write-create'
  const out = await memory.execute({ mode: 'write', content: '# 新笔记\n\n内容' }, makeExec('s3', cwd))
  assert.match(out, /· created/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 新笔记\n\n内容')
  assert.deepEqual(readdirSync(join(dailyFile(cwd), '..')).filter((n) => n.includes('.tmp-')), [], '原子写不残留临时文件')
})

await check('write：已存在未读 → 拒绝（createIfAbsent 镜像）', async () => {
  const cwd = 'C:\\write-exists'
  seed(dailyFile(cwd), '# 已有笔记')
  await assert.rejects(
    () => memory.execute({ mode: 'write', content: 'x' }, makeExec('s4', cwd)),
    /read it first/,
  )
})

await check('read 后 write：整文件替换', async () => {
  const cwd = 'C:\\rw'
  seed(dailyFile(cwd), '# 原文')
  await memory.execute({}, makeExec('s5', cwd)) // 记录观察
  const out = await memory.execute({ mode: 'write', content: '# 整替换' }, makeExec('s5', cwd))
  assert.match(out, /· replaced/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 整替换')
})

await check('read 后外部直改再 write：CAS 拒绝', async () => {
  const cwd = 'C:\\stale-w'
  seed(dailyFile(cwd), '# 原文')
  await memory.execute({}, makeExec('s6', cwd)) // 记录观察
  seed(dailyFile(cwd), '# 外部长了很多很多很多行的改动')
  await assert.rejects(
    () => memory.execute({ mode: 'write', content: 'x' }, makeExec('s6', cwd)),
    /changed since it was read/,
  )
})

// --- mode:"edit" ---------------------------------------------------------------
await check('edit：文件存在但从未读 → 拒绝（FS_NOT_OBSERVED 镜像）', async () => {
  const cwd = 'C:\\edit-unread'
  seed(dailyFile(cwd), '# 未读先改')
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '未读先改', new_string: 'y' }, makeExec('s7', cwd)),
    /read it before editing/,
  )
})

await check('edit：文件不存在从未读 → 拒绝（requires reading）', async () => {
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: 'x', new_string: 'y' }, makeExec('s8', 'C:\\edit-missing')),
    /edit requires reading/,
  )
})

await check('read（ABSENT）后 edit → 拒绝（not found）', async () => {
  const cwd = 'C:\\edit-void'
  await memory.execute({}, makeExec('s9', cwd)) // 记录 absent 观察
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: 'x', new_string: 'y' }, makeExec('s9', cwd)),
    /not found/,
  )
})

await check('read 后 edit：唯一匹配替换；连续 edit 免重读', async () => {
  const cwd = 'C:\\edit-ok'
  seed(dailyFile(cwd), '# 甲\n\n第一段\n\n# 乙\n\n第二段')
  await memory.execute({}, makeExec('s10', cwd))
  const out1 = await memory.execute({ mode: 'edit', old_string: '第一段', new_string: '第一段改' }, makeExec('s10', cwd))
  assert.match(out1, /edited \(1 occurrence replaced\)/)
  assert.ok(readFileSync(dailyFile(cwd), 'utf8').includes('第一段改'))
  const out2 = await memory.execute({ mode: 'edit', old_string: '第二段', new_string: '第二段改' }, makeExec('s10', cwd))
  assert.match(out2, /edited/, '成功写后观察已更新，连续编辑免重读')
})

await check('edit：多处匹配无 replace_all → 拒绝；replace_all 放行', async () => {
  const cwd = 'C:\\edit-all'
  seed(dailyFile(cwd), '# 重复\n\n词A 词A 词A')
  await memory.execute({}, makeExec('s11', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '词A', new_string: '词B' }, makeExec('s11', cwd)),
    /must be unique, or pass replace_all/,
  )
  const out = await memory.execute({ mode: 'edit', old_string: '词A', new_string: '词B', replace_all: true }, makeExec('s11', cwd))
  assert.match(out, /edited \(3 occurrences replaced\)/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 重复\n\n词B 词B 词B')
})

await check('edit：old_string 找不到 → 拒绝', async () => {
  const cwd = 'C:\\edit-nf'
  seed(dailyFile(cwd), '# 基线\n\n内容')
  await memory.execute({}, makeExec('s12', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '不存在的串', new_string: 'y' }, makeExec('s12', cwd)),
    /old_string not found/,
  )
})

await check('read 后外部直改再 edit：CAS 拒绝', async () => {
  const cwd = 'C:\\edit-stale'
  seed(dailyFile(cwd), '# 待外部改动\n\n基线内容')
  await memory.execute({}, makeExec('s13', cwd))
  seed(dailyFile(cwd), '# 待外部改动\n\n基线内容被另一会话大幅修改过了')
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '基线内容', new_string: 'y' }, makeExec('s13', cwd)),
    /changed since it was read/,
  )
})

// --- topic 参数 ----------------------------------------------------------------
await check('topic：定位 topics/<topic>.md 且可被检索索引', async () => {
  const out = await memory.execute({ topic: 'windows-env', mode: 'write', content: '# Windows 环境\n\npnpm 双实例教训' }, makeExec('s14'))
  assert.match(out, /· created/)
  const topicFile = join(memoryRoot(), 'topics', 'windows-env.md')
  assert.ok(existsSync(topicFile), 'topic 文件落在 topics/ 下')
  assert.ok(walkMemory(90).some((e) => e.rel === 'topics/windows-env.md'), '长期主题文件进检索语料')
})

await check('topic 读：不存在 → ABSENT（不带 topic 列表）', async () => {
  const out = await memory.execute({ topic: 'no-such-topic' }, makeExec('s15'))
  assert.match(out, /^ABSENT /)
  assert.ok(out.includes(join(memoryRoot(), 'topics', 'no-such-topic.md')))
  assert.ok(!out.includes('Existing long-term topics'), 'topic 定向读不附全局 topic 列表')
})

await check('topic：非法形态（路径分隔符/点/空白）→ 拒绝', async () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', 'has space']) {
    await assert.rejects(
      () => memory.execute({ topic: bad }, makeExec('s16')),
      /invalid topic/,
      `topic "${bad}" 应被拒绝`,
    )
  }
})

await check('topic：中文主题名合法（\\p{L} 放行）', async () => {
  const out = await memory.execute({ topic: '环境坑', mode: 'write', content: '# 环境' }, makeExec('s17'))
  assert.match(out, /· created/)
})

// --- 无会话与跨会话 --------------------------------------------------------------
await check('无会话调用：读自由、写仅 create、edit 恒拒（owner 语义镜像）', async () => {
  const out = await memory.execute({}, makeExec(null, 'C:\\anon'))
  assert.match(out, /^ABSENT /, '无 owner 读自由（absent 分支）')
  const cwd2 = 'C:\\anon2'
  const outCreate = await memory.execute({ mode: 'write', content: '# 匿名' }, makeExec(null, cwd2))
  assert.match(outCreate, /· created/, '无 owner 时不存在 → createIfAbsent 放行')
  await assert.rejects(
    () => memory.execute({ mode: 'write', content: 'x' }, makeExec(null, cwd2)),
    /read it first/,
    '无 owner 时已存在 → 拒绝',
  )
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '匿名', new_string: 'y' }, makeExec(null, cwd2)),
    /read it before editing/,
    '无 owner 时 edit 恒拒',
  )
})

await check('跨会话 CAS：A 读 → B 读后写 → A 编辑被拒', async () => {
  const cwd = 'C:\\race'
  seed(dailyFile(cwd), '# 会话竞争\n\n基线')
  await memory.execute({}, makeExec('sA', cwd)) // A 读，记录 present
  await memory.execute({}, makeExec('sB', cwd)) // B 也要先读，否则 B 的 write 被 createIfAbsent 拒绝
  await memory.execute({ mode: 'write', content: '# 会话竞争\n\nB 会话整替换' }, makeExec('sB', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'edit', old_string: '基线', new_string: 'y' }, makeExec('sA', cwd)),
    /changed since it was read/,
  )
})

// --- 每轮提醒：context 贡献（2026-08-29 恢复） ----------------------------------
await check('autoMemory=true 且主 agent：提醒为短时机文案（时机 + 必须用 memory 工具）', async () => {
  const { contextReg } = boot()
  assert.ok(contextReg, 'systemPrompt.context registered')
  assert.equal(contextReg.name, 'dsh-memory:auto')
  const text = contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work' } } } })
  assert.equal(text, 'When this turn produced something worth keeping across sessions, you MUST use the `memory` tool.')
  assert.ok(!text.includes('mode'), '提醒只讲时机，不含使用手法（手法在工具描述）')
})

await check('autoMemory=false：提醒为空', async () => {
  globalThis.__MEM_SETTINGS__ = { autoMemory: false }
  const { contextReg } = boot()
  assert.equal(contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work' } } } }), '')
  delete globalThis.__MEM_SETTINGS__
})

await check('子代理（delegationDepth>0）与无 agent：提醒为空', async () => {
  const { contextReg } = boot()
  assert.equal(contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work', delegationDepth: 1 } } } }), '')
  assert.equal(contextReg.text({}), '')
  assert.equal(contextReg.text({ agent: {} }), '')
})

// --- 工具面 ---------------------------------------------------------------------
await check('工具面：描述含机制与组织规则（时机规则外置 AGENTS.md）、参数齐全', async () => {
  assert.equal(name, 'dsh-memory')
  assert.ok(!memory.description.includes('必须'), '工具描述不得出现"必须"')
  assert.ok(/Read before modify/.test(memory.description), '描述含先读后改机制说明')
  assert.ok(/organize under # headings/i.test(memory.description), '组织规则在工具层（2026-08-29 分层：AGENTS.md 只写时机）')
  assert.ok(/never play-by-play/i.test(memory.description), '内容取舍规则在工具层')
  assert.ok(!/treat them as authoritative/.test(searchTool.description), '固化指引不在描述里——由检索结果组成驱动（2026-08-29）')
  assert.deepEqual(
    Object.keys(memory.parameters).sort(),
    ['content', 'mode', 'new_string', 'old_string', 'replace_all', 'topic'],
    '三模式 + topic 参数面',
  )
  assert.equal(memory.parameters.mode.required, undefined, 'mode 缺省即 read')
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)

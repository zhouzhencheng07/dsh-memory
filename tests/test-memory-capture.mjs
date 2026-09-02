// memory 两模式工具验证（2026-09-01：recall = 检索 + 读，remember = 新建 + 整替换 + 就地编辑）：
//   1) recall 无寻址参数 = 读今日笔记：不存在返回 ABSENT（无路径、无 topic 清单）且零写盘；
//      存在返回全文并记录观察；block 参数只读命中块；
//   2) date + workspace 寻址：读到别的日期/别的 workspace 的日记；非法 date、歧义
//      workspace、不存在的 workspace 都拒绝；
//   3) remember + content 镜像原生 createIfAbsent/CAS：未读已存在拒绝、读后整替换、
//      读后外部改动拒绝；原子写（无 .tmp 残留）；
//   4) remember + old_string 镜像原生 FS_NOT_OBSERVED/唯一匹配：未读拒绝、多处拒绝、
//      replace_all 放行、找不到拒绝、ABSENT 观察后编辑拒绝（not found）；
//   5) topic 参数：定位 topics/<topic>.md（可被检索索引）；非法 topic 拒绝；
//      写旧日记（date）被拒——旧日记只读；
//   6) 无会话调用：读自由、写仅 create、edit 恒拒（镜像原生 owner 语义）；
//      跨会话 CAS：A 读 → B 写 → A 编辑被拒；
//   7) 每轮提醒 = systemPrompt.context 贡献：文案只讲时机（必须用 memory 工具），
//      autoMemory 开关 / 子代理 / 无 agent 控制空文本；
//   8) 工具面：单工具注册、mode 必填枚举、描述承载机制与组织规则（无"必须"）、
//      参数面完整；任何输出不含记忆库绝对路径。
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
    inject: (deps, cb) => {
      if (deps.includes('settings')) {
        // v0.1.2-alpha.5 起的注册入口：ctx.settings.installSection（旧
        // installSettingsSection 独立导出已移除）。桩镜像真实热重载源：
        // 测试经 globalThis.__MEM_SETTINGS__ 在 boot 前注入字段值。
        cb({ settings: { installSection: (_owner, _ns, _schema, _entry, hooks) => {
          hooks?.setSource?.(() => globalThis.__MEM_SETTINGS__ ?? {})
        } } })
      } else {
        cb({ systemPrompt: { context: (reg) => { contextReg = reg } } })
      }
      return { dispose() {} }
    },
    effect: (fn) => fn(),
    on: () => { throw new Error('dsh-memory must not register host event hooks') },
  })
  const memory = registered.find((x) => x.name === 'memory')
  assert.ok(memory, 'the single `memory` tool is registered')
  assert.equal(registered.length, 1, 'no second tool (memory_search was folded into recall)')
  return { memory, contextReg }
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

/** The memory root must never leak into tool output. */
const assertNoPath = (out, label) => {
  const root = memoryRoot().replaceAll('\\', '/')
  assert.ok(!out.includes(root), `${label}: output must not carry the memory root path, got:\n${out}`)
  assert.ok(!/[A-Za-z]:[\\/]/.test(out), `${label}: output must not carry any Windows path, got:\n${out}`)
}

const { memory } = boot()

// --- recall：读今日笔记 ---------------------------------------------------------
await check('recall 不存在：ABSENT + 创建指引，无路径、无 topic 清单，零写盘', async () => {
  const out = await memory.execute({ mode: 'recall' }, makeExec('s1', 'C:\\absent'))
  assert.match(out, /^ABSENT /)
  assert.match(out, /mode:"remember"/, '指引创建')
  assert.ok(!out.includes('topics/'), 'ABSENT 不列长期 topic 清单（2026-09-01）')
  assertNoPath(out, 'ABSENT')
  assert.ok(!existsSync(dailyFile('C:\\absent')), 'recall 绝不创建文件')
})

await check('recall 存在：以身份标识开头 + 返回全文 + 维护指引', async () => {
  const cwd = 'C:\\read-exists'
  const note = '# 主题甲\n\n正文一行'
  seed(dailyFile(cwd), note)
  const out = await memory.execute({ mode: 'recall' }, makeExec('s2', cwd))
  assert.match(out, /^today's note/, '以身份标识开头（非路径）')
  assert.ok(out.includes(note), '返回全文')
  assert.match(out, /mode:"remember"/, '指引就地维护')
  assertNoPath(out, 'read exists')
})

await check('recall + block：只读命中的块', async () => {
  const cwd = 'C:\\read-block'
  seed(dailyFile(cwd), '# 甲\n\n第一段\n\n# 乙\n\n第二段')
  const out = await memory.execute({ mode: 'recall', block: '乙' }, makeExec('s2b', cwd))
  assert.ok(out.includes('第二段'), '命中块正文')
  assert.ok(!out.includes('第一段'), '其它块的正文不出现')
  const missing = await memory.execute({ mode: 'recall', block: '不存在' }, makeExec('s2b', cwd))
  assert.match(missing, /No block "不存在"/)
  assert.match(missing, /甲/, '未命中时列出可用块名')
})

// --- recall：date + workspace 寻址 ----------------------------------------------
const YESTERDAY = '2026-08-31'
await check('recall + date：读到别的日期的日记（本 workspace）', async () => {
  const cwd = 'C:\\dated'
  const file = join(memoryRoot(), YESTERDAY, `${sessionSlug(cwd)}.md`)
  seed(file, '# 昨日\n\n昨天的正文')
  const out = await memory.execute({ mode: 'recall', date: YESTERDAY }, makeExec('s3a', cwd))
  assert.ok(out.includes('昨天的正文'), `got:\n${out}`)
  assert.match(out, new RegExp(`^${YESTERDAY}`), '以 date 开头')
  assertNoPath(out, 'date recall')
})

await check('recall + date + workspace：跨 workspace 读，且支持片段模糊匹配', async () => {
  const other = 'D:\\Project\\other-repo'
  const file = join(memoryRoot(), YESTERDAY, `${sessionSlug(other)}.md`)
  seed(file, '# 别的项目\n\n别的工作区的正文')
  // 全形标签
  const full = await memory.execute({ mode: 'recall', date: YESTERDAY, workspace: 'D-Project-other-repo' }, makeExec('s3b'))
  assert.ok(full.includes('别的工作区的正文'), `full label got:\n${full}`)
  // 片段标签（agent 抄不全也能命中）
  const frag = await memory.execute({ mode: 'recall', date: YESTERDAY, workspace: 'other-repo' }, makeExec('s3b'))
  assert.ok(frag.includes('别的工作区的正文'), `fragment got:\n${frag}`)
})

await check('recall + workspace：歧义与不存在都拒绝（不静默落到错的 workspace）', async () => {
  seed(join(memoryRoot(), YESTERDAY, `${sessionSlug('D:\\a\\dup-one')}.md`), '# 一\n\nx')
  seed(join(memoryRoot(), YESTERDAY, `${sessionSlug('D:\\a\\dup-two')}.md`), '# 二\n\ny')
  await assert.rejects(
    () => memory.execute({ mode: 'recall', date: YESTERDAY, workspace: 'dup' }, makeExec('s3c')),
    /matches 2 workspaces/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'recall', date: YESTERDAY, workspace: 'nope' }, makeExec('s3c')),
    /no note for/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'recall', date: '2026-13-45' }, makeExec('s3c')),
    /YYYY-MM-DD/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'recall', workspace: 'x' }, makeExec('s3c')),
    /workspace requires a date/,
  )
})

// --- remember + content ---------------------------------------------------------
await check('remember 不存在 → 创建，无 .tmp 残留', async () => {
  const cwd = 'C:\\write-create'
  const out = await memory.execute({ mode: 'remember', content: '# 新笔记\n\n内容' }, makeExec('s4', cwd))
  assert.match(out, /· created/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 新笔记\n\n内容')
  assert.deepEqual(readdirSync(join(dailyFile(cwd), '..')).filter((n) => n.includes('.tmp-')), [], '原子写不残留临时文件')
  assertNoPath(out, 'create')
})

await check('remember 已存在有内容未读 → 拒绝（content 安全规约：非空文件必须用 old_string）', async () => {
  const cwd = 'C:\\write-exists'
  seed(dailyFile(cwd), '# 已有笔记')
  await assert.rejects(
    () => memory.execute({ mode: 'remember', content: 'x' }, makeExec('s5', cwd)),
    /already has content/,
  )
})

await check('recall 已存在非空 → content 被拒绝（必须用 old_string）', async () => {
  const cwd = 'C:\\rw'
  seed(dailyFile(cwd), '# 原文')
  await memory.execute({ mode: 'recall' }, makeExec('s6', cwd)) // 记录观察
  await assert.rejects(
    () => memory.execute({ mode: 'remember', content: '# 整替换' }, makeExec('s6', cwd)),
    /already has content/,
  )
})

await check('recall 后外部直改再 remember → CAS 拒绝', async () => {
  const cwd = 'C:\\stale-w'
  seed(dailyFile(cwd), '# 原文')
  await memory.execute({ mode: 'recall' }, makeExec('s7', cwd))
  seed(dailyFile(cwd), '# 外部长了很多很多很多行的改动')
  await assert.rejects(
    () => memory.execute({ mode: 'remember', content: 'x' }, makeExec('s7', cwd)),
    /already has content/,
  )
})

await check('remember：content 与 old_string 同时给 → 拒绝；都不给 → 拒绝', async () => {
  const cwd = 'C:\\both'
  await assert.rejects(
    () => memory.execute({ mode: 'remember', content: 'a', old_string: 'b' }, makeExec('s8', cwd)),
    /not both/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'remember' }, makeExec('s8', cwd)),
    /needs either content/,
  )
})

await check('空文件可 content 填充（文件存在但为空 = 等 同 absent）', async () => {
  const cwd = 'C:\\empty-fill'
  seed(dailyFile(cwd), '') // 空文件
  await memory.execute({ mode: 'recall' }, makeExec('s8b', cwd))
  const out = await memory.execute({ mode: 'remember', content: '# 填充空文件' }, makeExec('s8b', cwd))
  assert.match(out, /· created/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 填充空文件')
})

// --- remember + old_string -------------------------------------------------------
await check('remember 编辑：文件存在但从未读 → 拒绝（FS_NOT_OBSERVED 镜像）', async () => {
  const cwd = 'C:\\edit-unread'
  seed(dailyFile(cwd), '# 未读先改')
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '未读先改', new_string: 'y' }, makeExec('s9', cwd)),
    /recall it before editing/,
  )
})

await check('remember 编辑：文件不存在从未读 → 拒绝（requires recalling）', async () => {
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: 'x', new_string: 'y' }, makeExec('s10', 'C:\\edit-missing')),
    /editing requires recalling/,
  )
})

await check('recall（ABSENT）后编辑 → 拒绝（not found）', async () => {
  const cwd = 'C:\\edit-void'
  await memory.execute({ mode: 'recall' }, makeExec('s11', cwd)) // 记录 absent 观察
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: 'x', new_string: 'y' }, makeExec('s11', cwd)),
    /not found/,
  )
})

await check('recall 后编辑：唯一匹配替换；连续编辑免重读', async () => {
  const cwd = 'C:\\edit-ok'
  seed(dailyFile(cwd), '# 甲\n\n第一段\n\n# 乙\n\n第二段')
  await memory.execute({ mode: 'recall' }, makeExec('s12', cwd))
  const out1 = await memory.execute({ mode: 'remember', old_string: '第一段', new_string: '第一段改' }, makeExec('s12', cwd))
  assert.match(out1, /edited \(1 occurrence replaced\)/)
  assert.ok(readFileSync(dailyFile(cwd), 'utf8').includes('第一段改'))
  const out2 = await memory.execute({ mode: 'remember', old_string: '第二段', new_string: '第二段改' }, makeExec('s12', cwd))
  assert.match(out2, /edited/, '成功写后观察已更新，连续编辑免重读')
})

await check('remember 编辑：多处匹配无 replace_all → 拒绝；replace_all 放行', async () => {
  const cwd = 'C:\\edit-all'
  seed(dailyFile(cwd), '# 重复\n\n词A 词A 词A')
  await memory.execute({ mode: 'recall' }, makeExec('s13', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '词A', new_string: '词B' }, makeExec('s13', cwd)),
    /must be unique, or pass replace_all/,
  )
  const out = await memory.execute({ mode: 'remember', old_string: '词A', new_string: '词B', replace_all: true }, makeExec('s13', cwd))
  assert.match(out, /edited \(3 occurrences replaced\)/)
  assert.equal(readFileSync(dailyFile(cwd), 'utf8'), '# 重复\n\n词B 词B 词B')
})

await check('remember 编辑：old_string 找不到 → 拒绝', async () => {
  const cwd = 'C:\\edit-nf'
  seed(dailyFile(cwd), '# 基线\n\n内容')
  await memory.execute({ mode: 'recall' }, makeExec('s14', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '不存在的串', new_string: 'y' }, makeExec('s14', cwd)),
    /old_string not found/,
  )
})

await check('recall 后外部直改再编辑：CAS 拒绝', async () => {
  const cwd = 'C:\\edit-stale'
  seed(dailyFile(cwd), '# 待外部改动\n\n基线内容')
  await memory.execute({ mode: 'recall' }, makeExec('s15', cwd))
  seed(dailyFile(cwd), '# 待外部改动\n\n基线内容被另一会话大幅修改过了')
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '基线内容', new_string: 'y' }, makeExec('s15', cwd)),
    /changed since you read it/,
  )
})

// --- topic 参数 ----------------------------------------------------------------
await check('topic：定位 topics/<topic>.md 且可被检索索引', async () => {
  const out = await memory.execute({ mode: 'remember', topic: 'windows-env', content: '# Windows 环境\n\npnpm 双实例教训' }, makeExec('s16'))
  assert.match(out, /· created/)
  assert.match(out, /^topics\/windows-env/, '回执用身份标识')
  const topicFile = join(memoryRoot(), 'topics', 'windows-env.md')
  assert.ok(existsSync(topicFile), 'topic 文件落在 topics/ 下')
  assert.ok(walkMemory(90).some((e) => e.rel === 'topics/windows-env.md'), '长期主题文件进检索语料')
  assertNoPath(out, 'topic create')
})

await check('topic 读：不存在 → ABSENT（不带 topic 清单）', async () => {
  const out = await memory.execute({ mode: 'recall', topic: 'no-such-topic' }, makeExec('s17'))
  assert.match(out, /^ABSENT /)
  assert.ok(out.includes('topics/no-such-topic'), 'ABSENT 提到身份标识')
  assert.ok(!out.includes('Existing long-term topics'), '不列全局 topic 清单（2026-09-01）')
  assertNoPath(out, 'topic ABSENT')
})

await check('topic：非法字符（点/空白/反斜杠/多级路径）→ 拒绝', async () => {
  // 2026-09-01：`a/b` 现在是"<长期目录>/<名字>"的合法形态，非法性由
  // 字符白名单与长期目录白名单分别把关，故此处只测字符类非法输入
  for (const bad of ['../evil', 'a\\b', '.hidden', 'has space', 'a/b/c']) {
    await assert.rejects(
      () => memory.execute({ mode: 'recall', topic: bad }, makeExec('s18')),
      /invalid topic/,
      `topic "${bad}" 应被拒绝`,
    )
  }
})

await check('topic：中文主题名合法（\\p{L} 放行）', async () => {
  const out = await memory.execute({ mode: 'remember', topic: '环境坑', content: '# 环境' }, makeExec('s19'))
  assert.match(out, /· created/)
})

await check('topic + date 同时给 → 拒绝', async () => {
  await assert.rejects(
    () => memory.execute({ mode: 'recall', topic: 'x', date: YESTERDAY }, makeExec('s20')),
    /not both/,
  )
})

await check('topic 定向读：遗留 memory/ 目录可寻址（改写仍落 topics/）', async () => {
  // 2026-08-29 改名前的长期目录仍被索引，命中后必须能读（否则命中是死路）
  const legacyFile = join(memoryRoot(), 'memory', 'legacy-topic.md')
  seed(legacyFile, '# 遗留主题\n\n旧布局的正文')
  const out = await memory.execute({ mode: 'recall', topic: 'memory/legacy-topic' }, makeExec('s20b'))
  assert.ok(out.includes('旧布局的正文'), `legacy read got:\n${out}`)
  assert.match(out, /^memory\/legacy-topic/)
  // 写面：仍指向 topics/（新内容归当前布局）
  const created = await memory.execute({ mode: 'remember', topic: 'memory/legacy-topic', content: '# 新' }, makeExec('s20b'))
  assert.ok(created.startsWith('topics/legacy-topic'), `write lands in topics/, got:\n${created}`)
  assert.ok(existsSync(join(memoryRoot(), 'topics', 'legacy-topic.md')))
})

await check('topic 非法目录 → 拒绝（模型只可命名文件，不可导航）', async () => {
  await assert.rejects(
    () => memory.execute({ mode: 'recall', topic: '2026-08-31/x' }, makeExec('s20c')),
    /not a long-term directory/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'recall', topic: 'a/b/c' }, makeExec('s20c')),
    /at most one directory level/,
  )
})

// --- 旧日记只读 ----------------------------------------------------------------
await check('remember 写旧日记（date）→ 拒绝（旧日记只读，随衰减退场）', async () => {
  await assert.rejects(
    () => memory.execute({ mode: 'remember', date: YESTERDAY, content: 'x' }, makeExec('s21')),
    /read-only/,
  )
  await assert.rejects(
    () => memory.execute({ mode: 'remember', date: YESTERDAY, old_string: 'x' }, makeExec('s21')),
    /read-only/,
  )
})

// --- 无会话与跨会话 --------------------------------------------------------------
await check('无会话调用：读自由、写仅 create、编辑恒拒（owner 语义镜像）', async () => {
  const out = await memory.execute({ mode: 'recall' }, makeExec(null, 'C:\\anon'))
  assert.match(out, /^ABSENT /, '无 owner 读自由（absent 分支）')
  const cwd2 = 'C:\\anon2'
  const outCreate = await memory.execute({ mode: 'remember', content: '# 匿名' }, makeExec(null, cwd2))
  assert.match(outCreate, /· created/, '无 owner 时不存在 → createIfAbsent 放行')
  await assert.rejects(
    () => memory.execute({ mode: 'remember', content: 'x' }, makeExec(null, cwd2)),
    /already has content/,
    '无 owner 时已存在有内容 → content 拒绝（文件非空）',
  )
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '匿名', new_string: 'y' }, makeExec(null, cwd2)),
    /recall it before editing/,
    '无 owner 时编辑恒拒',
  )
})

await check('跨会话 CAS：A 读 → B 读后编辑 → A 编辑被拒', async () => {
  const cwd = 'C:\\race'
  seed(dailyFile(cwd), '# 会话竞争\n\n基线')
  await memory.execute({ mode: 'recall' }, makeExec('sA', cwd)) // A 读，记录 present
  await memory.execute({ mode: 'recall' }, makeExec('sB', cwd)) // B 也要先读，否则 B 的编辑被 not_observed 拒绝
  await memory.execute({ mode: 'remember', old_string: '基线', new_string: 'B 会话修改内容' }, makeExec('sB', cwd))
  await assert.rejects(
    () => memory.execute({ mode: 'remember', old_string: '基线', new_string: 'y' }, makeExec('sA', cwd)),
    /changed since you read it/,
  )
})

// --- 每轮提醒：context 贡献 -------------------------------------------------------
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
await check('工具面：单工具、mode 必填枚举、描述含机制与组织规则、参数齐全', async () => {
  assert.equal(name, 'dsh-memory')
  assert.ok(!memory.description.includes('必须'), '工具描述不得出现"必须"')
  assert.ok(/read before modify/i.test(memory.description), '描述含先读后改机制说明')
  assert.ok(/organize under # headings/i.test(memory.description), '组织规则在工具层')
  assert.ok(/never play-by-play/i.test(memory.description), '内容取舍规则在工具层')
  assert.deepEqual(memory.parameters.mode.enum, ['recall', 'remember'], 'mode 是两值枚举')
  assert.equal(memory.parameters.mode.required, true, 'mode 必填（镜像原生 str_replace_editor 的 command）')
  assert.deepEqual(
    Object.keys(memory.parameters).sort(),
    ['block', 'content', 'date', 'keywords', 'mode', 'new_string', 'old_string', 'replace_all', 'topic', 'workspace'],
    'recall/remember 合并后的参数面',
  )
})

await check('mode 缺失或非法 → 拒绝（不猜）', async () => {
  await assert.rejects(() => memory.execute({}, makeExec('s22')), /mode must be/)
  await assert.rejects(() => memory.execute({ mode: 'read' }, makeExec('s22')), /mode must be/)
  await assert.rejects(() => memory.execute({ mode: 'write' }, makeExec('s22')), /mode must be/)
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)

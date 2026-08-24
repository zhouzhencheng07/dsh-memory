// 记忆捕获定稿机制验证（2026-08-23）：
//   1) memory 工具 = 路径定位器：无参；不存在自动创建（内容=来源注释）、
//      存在合并当前会话 id（精确幂等，已在则零写）；子派发原生 read/write，
//      观察版本与沙箱栅栏照常生效；
//   2) 每轮提醒 = systemPrompt.context 贡献，文案极短（时机+必须用 memory
//      工具），autoMemory 开关 / 子代理 / 无 agent 控制空文本；
//   3) 语义分层：提醒带"必须"、工具描述中性（无"必须"）；
//   4) 零 host hook：apply 期间注册任何 ctx.on 即失败。
// 用法：node --import ./tests/register-mem-test.mjs tests/test-memory-capture.mjs
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MEM_TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-mem-capture-'))

const { apply, name } = await import('../src/index.js')
const { todayStamp, memoryRoot } = await import('../src/store.js')

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`ok   ${label}`)
}

// --- fake native fs pipeline (dsh-tools + observation-policy semantics) ----
function makeFs(mode) {
  const files = new Map() // path -> { text, version }
  const observed = new Map() // sessionId -> Map(path -> version)
  const calls = []
  const versionOf = (p) => files.get(p)?.version ?? 0
  const ok = (value) => ({ isError: false, value })
  const fail = (message, code = 'FAKE_FS') => ({ isError: true, error: { message, info: { name: 'FakeFs', code } } })
  const tools = {
    async execute(input) {
      calls.push(input)
      const sessionKey = input.agent?.session?.id
      const path = input.arguments.file_path
      const record = (p) => {
        if (!sessionKey) return
        if (!observed.has(sessionKey)) observed.set(sessionKey, new Map())
        observed.get(sessionKey).set(p, versionOf(p))
      }
      const denied = (op) => fail(`[sandbox: ${op} denied under workspace-write mode]`, 'FS_SANDBOX_DENIED')
      switch (input.name) {
        case 'read': {
          const f = files.get(path)
          if (!f) return fail('ENOENT: no such file or directory, open ...', 'FS_ENOENT')
          record(path)
          const lines = f.text.split('\n').map((text, i) => ({ number: i + 1, text }))
          return ok({ path, offset: 1, lines, totalLines: lines.length })
        }
        case 'write': {
          if (mode === 'workspace' && !path.startsWith('C:/work/')) return denied('write')
          const existing = files.has(path)
          const seen = sessionKey ? observed.get(sessionKey)?.get(path) ?? null : null
          // createIfAbsent semantics: unseen → create only
          if (existing && seen === null) return fail('write refused: file already exists, read it first (createIfAbsent)', 'FS_EXISTS')
          if (existing && seen !== null && seen !== versionOf(path)) return fail('stale version: file changed since read', 'FS_STALE')
          const before = existing ? files.get(path).text : null
          mkdirSync(join(path, '..'), { recursive: true })
          writeFileSync(path, input.arguments.content, 'utf8')
          files.set(path, { text: input.arguments.content, version: versionOf(path) + 1 })
          record(path)
          return ok({ path, operation: before === null ? 'create' : 'update', before, after: input.arguments.content })
        }
        default:
          return fail(`unknown tool ${input.name}`, 'UNKNOWN_TOOL')
      }
    },
  }
  return { files, calls, tools, observed }
}

function makeExec(sessionId = 's1', cwd = 'C:\\work') {
  return {
    callId: 'root-call-1',
    rootCallId: 'root-call-1',
    token: Symbol('token'),
    agent: { session: { id: sessionId, header: { cwd } } },
    signal: new AbortController().signal,
  }
}

function boot(fs) {
  const registered = []
  let contextReg = null
  const ctx = {
    tools: {
      register: (tool) => registered.push(tool),
      execute: fs.tools.execute,
    },
    inject: (_deps, cb) => {
      cb({ systemPrompt: { context: (reg) => { contextReg = reg } } })
      return { dispose() {} }
    },
    effect: (fn) => fn(),
    on: () => { throw new Error('dsh-memory must not register host event hooks') },
  }
  assert.equal(name, 'dsh-memory')
  apply(ctx)
  const memory = registered.find((x) => x.name === 'memory')
  const search = registered.find((x) => x.name === 'memory_search')
  assert.ok(memory && search, 'memory + memory_search registered')
  return { memory, search, contextReg }
}

const file = () => join(memoryRoot(), todayStamp(), '--C-work--.md')
const NOTE = '<!-- 会话来源: s1 -->\n\n# 主题甲\n\n正文一行'
const REMINDER = 'When this turn produced something worth keeping across sessions, you MUST use the `memory` tool.'

/** Seed an existing note BOTH on disk (store.js node:fs reads) and in the
 * fake fs (native dispatch state). */
function seedFile(fs, text, version = 1) {
  const p = file()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text, 'utf8')
  fs.files.set(p, { text, version })
  fs.calls.length = 0
  return p
}

// --- memory 工具：路径定位器 -------------------------------------------------
await check('不存在时：read 探测失败 → write 创建（内容=来源注释）并回显路径', async () => {
  const fs = makeFs('full')
  const { memory } = boot(fs)
  const out = await memory.execute({}, makeExec())
  assert.match(out, /created/)
  assert.match(out, new RegExp(file().replace(/\\/g, '\\\\')))
  assert.deepEqual(fs.calls.map((c) => c.name), ['read', 'write'])
  assert.equal(fs.files.get(file()).text, '<!-- 会话来源: s1 -->')
})

await check('已存在未读：read 探测记录观察 → write 合并第二个会话来源', async () => {
  const fs = makeFs('full')
  seedFile(fs, NOTE)
  const { memory } = boot(fs)
  const out = await memory.execute({}, makeExec('s2'))
  assert.match(out, /existing/)
  assert.deepEqual(fs.calls.map((c) => c.name), ['read', 'write'])
  assert.match(fs.files.get(file()).text, /<!-- 会话来源: s1, s2 -->/)
  assert.match(fs.files.get(file()).text, /# 主题甲/)
})

await check('已存在且 id 已在：精确幂等，仅探测 read、零写', async () => {
  const fs = makeFs('full')
  seedFile(fs, NOTE)
  const { memory } = boot(fs)
  const out = await memory.execute({}, makeExec('s1'))
  assert.match(out, /existing/)
  assert.deepEqual(fs.calls.map((c) => c.name), ['read'])
  assert.equal(fs.files.get(file()).text, NOTE)
})

await check('已存在但无来源注释的历史文件：合并补上来源', async () => {
  const fs = makeFs('full')
  seedFile(fs, '# 主题\n\n内容')
  const { memory } = boot(fs)
  await memory.execute({}, makeExec())
  assert.match(fs.files.get(file()).text, /^<!-- 会话来源: s1 -->\n\n# 主题/)
})

await check('workspace-write 沙箱下：写被诚实拒绝，工具报错', async () => {
  const fs = makeFs('workspace')
  const { memory } = boot(fs)
  await assert.rejects(memory.execute({}, makeExec()), /sandbox|denied/i)
})

// --- 每轮提醒：context 贡献 ----------------------------------------------------
await check('autoMemory=true 且主 agent：文本为短提醒（时机 + 必须用 memory 工具）', async () => {
  const fs = makeFs('full')
  const { contextReg } = boot(fs)
  assert.ok(contextReg, 'systemPrompt.context registered')
  assert.equal(contextReg.name, 'dsh-memory:auto')
  const text = contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work' } } } })
  assert.equal(text, REMINDER)
  // 语义分层：提醒只讲时机与"必须用工具"，不含写作手法（read/edit/write、主题等）
  assert.ok(!text.includes('read'), '提醒不携带读写手法')
})

await check('autoMemory=false：提醒为空', async () => {
  const fs = makeFs('full')
  globalThis.__MEM_SETTINGS__ = { autoMemory: false }
  const { contextReg } = boot(fs)
  assert.equal(contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work' } } } }), '')
  delete globalThis.__MEM_SETTINGS__
})

await check('子代理（delegationDepth>0）与无 agent：提醒为空', async () => {
  const fs = makeFs('full')
  const { contextReg } = boot(fs)
  assert.equal(contextReg.text({ agent: { session: { id: 's1', header: { cwd: 'C:\\work', delegationDepth: 1 } } } }), '')
  assert.equal(contextReg.text({}), '')
  assert.equal(contextReg.text({ agent: {} }), '')
})

// --- 语义分层：工具描述中性 -----------------------------------------------------
await check('memory 工具描述中性：不含"必须"催促', async () => {
  const fs = makeFs('full')
  const { memory } = boot(fs)
  assert.ok(!memory.description.includes('必须'), '工具描述不得出现"必须"')
  assert.ok(/maintain/i.test(memory.description), '工具描述给出维护指引')
  assert.deepEqual(memory.parameters, {}, 'memory 工具无参数')
})

rmSync(process.env.MEM_TEST_HOME, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
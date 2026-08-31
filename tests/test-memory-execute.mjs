// End-to-end checks for memory {mode:"recall", keywords:…} across the
// two-layer corpus (2026-09-01: memory_search is gone, retrieval is the
// `recall` mode of the single memory tool): trim notices + the hard daily
// window + MIN_SCORE filtering + the CONFIGURABLE ADDITIVE long-term append
// seat, plus the new ADDRESS output (no file paths — a row is the key you
// feed back into recall).
// Boots src/index.js against the @deepseek-ai/* stubs, points $MEM_TEST_HOME
// at a temp sandbox seeded with layered notes, and drives the tool directly.
// Usage: node --import ./tests/register-mem-test.mjs tests/test-memory-execute.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-mem-e2e-'))
process.env.MEM_TEST_HOME = home

const dayStamp = (offsetDays) => {
  const d = new Date(Date.now() - offsetDays * 86400000)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
const seed = (dirParts, file, text) => {
  const dir = join(home, 'dsh-memory', ...dirParts)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), text)
}
seed([dayStamp(0)], 'note.md', '# 今日流水\n\nalphaunique 只出现在今天的日记里。\n')
seed([dayStamp(10)], 'note.md', '# 十天前\n\nbetaunique 出现在十天前的日记里，还没出窗。\n')
seed([dayStamp(200)], 'note.md', '# 远古记录\n\ngammaunique 出现在两百天前的日记里，应被窗口挡住。\n')
seed(['topics'], 'memory.md', '# 用户环境\n\ndeltaunique 记录在长期记忆里，永不衰减、不受窗口限制。\n')

const plugin = await import('../src/index.js')

/** Boot the plugin against a fresh registry with the given settings. */
function boot(settings) {
  globalThis.__MEM_SETTINGS__ = { embeddingBaseUrl: '', dailyWindowDays: 90, ...settings }
  const registered = []
  plugin.apply({
    tools: { register: (tool) => registered.push(tool) },
    inject: () => {},
    effect: () => {},
  })
  const memory = registered.find((t) => t.name === 'memory')
  assert.ok(memory, 'the single memory tool is registered')
  assert.equal(registered.length, 1)
  return memory
}

/** Count result rows in formatted output (each row starts with `- [`). */
const rowCount = (out) => out.split('- [').length - 1

// --- default boot: searchLimit 5 ----------------------------------------------
const memory = boot({ searchLimit: 5 })

// --- single-keyword basics ------------------------------------------------------
const out1 = await memory.execute({ mode: 'recall', keywords: 'alphaunique' })
assert.match(out1, /今日流水/)
// 2026-09-01: rows carry an ADDRESS (date · workspace), never a path
assert.match(out1, new RegExp(`- \\[${dayStamp(0)} · note\\] 今日流水`), `hits must carry an address, got:\n${out1}`)
assert.ok(!out1.includes(home.replaceAll('\\', '/')), `output must not leak the library path, got:\n${out1}`)
assert.ok(!/\.md/.test(out1.split('\n').find((l) => l.startsWith('- [')) ?? ''), 'the row itself must not name a .md file')
assert.match(out1, /mode:"recall", date:/, 'rows tell the model how to read a hit in full')
assert.match(out1, /mode:"remember", topic:"<name>"/, 'daily-only hits end with the FILE-NEW promotion hint')
assert.ok(!out1.includes('authoritative'), 'file-new branch excludes the authoritative branch')

const outCap = await memory.execute({ mode: 'recall', keywords: 'alphaunique extra1 extra2 extra3 extra4 extra5 extra6 extra7 extra8' })
assert.match(outCap, /^keywords capped to 5 \(dropped: extra5, extra6, extra7, extra8\)/)

await assert.rejects(() => memory.execute({ mode: 'recall', keywords: '   ' }), /no usable keywords/)

// --- hard daily window (default 90) -------------------------------------------
const outOld = await memory.execute({ mode: 'recall', keywords: 'gammaunique' })
assert.ok(outOld.includes('No memory found.'), '200-day-old diary is outside the 90-day window')
assert.match(outOld, /no note contains "gammaunique"/, 'the absent keyword is reported back for rewording')
assert.ok(!outOld.includes('mode:"remember"'), 'empty results carry no promotion hint')

const outMid = await memory.execute({ mode: 'recall', keywords: 'betaunique' })
assert.match(outMid, /十天前/, '10-day-old diary stays inside the window')

// --- long-term participation: first place is already long-term ------------------
const outLong = await memory.execute({ mode: 'recall', keywords: 'deltaunique' })
assert.match(outLong, /- \[topics\/memory\] 用户环境/, `long-term rows carry the topic address, got:\n${outLong}`)
assert.ok(outLong.includes('authoritative'), 'long-term block among hits ⇒ authoritative branch (2026-08-29)')
assert.ok(!outLong.includes('file it with memory'), 'authoritative branch excludes the file-new branch')
assert.equal(rowCount(outLong), 1, 'long-term first place must NOT gain a duplicate append seat')

// --- MIN_SCORE floor: weak partial matches never surface ------------------------
seed([dayStamp(60)], 'low.md', '# 陈旧旁证\n\nzombietoken 出现在六十天前的日记里。\n')
seed([dayStamp(0)], 'anchor.md', '# 今日锚\n\nfreshanchor 在今天的日记里。\n')
const outWeak = await memory.execute({ mode: 'recall', keywords: 'freshanchor p1 p2 zombietoken' })
assert.match(outWeak, /今日锚/, 'the strong primary hit still surfaces')
assert.ok(!outWeak.includes('陈旧旁证'), 'aged secondary-only noise is dropped by MIN_SCORE')

// --- a hit row is a working read key: feed it back into recall ------------------
// This is the whole point of the address output (2026-09-01): the model has no
// path, so date + workspace + block must reopen exactly what the row showed.
const hitRow = outWeak.split('\n').find((l) => l.startsWith('- ['))
const addr = /^- \[([^\]]+)\] (.*?) \(score/.exec(hitRow)
assert.ok(addr, `row must parse as an address, got: ${hitRow}`)
const [datePart, workspacePart] = addr[1].split(' · ')
const blockPart = addr[2]
const readBack = await memory.execute({ mode: 'recall', date: datePart, workspace: workspacePart, block: blockPart })
assert.match(readBack, /freshanchor/, `date+workspace+block must reopen the hit, got:\n${readBack}`)

// --- store-level window semantics ----------------------------------------------
const { walkMemory } = await import('../src/store.js')
const rels = (win) => walkMemory(win).map((e) => e.rel).sort()
assert.ok(rels().some((r) => r.includes(dayStamp(200))), 'no window → everything indexed')
const w90 = rels(90)
assert.ok(w90.some((r) => r.startsWith('topics/')), 'the long-term file is never windowed')
assert.ok(w90.some((r) => r.includes(dayStamp(10))), 'in-window diary indexed')
assert.ok(!w90.some((r) => r.includes(dayStamp(200))), 'out-of-window diary excluded')
assert.equal(walkMemory('nonsense').length, walkMemory(0).length, 'non-numeric window behaves as disabled')

// --- additive long-term append seat ----------------------------------------------
// Two fresh diaries with DOUBLE reservetoken occurrences legitimately outrank
// a normal-sized long-term block with one occurrence: with limit 2 both slots
// are diaries, so the best-ranking long-term block must be APPENDED as a
// third row (never evicting 昨日流水).
seed([dayStamp(0)], 'r-a.md', '# 近水楼台\n\nreservetoken 出现在今天的日记。reservetoken 再现一次。\n')
seed([dayStamp(1)], 'r-b.md', '# 昨日流水\n\nreservetoken 出现在昨天的日记。reservetoken 再现一次。\n')
seed(['topics'], 'memory-append.md', '# 追加测试\n\nreservetoken 出现在长期记忆里，永不衰减。\n')
const memory2 = boot({ searchLimit: 2 })
const outAppend = await memory2.execute({ mode: 'recall', keywords: 'reservetoken' })
assert.match(outAppend, /近水楼台/, 'best diary keeps slot 1')
assert.match(outAppend, /昨日流水/, 'second diary KEEPS slot 2 (additive, not evicting)')
assert.match(outAppend, /追加测试/, 'best-ranking long-term block appended after the regular results')
assert.equal(rowCount(outAppend), 3)
assert.ok(outAppend.includes('authoritative'), 'appended long-term seat flips the hint to the authoritative branch')

// off switch: pure top-N
const memoryOff = boot({ searchLimit: 2, longtermAppend: false })
const outOff = await memoryOff.execute({ mode: 'recall', keywords: 'reservetoken' })
assert.match(outOff, /近水楼台/)
assert.match(outOff, /昨日流水/)
assert.ok(!outOff.includes('追加测试'), 'longtermAppend:false disables the seat entirely')
assert.equal(rowCount(outOff), 2)

// limit 1: the seat now works additively where the old eviction could not
const memory3 = boot({ searchLimit: 1 })
const outSolo = await memory3.execute({ mode: 'recall', keywords: 'reservetoken' })
assert.match(outSolo, /近水楼台/, 'limit 1 keeps the top diary')
assert.match(outSolo, /追加测试/, 'limit 1 gains the appended long-term block')
assert.equal(rowCount(outSolo), 2)

// --- recall with keywords ignores the addressing parameters ----------------------
const outBoth = await memory2.execute({ mode: 'recall', keywords: 'reservetoken', topic: 'ignored' })
assert.equal(rowCount(outBoth), 3, 'keywords win: the search path runs, address params are not mixed in')

// --- memoryRoot setting (2026-09-01: a setting, not an env var) ------------------
const customRoot = mkdtempSync(join(tmpdir(), 'dsh-mem-custom-'))
mkdirSync(join(customRoot, 'topics'), { recursive: true })
writeFileSync(join(customRoot, 'topics', 'elsewhere.md'), '# 别处\n\ncustomroottoken 只存在于自定义根目录。\n')
const memoryRooted = boot({ searchLimit: 2, memoryRoot: customRoot })
const outCustom = await memoryRooted.execute({ mode: 'recall', keywords: 'customroottoken' })
assert.match(outCustom, /别处/, 'the memoryRoot setting relocates the whole library')
assert.match(outCustom, /- \[topics\/elsewhere\]/, 'rows stay path-free under a custom root too')
assert.ok(!outCustom.includes('reservetoken'), 'the default root is NOT searched alongside it')
assert.ok(!outCustom.includes(customRoot.replaceAll('\\', '/')), 'the custom root must not leak either')

console.log('execute-layer checks passed (recall params, notices, window, MIN_SCORE, address output, hit-row read-back, composition-driven long-term hint, store filtering, additive long-term seat, memoryRoot setting)')
rmSync(home, { recursive: true, force: true })
rmSync(customRoot, { recursive: true, force: true })

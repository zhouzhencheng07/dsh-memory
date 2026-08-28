// End-to-end checks for memory_search's execute() across the two-layer
// corpus (2026-08-28 revision): single `keywords` parameter + trim notices +
// the hard daily window + MIN_SCORE filtering + PURE RETRIEVAL (the old
// success hint is gone) + the CONFIGURABLE ADDITIVE long-term append seat.
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
seed(['memory'], 'memory.md', '# 用户环境\n\ndeltaunique 记录在长期记忆里，永不衰减、不受窗口限制。\n')

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
  const search = registered.find((t) => t.name === 'memory_search')
  assert.ok(search, 'memory_search registered')
  return search
}

/** Count result rows in formatted output (each row starts with `- [`). */
const rowCount = (out) => out.split('- [' ).length - 1

// --- default boot: searchLimit 5 ----------------------------------------------
const search = boot({ searchLimit: 5 })
assert.deepEqual(Object.keys(search.parameters).sort(), ['keywords'], 'single keywords parameter')
assert.equal(search.parameters.keywords.required, true)

// --- single-keyword basics ------------------------------------------------------
const rootPrefix = process.env.MEM_TEST_HOME.replaceAll('\\', '/') + '/dsh-memory/'
const out1 = await search.execute({ keywords: 'alphaunique' })
assert.match(out1, /今日流水/)
assert.ok(out1.includes(`${rootPrefix}${dayStamp(0)}/note.md#`), `hits must carry ABSOLUTE file paths, got:\n${out1}`)
assert.ok(out1.includes('file it via the memory tool into memory/<topic>.md'), 'daily-only hits end with the FILE-NEW promotion hint')
assert.ok(!out1.includes('authoritative'), 'file-new branch excludes the authoritative branch')

const outCap = await search.execute({ keywords: 'alphaunique extra1 extra2 extra3 extra4 extra5 extra6 extra7 extra8' })
assert.match(outCap, /^keywords capped to 7 \(dropped: extra7, extra8\)/)

await assert.rejects(() => search.execute({ keywords: '   ' }), /no usable keywords/)

// --- hard daily window (default 90) -------------------------------------------
const outOld = await search.execute({ keywords: 'gammaunique' })
assert.match(outOld, /^No memory found\.$/, '200-day-old diary is outside the 90-day window')
assert.ok(!outOld.includes('memory/<topic>'), 'empty results carry no promotion hint')

const outMid = await search.execute({ keywords: 'betaunique' })
assert.match(outMid, /十天前/, '10-day-old diary stays inside the window')

// --- long-term participation: first place is already long-term ------------------
const outLong = await search.execute({ keywords: 'deltaunique' })
assert.match(outLong, /memory\/memory\.md/)
assert.ok(outLong.includes('authoritative'), 'long-term block among hits ⇒ authoritative branch (2026-08-29)')
assert.ok(!outLong.includes('file it via the memory tool'), 'authoritative branch excludes the file-new branch')
assert.equal(rowCount(outLong), 1, 'long-term first place must NOT gain a duplicate append seat')

// --- MIN_SCORE floor: weak partial matches never surface ------------------------
seed([dayStamp(60)], 'low.md', '# 陈旧旁证\n\nzombietoken 出现在六十天前的日记里。\n')
seed([dayStamp(0)], 'anchor.md', '# 今日锚\n\nfreshanchor 在今天的日记里。\n')
const outWeak = await search.execute({ keywords: 'freshanchor p1 p2 zombietoken' })
assert.match(outWeak, /今日锚/, 'the strong primary hit still surfaces')
assert.ok(!outWeak.includes('陈旧旁证'), 'aged secondary-only noise is dropped by MIN_SCORE')

// --- store-level window semantics ----------------------------------------------
const { walkMemory } = await import('../src/store.js')
const rels = (win) => walkMemory(win).map((e) => e.rel).sort()
assert.ok(rels().some((r) => r.includes(dayStamp(200))), 'no window → everything indexed')
const w90 = rels(90)
assert.ok(w90.some((r) => r.startsWith('memory/')), 'the long-term file is never windowed')
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
seed(['memory'], 'memory-append.md', '# 追加测试\n\nreservetoken 出现在长期记忆里，永不衰减。\n')
const search2 = boot({ searchLimit: 2 })
const outAppend = await search2.execute({ keywords: 'reservetoken' })
assert.match(outAppend, /近水楼台/, 'best diary keeps slot 1')
assert.match(outAppend, /昨日流水/, 'second diary KEEPS slot 2 (additive, not evicting)')
assert.match(outAppend, /追加测试/, 'best-ranking long-term block appended after the regular results')
assert.equal(rowCount(outAppend), 3)
assert.ok(outAppend.includes('authoritative'), 'appended long-term seat flips the hint to the authoritative branch')

// off switch: pure top-N
const searchOff = boot({ searchLimit: 2, longtermAppend: false })
const outOff = await searchOff.execute({ keywords: 'reservetoken' })
assert.match(outOff, /近水楼台/)
assert.match(outOff, /昨日流水/)
assert.ok(!outOff.includes('追加测试'), 'longtermAppend:false disables the seat entirely')
assert.equal(rowCount(outOff), 2)

// limit 1: the seat now works additively where the old eviction could not
const search3 = boot({ searchLimit: 1 })
const outSolo = await search3.execute({ keywords: 'reservetoken' })
assert.match(outSolo, /近水楼台/, 'limit 1 keeps the top diary')
assert.match(outSolo, /追加测试/, 'limit 1 gains the appended long-term block')
assert.equal(rowCount(outSolo), 2)

console.log('execute-layer checks passed (params, notices, window, MIN_SCORE, composition-driven long-term hint, store filtering, additive long-term seat)')
rmSync(home, { recursive: true, force: true })

// End-to-end checks for memory_search's execute() across the two-layer
// corpus (2026-08-24): two-group parameters + trim notices + the hard daily
// window + retrieval-time long-term hints + the guaranteed long-term slot.
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

// --- default boot: searchLimit 5 ----------------------------------------------
const search = boot({ searchLimit: 5 })
assert.deepEqual(Object.keys(search.parameters).sort(), ['primary', 'secondary'])
assert.equal(search.parameters.primary.required, true)
assert.ok(!('required' in search.parameters.secondary), 'optional param must omit `required`')

// --- two-group basics ---------------------------------------------------------
const out1 = await search.execute({ primary: 'alphaunique', secondary: '' })
assert.match(out1, /今日流水/)
assert.ok(!out1.includes('Note:'), `fresh same-day diary must stay quiet, got:\n${out1}`)

const out2 = await search.execute({ primary: 'alphaunique extra1 extra2', secondary: '' })
assert.match(out2, /^primary capped to 2 keywords \(dropped: extra2\)/)

await assert.rejects(() => search.execute({ primary: '   ', secondary: '' }), /no usable keywords/)

// --- hard daily window (default 90) -------------------------------------------
const outOld = await search.execute({ primary: 'gammaunique', secondary: '' })
assert.match(outOld, /^No memory found\.$/, '200-day-old diary is outside the 90-day window')
assert.ok(!outOld.includes('最近'), 'no redundant window notice on empty results')

const outMid = await search.execute({ primary: 'betaunique', secondary: '' })
assert.match(outMid, /十天前/, '10-day-old diary stays inside the window')
assert.match(outMid, /add them to the matching topic block in memory\/memory\.md/, 'aged diary hit triggers the supplement hint')
assert.match(outMid, /old diaries get no maintenance/, 'old diaries are explicitly maintenance-free')

const outLong = await search.execute({ primary: 'deltaunique', secondary: '' })
assert.match(outLong, /memory\/memory\.md/)
assert.match(outLong, /results include long-term memory/, 'long-term participation triggers the correction-etiquette hint')
assert.match(outLong, /supplement missing lasting facts/, 'correction hint covers supplementing missing facts too')
assert.ok(!outLong.includes('add them to the matching topic block'), 'supplement hint suppressed when the long-term layer already answered')

// --- store-level window semantics ----------------------------------------------
const { walkMemory } = await import('../src/store.js')
const rels = (win) => walkMemory(win).map((e) => e.rel).sort()
assert.ok(rels().some((r) => r.includes(dayStamp(200))), 'no window → everything indexed')
const w90 = rels(90)
assert.ok(w90.some((r) => r.startsWith('memory/')), 'the long-term file is never windowed')
assert.ok(w90.some((r) => r.includes(dayStamp(10))), 'in-window diary indexed')
assert.ok(!w90.some((r) => r.includes(dayStamp(200))), 'out-of-window diary excluded')
assert.equal(walkMemory('nonsense').length, walkMemory(0).length, 'non-numeric window behaves as disabled')

// --- guaranteed long-term slot ---------------------------------------------------
// Query matching two fresh-ish diaries AND a deliberately heavyweight
// long-term block: with limit 2 both slots would be diaries, so the LAST slot
// must yield to the best-ranking memory/ block.
seed([dayStamp(0)], 'r-a.md', '# 近水楼台\n\nreservetoken 出现在今天的日记 A。\n')
seed([dayStamp(1)], 'r-b.md', '# 昨日流水\n\nreservetoken 出现在昨天的日记 B。\n')
seed(['memory'], 'memory-heavy-tmp.md', `# 保底测试\n\nreservetoken 出现在长期记忆里。${'填充'.repeat(1500)}\n`)
const search2 = boot({ searchLimit: 2 })
const outSwap = await search2.execute({ primary: 'reservetoken', secondary: '' })
assert.match(outSwap, /近水楼台/, 'best diary keeps slot 1')
assert.match(outSwap, /memory\/memory\.md/, 'heavyweight long-term block takes the reserved last slot')
assert.ok(!outSwap.includes('昨日流水'), 'the outranked diary was evicted from slot 2')
assert.match(outSwap, /results include long-term memory/, 'reserved hit still triggers the etiquette hint')

// limit 1: never evict a sole result
const search3 = boot({ searchLimit: 1 })
const outSolo = await search3.execute({ primary: 'reservetoken', secondary: '' })
assert.match(outSolo, /近水楼台/, 'limit 1 keeps the top diary')
assert.ok(!outSolo.includes('memory-heavy-tmp'), 'no eviction when the window has a single slot')

console.log('execute-layer checks passed (params, notices, window, hints, store filtering, long-term reservation)')
rmSync(home, { recursive: true, force: true })

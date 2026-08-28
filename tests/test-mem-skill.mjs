// agent-memory skill (skill/agent-memory) verification:
//   1. skill/agent-memory/search.js is a byte-identical mirror of the
//      plugin's src/search.js — the skill must rank exactly like the plugin;
//   2. mem.mjs CLI roundtrip against a temp AGENT_MEMORY_HOME-style root:
//      read/write/edit + hash-CAS refusals, topic validation and targeting,
//      search with absolute paths, the long-term append seat, the 45-day
//      diary window, and the composition-driven hint branches.
// No @deepseek-ai imports live under skill/, so no stub loader is needed.
// Usage: node tests/test-mem-skill.mjs
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, sessionSlug, todayStamp } from '../skill/agent-memory/mem.mjs'

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    console.error(`FAIL ${label}\n    ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}

const HERE = join(fileURLToPath(import.meta.url), '..')

// --- 1. search.js mirror -----------------------------------------------------
await check('skill/agent-memory/search.js is a byte-identical mirror of src/search.js', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'search.js'))
  const mirror = readFileSync(join(HERE, '..', 'skill', 'agent-memory', 'search.js'))
  assert.ok(src.equals(mirror), 'mirror diverged — re-copy src/search.js into skill/agent-memory/')
})

// --- scaffolding ---------------------------------------------------------------
delete process.env.AGENT_MEMORY_HOME

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'mem-skill-'))
}

function seedDiary(home, daysAgo, slug, text) {
  const d = new Date(Date.now() - daysAgo * 86400000)
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = join(home, stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.md`), text, 'utf8')
}

function seedTopic(home, name, text) {
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', `${name}.md`), text, 'utf8')
}

const DIARY_TEXT = '# pnpm profile\n\nThe dsh plugin profile lives under profiles/web/node_modules; sync with robocopy before restarting.\n'
const TOPIC_TEXT = '# windows-env\n\nDSH_HOME defaults to the production root; always inline-set the env var before profile operations.\n'

// --- 2. home resolution ----------------------------------------------------------
await check('no home configured → instructive refusal, no default library', async () => {
  await assert.rejects(() => run(['search', '--keywords', 'x']), /AGENT_MEMORY_HOME|--home/)
})

await check('--help returns usage without requiring a home', async () => {
  const out = await run(['--help'])
  assert.match(out, /Usage:/)
})

await check('todayStamp/sessionSlug parity with the plugin layout', () => {
  assert.match(todayStamp(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(sessionSlug('D:/Project/x'), '--D-Project-x--')
  assert.equal(sessionSlug('D:\\Project\\x'), '--D-Project-x--')
  assert.equal(sessionSlug(''), '--general--')
})

// --- 3. read/write/edit + hash CAS -------------------------------------------------
await check('read absent daily note → ABSENT + topics hint, zero writes', async () => {
  const home = tempHome()
  try {
    const out = await run(['read', '--slug', 'absent-c', '--home', home])
    assert.match(out, /^ABSENT /)
    assert.match(out, /Long-term topic files live under memory\/<topic>\.md/)
    assert.ok(!existsSync(join(home, todayStamp())))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('write creates; hash footer; disk content matches stdin', async () => {
  const home = tempHome()
  try {
    const out = await run(['write', '--slug', 'w1', '--home', home], DIARY_TEXT)
    assert.match(out, /created \(\d+ bytes\)/)
    const hash = out.match(/\[hash: ([0-9a-f]{12})\]/)?.[1]
    assert.ok(hash, 'mutation output carries the new hash')
    assert.equal(readFileSync(join(home, todayStamp(), '--w1--.md'), 'utf8'), DIARY_TEXT)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('write on existing file: refused without hash, refused stale, accepted fresh', async () => {
  const home = tempHome()
  try {
    await run(['write', '--slug', 'w2', '--home', home], DIARY_TEXT)
    await assert.rejects(() => run(['write', '--slug', 'w2', '--home', home], 'x'), /already exists.*--expect-hash/)
    await assert.rejects(
      () => run(['write', '--slug', 'w2', '--expect-hash', 'deadbeefdead', '--home', home], 'x'),
      /changed since it was read/,
    )
    const read = await run(['read', '--slug', 'w2', '--home', home])
    const hash = read.match(/--expect-hash ([0-9a-f]{12})/)[1]
    const out = await run(['write', '--slug', 'w2', '--expect-hash', hash, '--home', home], TOPIC_TEXT)
    assert.match(out, /replaced/)
    assert.equal(readFileSync(join(home, todayStamp(), '--w2--.md'), 'utf8'), TOPIC_TEXT)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('edit: hash CAS chain, not-found and non-unique refusals, chained hash', async () => {
  const home = tempHome()
  try {
    await run(['write', '--slug', 'e1', '--home', home], DIARY_TEXT)
    await assert.rejects(
      () => run(['edit', '--slug', 'e1', '--home', home], JSON.stringify({ old: 'pnpm' })),
      /never read this session.*--expect-hash/,
    )
    await assert.rejects(
      () => run(['edit', '--slug', 'e1', '--expect-hash', 'deadbeefdead', '--home', home], JSON.stringify({ old: 'pnpm', new: 'npm' })),
      /changed since it was read/,
    )
    const read = await run(['read', '--slug', 'e1', '--home', home])
    const hash = read.match(/--expect-hash ([0-9a-f]{12})/)[1]
    await assert.rejects(
      () => run(['edit', '--slug', 'e1', '--expect-hash', hash, '--home', home], JSON.stringify({ old: 'does-not-exist', new: 'x' })),
      /not found/,
    )
    await assert.rejects(
      () => run(['edit', '--slug', 'e1', '--expect-hash', hash, '--home', home], JSON.stringify({ old: 'profile', new: 'x' })),
      /must be unique, or pass "replace_all":true/,
    )
    const first = await run(
      ['edit', '--slug', 'e1', '--expect-hash', hash, '--home', home],
      JSON.stringify({ old: 'robocopy', new: 'ROBOCOPY' }),
    )
    const hash2 = first.match(/\[hash: ([0-9a-f]{12})\]/)[1]
    assert.match(first, /edited \(1 occurrence replaced\)/)
    // chained edit with the printed hash — no re-read needed (mirrors the
    // plugin updating its observation after a successful write)
    const second = await run(
      ['edit', '--slug', 'e1', '--expect-hash', hash2, '--home', home],
      JSON.stringify({ old: 'The dsh', new: 'The DSH', replace_all: true }),
    )
    assert.match(second, /edited \(1 occurrence replaced\)/)
    const text = readFileSync(join(home, todayStamp(), '--e1--.md'), 'utf8')
    assert.match(text, /ROBOCOPY before restarting/)
    assert.match(text, /The DSH plugin profile/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('empty stdin write is refused; oversized content hits the 1 MB cap', async () => {
  const home = tempHome()
  try {
    await assert.rejects(() => run(['write', '--slug', 'cap', '--home', home], ''), /nothing on stdin/)
    await assert.rejects(() => run(['write', '--slug', 'cap', '--home', home], 'x'.repeat(1024 * 1024 + 1)), /byte cap/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- 4. topic targeting -----------------------------------------------------------
await check('topic targeting: create/read/ABSENT + path traversal refused', async () => {
  const home = tempHome()
  try {
    await assert.rejects(() => run(['write', '--topic', '../evil', '--home', home], 'x'), /invalid topic/)
    await assert.rejects(() => run(['write', '--topic', 'a/b', '--home', home], 'x'), /invalid topic/)
    const absent = await run(['read', '--topic', 'windows-env', '--home', home])
    assert.match(absent, /^ABSENT /)
    assert.ok(!/Existing long-term topics/.test(absent), 'topic-scoped ABSENT does not list topics')
    await run(['write', '--topic', 'windows-env', '--home', home], TOPIC_TEXT)
    assert.equal(readFileSync(join(home, 'memory', 'windows-env.md'), 'utf8'), TOPIC_TEXT)
    const read = await run(['read', '--topic', 'windows-env', '--home', home])
    assert.match(read, /windows-env\.md/)
    assert.match(read, /--expect-hash [0-9a-f]{12}/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// --- 5. search: paths, seat, window, hints ------------------------------------------
const SLUG_A = '--C--proj-a--'
const SLUG_B = '--C--proj-b--'

await check('search returns whole blocks with absolute paths + breadcrumb', async () => {
  const home = tempHome()
  try {
    seedDiary(home, 1, SLUG_A, DIARY_TEXT)
    const out = await run(['search', '--keywords', 'pnpm profile', '--home', home])
    assert.match(out, /#pnpm profile \(score /)
    // displayPath is forward-slashed: <home>/<yesterday>/<slug>.md#pnpm profile
    assert.ok(out.includes(`${home.replaceAll('\\', '/')}/`), `absolute path in output:\n${out}`)
    assert.ok(out.includes(`/${SLUG_A}.md#pnpm profile`), `rel with breadcrumb in output:\n${out}`)
    assert.match(out, /profiles\/web\/node_modules/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('long-term seat + composition hints: the seat APPENDS and flips the branch', async () => {
  const home = tempHome()
  try {
    seedDiary(home, 1, SLUG_A, DIARY_TEXT)
    // no topic file yet → no long-term block anywhere → file-new hint
    const fresh = await run(['search', '--keywords', 'pnpm profile', '--home', home])
    assert.match(fresh, /proved worth keeping long term, file it into memory\/<topic>\.md/)
    assert.ok(!/windows-env/.test(fresh))
    seedTopic(home, 'windows-env', TOPIC_TEXT)
    // the long-term block misses the regular cut but rides the append seat —
    // and a seated long-term block FLIPS the hint branch (plugin parity)
    const seated = await run(['search', '--keywords', 'pnpm profile', '--home', home])
    assert.ok(seated.includes('windows-env'), 'seated long-term block is appended')
    assert.match(seated, /authoritative \(never windowed\)/)
    assert.ok(!/proved worth keeping long term, file it into/.test(seated), 'hint branches are exclusive')
    // long-term block making the regular cut: same authoritative branch
    const regular = await run(['search', '--keywords', 'dsh_home production', '--home', home])
    assert.match(regular, /windows-env/)
    assert.match(regular, /authoritative \(never windowed\)/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('45-day diary window: aged-out diaries leave the corpus, topic files never do', async () => {
  const home = tempHome()
  try {
    seedDiary(home, 60, SLUG_B, DIARY_TEXT)
    seedTopic(home, 'windows-env', TOPIC_TEXT)
    const out = await run(['search', '--keywords', 'pnpm profile', '--home', home])
    assert.match(out, /windows-env/)
    assert.ok(!/pnpm profile \(score/.test(out), 'aged diary block is gone; only the long-term seat remains')
    const withWindow = await run(['search', '--keywords', 'pnpm profile', '--days', '0', '--home', home])
    assert.match(withWindow, /pnpm profile \(score/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('empty results: no hint attached', async () => {
  const home = tempHome()
  try {
    const out = await run(['search', '--keywords', 'nothing-matches-this', '--home', home])
    assert.equal(out, 'No memory found.')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('keyword overflow is reported in a notice line', async () => {
  const home = tempHome()
  try {
    seedDiary(home, 0, SLUG_A, DIARY_TEXT)
    const out = await run(['search', '--keywords', 'a b c d e f g h i', '--home', home])
    assert.match(out, /^keywords capped to 7/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`)

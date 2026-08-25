// Positional keyword scoring verification for memory_search (2026-08-25):
//   ONE `keywords` string parsed by parseKeywords() — the FIRST 3 terms score
//   PRIMARY_WEIGHT per hit, the next 4 SECONDARY_WEIGHT — partial credit per
//   matched keyword, no hard AND gate; blocks scoring below MIN_SCORE never
//   return. Replaces the 2026-08-24 explicit two-parameter groups.
// search.js is dependency-free, so no stub loader is needed.
// Usage: node tests/test-memory-search.mjs
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  searchMemory,
  parseKeywords,
  looseNormalize,
  MAX_PRIMARY_KEYWORDS,
  MAX_SECONDARY_KEYWORDS,
  PRIMARY_WEIGHT,
  SECONDARY_WEIGHT,
  MIN_SCORE,
} from '../src/search.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`ok   ${label}`)
}

const DAY = '2026-08-24'
const entry = (rel, text, day = DAY) => ({ rel: `${day}/${rel}`, date: day, kind: 'note', text })
/** Long-term layer: unparseable date → recencyWeight 1 (no decay), deterministic. */
const ltEntry = (text) => ({ rel: 'memory/memory.md', date: '', kind: 'note', text })
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// --- looseNormalize --------------------------------------------------------
check('looseNormalize strips markdown decoration, keeps identifiers', () => {
  assert.equal(looseNormalize('dsh-memory `0.2.2`'), 'dsh-memory 0.2.2')
  assert.equal(looseNormalize('**待修 bug**：`appendd`'), '待修 bug：appendd')
  assert.equal(looseNormalize('A\t\nB   C'), 'a b c')
})

// --- parseKeywords ----------------------------------------------------------
check('parseKeywords caps positionally at 3+4 and reports drops', () => {
  assert.equal(MAX_PRIMARY_KEYWORDS, 3)
  assert.equal(MAX_SECONDARY_KEYWORDS, 4)
  const kw = parseKeywords('a b c d e f g h i')
  assert.deepEqual(kw.primary, ['a', 'b', 'c'])
  assert.deepEqual(kw.secondary, ['d', 'e', 'f', 'g'])
  assert.equal(kw.notices.length, 1)
  assert.match(kw.notices[0], /keywords capped to 7.*dropped: h, i/)
})

check('parseKeywords dedupes at the first occurrence', () => {
  const kw = parseKeywords('limit limit settings')
  assert.deepEqual(kw.primary, ['limit', 'settings'])
  assert.deepEqual(kw.secondary, [])
  assert.deepEqual(kw.notices, [])
})

// --- partial credit: the fix for the measured AND-gate miss ----------------
// Regression shaped after the 2026-08-24 diagnosis: the note says
// 「HKCU\Environment」「冗余覆盖变量」 but never the literal query word
// 「环境变量」, so the old whole-string/AND paths scored it zero.
const corpus = [
  entry('a.md', '# 环境\n\n检查 HKCU\\Environment 的冗余覆盖变量，CUDA_HOME 指向旧路径；备份注册表后再改名。'),
]

check('partial credit: block missing the essential words still surfaces via context terms', () => {
  const hits = searchMemory(corpus, ['nvidia', '环境变量'], ['注册表', '备份', 'hkcu'], 10)
  assert.equal(hits.length, 1, 'the block must NOT vanish when primaries are absent')
  assert.match(hits[0].rel, /a\.md/)
})

check('no match at all stays empty; empty keyword lists match nothing', () => {
  assert.deepEqual(searchMemory(corpus, ['zzz-not-present'], []), [])
  assert.deepEqual(searchMemory(corpus, [], [], 5), [])
})

// --- positional weights ------------------------------------------------------
check('primary hit weighs PRIMARY_WEIGHT× an identical secondary hit', () => {
  // long-term entry (no decay): a lone secondary hit lands exactly on the
  // MIN_SCORE floor and survives, so both sides of the ratio are observable
  const one = [ltEntry('# 同文\n\nalpha beta')]
  const asPrimary = searchMemory(one, ['alpha'], [], 5)[0].score
  const asSecondary = searchMemory(one, [], ['alpha'], 5)[0].score
  assert.ok(Math.abs(asPrimary / asSecondary - PRIMARY_WEIGHT / SECONDARY_WEIGHT) < 1e-9,
    `${asPrimary} vs ${asSecondary}`)
})

check('two primary hits outrank three secondary hits on equal blocks', () => {
  const entries = [
    entry('p.md', '# 主证\n\n环境变量 备份'),
    entry('s.md', '# 旁证\n\n注册表 hkcu cuda'),
  ]
  const hits = searchMemory(entries, ['环境变量', '备份'], ['注册表', 'hkcu', 'cuda'], 10)
  assert.match(hits[0].rel, /p\.md/, 'primary-pair block must rank first')
  assert.ok(hits.length === 2, 'the all-secondary block still surfaces (partial recall)')
})

// --- tolerance & counting ---------------------------------------------------
check('backticked note text reached by bare keywords (the original 0.2.2 case)', () => {
  const entries = [entry('c.md', '# 反引号\n\n受影响版本：dsh-memory `0.2.2`（已核实）')]
  const hits = searchMemory(entries, ['dsh-memory', '0.2.2'], [], 10)
  assert.equal(hits.length, 1)
  assert.match(hits[0].rel, /反引号/)
})

check('repeated occurrences add more score (length-damped)', () => {
  const short = [entry('once.md', '# 一\n\n阈值 阈值 阈值 填充词填充词填充词填充词')]
  const hitsOnce = searchMemory(short, ['阈值'], [], 5)[0].score
  const sparse = [entry('once.md', '# 一\n\n阈值 填充词填充词填充词填充词填充词填充词')]
  const hitsSparse = searchMemory(sparse, ['阈值'], [], 5)[0].score
  assert.ok(hitsOnce > hitsSparse, `${hitsOnce} should beat ${hitsSparse}`)
})

// --- MIN_SCORE floor (2026-08-25) -------------------------------------------
check(`MIN_SCORE keeps an exactly-at-floor long-term secondary-only hit (${MIN_SCORE})`, () => {
  // no decay on the undated long-term layer: 1 hit ÷ 2 (length damping on a
  // single-block corpus) = 0.5 exactly → `>= floor` keeps it
  const hits = searchMemory([ltEntry('# 用户环境\n\n阈值')], [], ['阈值'], 5)
  assert.equal(hits.length, 1)
})

check('MIN_SCORE drops a dated-diary secondary-only hit (decay puts it under the floor)', () => {
  // 30 days old → decay 0.5 → 1 ÷ 2 × 0.5 = 0.25 < 0.5
  assert.deepEqual(searchMemory([entry('s.md', '# 旁\n\n阈值', daysAgo(30))], [], ['阈值'], 5), [])
})

check('MIN_SCORE keeps a primary hit even at the recency floor', () => {
  // 365 days old → decay floored at 0.4 → 3 ÷ 2 × 0.4 = 0.6 ≥ 0.5
  const hits = searchMemory([entry('a.md', '# 远\n\n阈值', daysAgo(365))], ['阈值'], [], 5)
  assert.equal(hits.length, 1)
})

// --- real-corpus acceptance: the exact query that missed on 2026-08-22 -------
check('REAL corpus: positional-keyword query still surfaces the appendd fix-record block', () => {
  const dir = join('D:', '\\agent\\.dsh\\dsh-memory', '2026-08-22')
  const entries = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) =>
    entry(f, readFileSync(join(dir, f), 'utf8'), '2026-08-22'),
  )
  const kw = parseKeywords('dsh-memory 0.2.2 appendd')
  assert.deepEqual(kw.notices, [])
  assert.deepEqual(kw.primary, ['dsh-memory', '0.2.2', 'appendd'])
  assert.deepEqual(kw.secondary, [])
  const hits = searchMemory(entries, kw.primary, kw.secondary, 10)
  const target = hits.find((h) => h.rel.includes('待修 bug'))
  assert.ok(target, `expected the 待修 bug block in top hits, got:\n${hits.map((h) => h.rel).join('\n')}`)
  console.log(`     → ranked #${hits.indexOf(target) + 1}, score ${target.score}`)
})

console.log(`\n${passed} checks passed`)

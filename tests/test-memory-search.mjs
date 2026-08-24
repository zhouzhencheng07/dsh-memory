// Two-group keyword scoring verification for memory_search (2026-08-24):
//   `primary` (max 2 keywords) scores PRIMARY_WEIGHT per hit, `secondary`
//   (max 3) scores SECONDARY_WEIGHT — partial credit per matched keyword,
//   no hard AND gate. Replaces the 2026-08-22 tier scheme whose tier-3
//   zero-partial-credit was the measured root cause of misses.
// search.js is dependency-free, so no stub loader is needed.
// Usage: node tests/test-memory-search.mjs
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  searchMemory,
  parseKeywordGroups,
  looseNormalize,
  MAX_PRIMARY_KEYWORDS,
  MAX_SECONDARY_KEYWORDS,
  PRIMARY_WEIGHT,
  SECONDARY_WEIGHT,
} from '../src/search.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`ok   ${label}`)
}

const DAY = '2026-08-24'
const entry = (rel, text, day = DAY) => ({ rel: `${day}/${rel}`, date: day, kind: 'note', text })

// --- looseNormalize --------------------------------------------------------
check('looseNormalize strips markdown decoration, keeps identifiers', () => {
  assert.equal(looseNormalize('dsh-memory `0.2.2`'), 'dsh-memory 0.2.2')
  assert.equal(looseNormalize('**待修 bug**：`appendd`'), '待修 bug：appendd')
  assert.equal(looseNormalize('A\t\nB   C'), 'a b c')
})

// --- parseKeywordGroups ----------------------------------------------------
check('parseKeywordGroups caps primary to 2 / secondary to 3 and reports drops', () => {
  const kw = parseKeywordGroups('a b c d', 'e f g h')
  assert.equal(MAX_PRIMARY_KEYWORDS, 2)
  assert.equal(MAX_SECONDARY_KEYWORDS, 3)
  assert.deepEqual(kw.primary, ['a', 'b'])
  assert.deepEqual(kw.secondary, ['e', 'f', 'g'])
  assert.equal(kw.notices.length, 2)
  assert.match(kw.notices[0], /primary capped to 2.*dropped: c, d/)
  assert.match(kw.notices[1], /secondary capped to 3.*dropped: h/)
})

check('parseKeywordGroups dedupes across groups at the highest weight', () => {
  const kw = parseKeywordGroups('Limit limit', 'limit settings')
  assert.deepEqual(kw.primary, ['limit'])
  assert.deepEqual(kw.secondary, ['settings'])
})

// --- partial credit: the fix for the measured AND-gate miss ----------------
// Regression shaped after the 2026-08-24 diagnosis: the note says
// 「HKCU\Environment」「冗余覆盖变量」 but never the literal query word
// 「环境变量」, so the old whole-string/AND paths scored it zero.
const corpus = [
  entry('a.md', '# 环境\n\n检查 HKCU\\Environment 的冗余覆盖变量，CUDA_HOME 指向旧路径；备份注册表后再改名。'),
]

check('partial credit: block missing the primary words still surfaces via secondaries', () => {
  const hits = searchMemory(corpus, ['nvidia', '环境变量'], ['注册表', '备份', 'hkcu'], 10)
  assert.equal(hits.length, 1, 'the block must NOT vanish when primaries are absent')
  assert.match(hits[0].rel, /a\.md/)
})

check('no match at all stays empty; empty keyword lists match nothing', () => {
  assert.deepEqual(searchMemory(corpus, ['zzz-not-present'], []), [])
  assert.deepEqual(searchMemory(corpus, [], [], 5), [])
})

// --- group weights ----------------------------------------------------------
check('primary hit weighs PRIMARY_WEIGHT× an identical secondary hit', () => {
  const one = [entry('t.md', '# 同文\n\nalpha beta')]
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

// --- real-corpus acceptance: the exact query that missed on 2026-08-22 ------
check('REAL corpus: two-group query still surfaces the appendd fix-record block', () => {
  const dir = join('D:', '\\agent\\.dsh\\dsh-memory', '2026-08-22')
  const entries = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) =>
    entry(f, readFileSync(join(dir, f), 'utf8'), '2026-08-22'),
  )
  const kw = parseKeywordGroups('dsh-memory 0.2.2', 'appendd')
  assert.deepEqual(kw.notices, [])
  const hits = searchMemory(entries, kw.primary, kw.secondary, 10)
  const target = hits.find((h) => h.rel.includes('待修 bug'))
  assert.ok(target, `expected the 待修 bug block in top hits, got:\n${hits.map((h) => h.rel).join('\n')}`)
  console.log(`     → ranked #${hits.indexOf(target) + 1}, score ${target.score}`)
})

console.log(`\n${passed} checks passed`)

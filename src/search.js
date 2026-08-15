// dsh-memory — memory search.
//
// Deliberately NOT FTS5: the FTS5 unicode61 tokenizer does not segment
// Chinese text (a whole CJK run is one token), which makes Chinese keyword
// search useless. The memory corpus is small (dozens of small markdown
// files), so a case-insensitive literal substring scan is fast and
// language-agnostic — the approach proven in dsh-memory-evolve and
// validated in the dsh-memory dynamic prototype.

/** Max chars of a returned snippet (hit-centered window). */
export const SNIPPET_CHARS = 200
/** Rank boost for digest (Dream) hits: digested knowledge ranks above raw notes. */
export const DIGEST_BOOST = 3
/** RRF constant: the standard k=60 keeps rank scores on a comparable scale. */
export const RRF_K = 60

/** Case-insensitive normalization (Chinese passes through unchanged). */
export function normalize(value) {
  return String(value).toLocaleLowerCase()
}

/** Non-overlapping count of `needle` occurrences in `value` (case-insensitive). */
export function occurrenceCount(value, needle) {
  const haystack = normalize(value)
  const n = normalize(needle)
  if (n.length === 0 || n.length > haystack.length) return 0
  let count = 0
  let offset = 0
  while (offset <= haystack.length - n.length) {
    const found = haystack.indexOf(n, offset)
    if (found < 0) break
    count += 1
    offset = found + Math.max(1, n.length)
  }
  return count
}

/** Hit-centered snippet with ellipsis bounds. */
export function snippet(value, query) {
  const text = String(value)
  if (text.length <= SNIPPET_CHARS) return text
  const match = normalize(text).indexOf(normalize(query))
  if (match < 0) return `${text.slice(0, SNIPPET_CHARS)}…`
  const before = Math.floor((SNIPPET_CHARS - query.length) / 2)
  const start = Math.max(0, Math.min(match - before, text.length - SNIPPET_CHARS))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * Search memory entries for a query. Digest hits get a rank boost; ties
 * break by date (newer first), then by path.
 * @param {Array<{rel: string, date: string, kind: string, text: string}>} entries
 * @param {string} query - non-empty search text
 * @param {number} [limit=5]
 * @returns {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>}
 */
export function searchMemory(entries, query, limit = 5) {
  const hits = []
  for (const entry of entries) {
    const raw = occurrenceCount(entry.text, query)
    if (raw === 0) continue
    const score = entry.kind === 'digest' ? raw * DIGEST_BOOST : raw
    hits.push({
      rel: entry.rel,
      date: entry.date,
      kind: entry.kind,
      score,
      snippet: snippet(entry.text, query),
    })
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.date !== a.date) return b.date < a.date ? -1 : 1
    return a.rel.localeCompare(b.rel)
  })
  return hits.slice(0, limit)
}

/** Render search hits for the model. */
export function formatHits(hits) {
  if (hits.length === 0) return 'No memory found.'
  const lines = []
  for (const hit of hits) {
    const tag = hit.kind === 'digest' ? 'digest' : hit.date || 'index'
    lines.push(`- [${tag}] ${hit.rel} (score ${hit.score})`)
    lines.push(`  ${hit.snippet.replace(/\s+/g, ' ')}`)
  }
  return lines.join('\n')
}

/**
 * Reciprocal-rank fusion of two PRE-SORTED hit lists (descending by each
 * list's own score). Absolute scores are ignored — only ranks matter — so
 * substring occurrence counts and cosine similarities fuse on a comparable
 * scale. A rel seen in both lists keeps its first occurrence (substring
 * hits are added first and are more precise).
 * @param {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>} listA
 * @param {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>} listB
 * @param {number} [limit=5]
 * @returns {Array} fused hits, ranked
 */
export function fuseHits(listA, listB, limit = 5) {
  const rank = new Map() // rel -> RRF score
  const byRel = new Map() // rel -> hit (first occurrence wins)
  const add = (list) => {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i]
      if (!byRel.has(hit.rel)) byRel.set(hit.rel, hit)
      rank.set(hit.rel, (rank.get(hit.rel) ?? 0) + 1 / (RRF_K + i + 1))
    }
  }
  add(listA)
  add(listB)
  const out = [...byRel.values()]
  out.sort((a, b) => {
    const d = rank.get(b.rel) - rank.get(a.rel)
    if (d !== 0) return d
    if (b.date !== a.date) return b.date < a.date ? -1 : 1
    return a.rel.localeCompare(b.rel)
  })
  return out.slice(0, limit)
}

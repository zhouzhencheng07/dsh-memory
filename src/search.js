// dsh-memory — memory search.
//
// Deliberately NOT FTS5: the FTS5 unicode61 tokenizer does not segment
// Chinese text (a whole CJK run is one token), which makes Chinese keyword
// search useless. The memory corpus is small (dozens of small markdown
// files), so a case-insensitive literal substring scan is fast and
// language-agnostic — the approach proven in dsh-memory-evolve and
// validated in the dsh-memory dynamic prototype.
//
// BLOCK-LEVEL retrieval (user decision 2026-08-17): hits are heading-aware
// markdown blocks with ancestor breadcrumbs (`rel#主题 > 小节`), and the
// returned snippet is the WHOLE block (progressive disclosure: continue from
// the result; only read the source file when the block itself is oversized
// or more context is needed). One file may legitimately contribute several
// matching blocks; dedup is at the BLOCK level (the same block never
// appears twice), not the file level.
//
// RECENCY DECAY (user decision 2026-08-18): every note carries its date in
// the rel (YYYY-MM-DD/...); ranking multiplies each block's score by a
// decay weight that falls with age but STOPS at a floor — an old but
// genuinely relevant block stays reachable (it is not silently truncated),
// while a newer note on the same topic outranks it unless the old one is
// much stronger. The digest/dream layer is gone; recency guidance + decay
// replace its convergence job.
//
// TWO-GROUP KEYWORD SCORING (user decision 2026-08-24): the caller gives
// keywords in TWO groups with different score weights — `primary` (max 2,
// the essential terms, ×PRIMARY_WEIGHT each) and `secondary` (max 3,
// refining/context terms, ×SECONDARY_WEIGHT each). Every keyword that
// literally appears in a block (formatting-tolerant via looseNormalize)
// contributes its weighted occurrence count — PARTIAL credit, no hard AND
// gate. This replaces the old tier-1/2/3 scheme (whole-phrase ×1.0 →
// tolerant ×0.95 → multi-keyword AND ×0.7): the measured root cause of
// misses (2026-08-24 diagnosis) was tier 3's zero partial credit — a block
// containing some but not all query words scored nothing and vanished from
// the keyword list. Counts are damped by block length (BM25-style), then
// multiplied by the note's recency decay weight.

/** Cap on group-1 (`primary`) keywords: the essential terms. */
export const MAX_PRIMARY_KEYWORDS = 2
/** Cap on group-2 (`secondary`) keywords: refining/context terms. */
export const MAX_SECONDARY_KEYWORDS = 3
/** Per-keyword score bonus for a primary-group hit (high). */
export const PRIMARY_WEIGHT = 3
/** Per-keyword score bonus for a secondary-group hit (low). */
export const SECONDARY_WEIGHT = 1

/** Max chars of a returned snippet window (oversized-block fallback). */
export const SNIPPET_CHARS = 200
/** Blocks up to this many chars are returned WHOLE as the snippet. */
export const SNIPPET_FULL = 1000
/** RRF constant: the standard k=60 keeps rank scores on a comparable scale. */
export const RRF_K = 60
/** Recency half-life in days: a note halves its weight every this many days. */
export const RECENCY_HALF_LIFE_DAYS = 30
/** Recency floor: an old note's weight never falls below this (0 < floor < 1). */
export const RECENCY_FLOOR = 0.4

/** Case-insensitive normalization (Chinese passes through unchanged). */
export function normalize(value) {
  return String(value).toLocaleLowerCase()
}

/**
 * Formatting-stripped view used by tolerant keyword matching (tier 2/3,
 * 2026-08-22): markdown decoration (backticks, quotes, bold/emphasis marks,
 * strikethrough) is removed and whitespace runs collapse, so a query like
 * `dsh-memory 0.2.2` reaches a note written as ``dsh-memory `0.2.2` `` — the
 * miss that motivated this. Applied symmetrically to haystack and needle;
 * identifier characters (`-` `_` `.`) survive untouched, so `dsh-memory`,
 * `0.2.2`, `snake_case` stay whole.
 * @param {string} value
 * @returns {string}
 */
export function looseNormalize(value) {
  return normalize(value)
    .replace(/[`'"“”‘’*~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Recency decay weight for a note date (YYYY-MM-DD): 1.0 for today, halving
 * every RECENCY_HALF_LIFE_DAYS, and NEVER below RECENCY_FLOOR — an old but
 * strongly relevant block keeps competing instead of being truncated away.
 * Unparseable/missing dates get weight 1 (no decay).
 * @param {string} date - YYYY-MM-DD (note rel's date component)
 * @returns {number} weight in [RECENCY_FLOOR, 1]
 */
export function recencyWeight(date) {
  const ms = Date.parse(String(date ?? ''))
  if (!Number.isFinite(ms)) return 1
  const days = Math.max(0, (Date.now() - ms) / 86400000)
  const w = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS)
  return Math.max(RECENCY_FLOOR, w)
}

/**
 * Parse the two keyword groups for memory_search: whitespace-split,
 * looseNormalize'd, deduped (a token counts once, at its highest group —
 * primary wins), and capped to MAX_PRIMARY_KEYWORDS / MAX_SECONDARY_KEYWORDS.
 * Keywords dropped by the caps are reported in `notices` so the tool output
 * can tell the calling model its input was trimmed.
 * @param {string} primaryInput - raw `primary` argument (max 2 keywords)
 * @param {string} secondaryInput - raw `secondary` argument (max 3 keywords)
 * @returns {{primary: string[], secondary: string[], notices: string[]}}
 */
export function parseKeywordGroups(primaryInput, secondaryInput) {
  const notices = []
  const seen = new Set() // cross-group dedupe, first occurrence (primary) wins
  const take = (input, cap, label) => {
    const kept = []
    const dropped = []
    for (const raw of String(input ?? '').split(/\s+/).filter(Boolean)) {
      const word = looseNormalize(raw)
      if (!word || seen.has(word)) continue
      if (kept.length >= cap) {
        dropped.push(raw)
        continue
      }
      seen.add(word)
      kept.push(word)
    }
    if (dropped.length > 0) notices.push(`${label} capped to ${cap} keywords (dropped: ${dropped.join(', ')})`)
    return kept
  }
  const primary = take(primaryInput, MAX_PRIMARY_KEYWORDS, 'primary')
  const secondary = take(secondaryInput, MAX_SECONDARY_KEYWORDS, 'secondary')
  return { primary, secondary, notices }
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

/**
 * Split a memory file into heading-aware blocks with ancestor breadcrumbs
 * (QwenPaw/ReMe markdown-chunker style, user decision 2026-08-17):
 * - ANY heading level (`#`–`######`) starts a new block: a `###` 子节 is
 *   its OWN block whose breadcrumb nests under the nearest `##` (title
 *   `主题 > 小节 > 子节`), exactly like ReMe's heading-tree chunks; a `#`
 *   topic with no deeper headings stays one block;
 * - each block's title is its heading breadcrumb (`父 > 子 > 孙`) and its
 *   text starts with the breadcrumb heading lines, so a block is
 *   self-contained (a `###` 子节 knows its `##` 小节 and `#` 主题);
 * - content before the first heading becomes a block with an empty title;
 * - this is the SINGLE block definition shared with the vector index
 *   (embed.js), keeping the substring and vector paths symmetric
 *   (both yield `rel#breadcrumb` hits that dedup exactly).
 * @param {string} text
 * @returns {Array<{title: string, text: string}>}
 */
export function splitBlocks(text) {
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  const stack = [] // { level, heading } — open heading ancestors
  let current = null
  const flush = () => {
    if (current !== null && current.text.trim()) blocks.push(current)
  }
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      const heading = m[2].trim()
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, heading })
      current = {
        title: stack.map((h) => h.heading).join(' > '),
        text: stack.map((h) => `${'#'.repeat(h.level)} ${h.heading}`).join('\n'),
      }
    } else {
      if (current === null) current = { title: '', text: '' }
      current.text += (current.text ? '\n' : '') + line
    }
  }
  flush()
  return blocks
}

/** True when a block carries only heading lines (no body signal). */
function isTitleOnly(text) {
  return !String(text ?? '').replace(/^(?:#{1,6}\s[^\n]*\n?)+/, '').trim()
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
 * Progressive-disclosure snippet (user decision 2026-08-17): return the WHOLE
 * block text when it fits (blocks are `##`-level units, typically 150-1000
 * chars), so the agent can usually continue from the result alone; only
 * oversized blocks fall back to a hit-centered window plus a length hint,
 * which is when opening the source file may be warranted.
 */
export function blockSnippet(text, query) {
  const t = String(text ?? '').trim()
  if (t.length <= SNIPPET_FULL) return t
  const win = snippet(t, query)
  return `${win}\n（块共 ${t.length} 字符，仅截取命中片段；需要更多内容再查看源文件）`
}

/**
 * Search memory entries at BLOCK level with TWO-GROUP keyword scoring
 * (user decision 2026-08-24): every keyword that literally appears in a
 * block adds `PRIMARY_WEIGHT` / `SECONDARY_WEIGHT` (by group) times its
 * occurrence count — partial credit, no hard AND gate, so a block matching
 * only some keywords still surfaces (ranked by how much it did match).
 * Matching is formatting-tolerant: both sides go through looseNormalize(),
 * so backticks/quotes/bold marks never break a hit (identifier characters
 * `-` `_` `.` survive whole). The summed weighted count is damped by block
 * length (BM25-style, relative to the corpus average block length), then
 * multiplied by the note's recency decay weight (old notes recede but never
 * drop below the floor). Title-only blocks are skipped (mirroring the vector
 * index). Ties break by date (newer first), then path.
 *
 * Keywords are expected pre-parsed via parseKeywordGroups() (capped and
 * deduped); they are re-normalized defensively here.
 * @param {Array<{rel: string, date: string, kind: string, text: string}>} entries
 * @param {string[]} primaryKeywords - group-1 keywords (essential, high bonus)
 * @param {string[]} secondaryKeywords - group-2 keywords (refining, low bonus)
 * @param {number} [limit=5]
 * @returns {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>}
 */
export function searchMemory(entries, primaryKeywords = [], secondaryKeywords = [], limit = 5) {
  const primary = (primaryKeywords ?? []).map(looseNormalize).filter(Boolean)
  const secondary = (secondaryKeywords ?? []).map(looseNormalize).filter(Boolean)
  if (primary.length === 0 && secondary.length === 0) return []
  const blocks = []
  for (const entry of entries) {
    for (const s of splitBlocks(entry.text ?? '')) {
      // skip title-only blocks (no body signal), same as the vector path
      if (isTitleOnly(s.text)) continue
      blocks.push({ entry, block: s })
    }
  }
  const totalLen = blocks.reduce((sum, b) => sum + b.block.text.length, 0)
  const avgLen = Math.max(1, totalLen / Math.max(1, blocks.length))
  const groups = [[PRIMARY_WEIGHT, primary], [SECONDARY_WEIGHT, secondary]]
  const hits = []
  for (const { entry, block } of blocks) {
    // one tolerant view per block; every keyword scores against it
    const looseText = looseNormalize(block.text)
    let weighted = 0
    let needle = ''
    for (const [weight, keywords] of groups) {
      for (const keyword of keywords) {
        const occ = occurrenceCount(looseText, keyword)
        if (occ === 0) continue
        weighted += weight * occ
        if (!needle) needle = keyword // snippet window centers on the first hit
      }
    }
    if (weighted === 0) continue
    const lenNorm = weighted / (1 + block.text.length / avgLen)
    const score = lenNorm * recencyWeight(entry.date)
    hits.push({
      rel: block.title ? `${entry.rel}#${block.title}` : entry.rel,
      date: entry.date,
      kind: entry.kind,
      score,
      snippet: blockSnippet(looseText, needle),
    })
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.date !== a.date) return b.date < a.date ? -1 : 1
    return a.rel.localeCompare(b.rel)
  })
  return hits.slice(0, limit)
}

/** Smart score display: integers stay integers, floats round to 4 decimals. */
function formatScore(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return String(score)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)))
}

/**
 * Render search hits for the model. Snippets are whole blocks: line
 * structure is preserved (continuation lines indented) so the agent can
 * scan the block directly instead of opening the source file.
 */
export function formatHits(hits) {
  if (hits.length === 0) return 'No memory found.'
  const lines = []
  for (const hit of hits) {
    const tag = hit.date || 'index'
    lines.push(`- [${tag}] ${hit.rel} (score ${formatScore(hit.score)})`)
    const s = String(hit.snippet ?? '')
    lines.push(s.split('\n').map((l, i) => (i === 0 ? `  ${l}` : `    ${l}`)).join('\n'))
  }
  return lines.join('\n')
}

/**
 * Reciprocal-rank fusion of two PRE-SORTED hit lists (descending by each
 * list's own score). Absolute scores are ignored — only ranks matter — so
 * substring and cosine scores fuse on a comparable scale. The OUTPUT score
 * is the unified RRF fusion score (same dimension for every hit), then
 * multiplied by the note's recency decay weight (old notes recede but never
 * drop below the floor).
 *
 * Dedup is by the EXACT block rel (`rel#title`): the same block never
 * appears twice even when both lists matched it, while DIFFERENT blocks of
 * the same file legitimately coexist (block-level retrieval, user decision
 * 2026-08-17). The kept entry is the first occurrence (substring hits are
 * added first and are more precise).
 * @param {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>} listA
 * @param {Array<{rel: string, date: string, kind: string, score: number, snippet: string}>} listB
 * @param {number} [limit=5]
 * @returns {Array} fused hits, ranked by the unified fusion score
 */
export function fuseHits(listA, listB, limit = 5) {
  const rank = new Map() // block rel -> RRF score
  const byRel = new Map() // block rel -> hit (first occurrence wins)
  const add = (list) => {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i]
      const rel = String(hit.rel ?? '')
      if (!rel) continue
      if (!byRel.has(rel)) byRel.set(rel, hit)
      rank.set(rel, (rank.get(rel) ?? 0) + 1 / (RRF_K + i + 1))
    }
  }
  add(listA)
  add(listB)
  const out = []
  for (const [rel, hit] of byRel) {
    const score = (rank.get(rel) ?? 0) * recencyWeight(hit.date)
    out.push({ ...hit, score })
  }
  out.sort((a, b) => {
    const d = b.score - a.score
    if (d !== 0) return d
    if (b.date !== a.date) return b.date < a.date ? -1 : 1
    return a.rel.localeCompare(b.rel)
  })
  return out.slice(0, limit)
}

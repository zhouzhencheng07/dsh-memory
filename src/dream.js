// dsh-memory — Dream: consolidate daily memory notes into the long-term
// refined library (dream/<bucket>/<topic>.md).
//
// Pipeline (per-file sequential, user decisions 2026-08-17):
//   1. collect: scan the notes of TODAY and YESTERDAY (a note file gets two
//      window chances: the day it was written and the next day);
//   2. watermark: a source-level catalog (dream/.catalog.json, {note rel:
//      mtime}) filters out notes already processed unchanged — only notes
//      that are new or whose mtime changed enter the LLM pipeline. A file is
//      checkpointed only when its units all integrated successfully; failed
//      files stay un-checkpointed and are retried on the next run. No LLM
//      call when nothing changed.
//   3. PER-FILE execution: for each changed note file (sorted by rel), one
//      extract call turns that file's content into memory UNITS
//      ({name, bucket, summary, paths}) — the "not worth memorizing" gate
//      (宁缺毋滥, max 5 units). Cross-file merging of the same abstraction
//      happens at the INTEGRATE layer (a later file's unit recalls the
//      earlier file's digest -> CORROBORATE/REFINE), not in extract.
//   4. recall: for each unit, a DETERMINISTIC scan over the existing digests
//      returns up to RECALL_LIMIT candidate nodes (dedup + interlink input):
//      IDF-lite weighted term matching (title line bonus), fused with vector
//      hits via RRF when a vector index is configured — the local analogue
//      of ReMe's node_search (BM25 + vector RRF). The digest snapshot is
//      refreshed per unit, so digests written earlier in the same run are
//      visible to later files/units (interlinks grow within one run).
//   5. integrate: per unit, one LLM call classifies the candidates
//      (same_abstraction / related / unrelated), picks exactly one action —
//      CREATE / CORROBORATE / REFINE / CORRECT — and returns the FINAL full
//      digest body. The plugin validates, hardens the path, appends
//      `Related:` interlinks and `derived_from::` provenance, and writes
//      atomically. UPDATE keeps ALL old provenance and Related links
//      (additive only). Bare [[...]] lines and derived_from lines are
//      stripped from LLM content (provenance is system-maintained).
//   6. provenance: raw notes are NEVER deleted; digest is a refinement
//      layer, not a gate — notes that never make it into dream/ remain fully
//      searchable through memory_search.
//
// LLM call controls (user decisions 2026-08-17):
//   - NO maxTokens: the request omits the field, so the dsh llm service
//     materializes the adapter's defaultMaxTokens (deepseek: 256k) — the
//     model's own output ceiling, identical to normal agent turns. A
//     hard-coded cap (was 8192) covers thinking + answer and starved the
//     JSON answer on reasoning-max sessions ("no JSON object in the answer").
//   - reasoningEffort follows the acting session (quality matters).
//   - one LLM call is bounded by DREAM_TIMEOUT_MS (30 min) as a safety net.
//   - failed calls retry once with a strict-JSON reminder appended; failure
//     reports include the model's raw answer snippet for diagnosis.
//
// Language: NO output-language requirement (user decision 2026-08-17, like
// QwenPaw): digest language follows the source material / the session model.
//
// The LLM is the acting session's model (quality matters; the user's
// decision 2026-08-15): provider/model/reasoning come from the session
// request header, falling back to agentDefaultModel.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import {
  digestRoot,
  memoryRoot,
  readMemoryFile,
  safeTopic,
  todayStamp,
  walkMemory,
} from './store.js'
import { fuseHits, occurrenceCount } from './search.js'

/** Digest buckets (QwenPaw-aligned, user decision 2026-08-16). */
export const BUCKETS = ['personal', 'procedure', 'wiki']

/** Max units per extract call (ReMe uses the same cap). */
const MAX_UNITS = 5
/**
 * Max candidates surfaced to one integrate call. Higher than ReMe's 20-30
 * would cost too much context per call; 8 is the sweet spot for a single
 * agent that works across many domains (user decision 2026-08-17).
 */
const RECALL_LIMIT = 8
/** Max chars of one candidate digest inside an integrate prompt. */
const CANDIDATE_CHARS = 1400
/**
 * Hard safety timeout for ONE LLM call (user decision 2026-08-17: "超时可以
 * 长一些"): with the output cap removed, a reasoning model on a large prompt
 * can legitimately stream for well over ten minutes. 30 minutes is still a
 * bound against a hung call, far beyond any normal JSON task.
 */
const DREAM_TIMEOUT_MS = 30 * 60 * 1000
/** Strict-JSON reminder appended on retry attempts. */
const STRICT_JSON_REMINDER =
  '（重试提醒：只输出严格 JSON 对象，不要任何解释文字、不要 markdown 围栏、不要以"好的/以下是"等开头，直接输出 JSON。）'
/** Dream watermark file (source-level catalog) inside the digest root. */
const CATALOG_FILE = '.catalog.json'

/** Truncated model answer for failure diagnostics ('' when empty). */
function answerSnippet(answer) {
  const text = String(answer ?? '').trim()
  return text ? `; 回答片段: ${JSON.stringify(text.slice(0, 200))}` : ''
}

/** Atomic write of a digest file. */
function writeDigest(file, content) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Strip trailing `derived_from::` lines (they are re-emitted on merge). */
export function stripDerivedFrom(text) {
  return String(text)
    .split('\n')
    .filter((line) => !line.trim().startsWith('derived_from::'))
    .join('\n')
    .replace(/\n{3,}$/, '\n')
    .trimEnd()
}

/**
 * Clean an LLM-produced digest body: drop system-maintained lines
 * (derived_from::, Related:, bare wikilink lines) and collapse blank runs.
 */
export function cleanDigestBody(text) {
  return String(text)
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (t.startsWith('derived_from::')) return false
      if (/^Related:/.test(t)) return false
      if (/^\[\[.*\]\]$/.test(t)) return false
      if (/^-\s*\[\[.*\]\]/.test(t)) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Parse strict JSON from an LLM answer (tolerates ```json fences). */
export function parseJsonAnswer(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/**
 * Call the acting session's LLM and return the full text.
 *
 * NO maxTokens is sent: the dsh llm service materializes the adapter's
 * defaultMaxTokens for the model (deepseek: 256k), i.e. the model's own
 * output ceiling — the same behavior as normal agent turns (user decision
 * 2026-08-17: use the model's max, no user config).
 * @param {object} ctx - Cordis context
 * @param {object} agent - acting agent (may be undefined for scheduled runs)
 * @param {Array<{role: string, content: unknown}>} messages
 * @param {{model?: string}} [options] - optional "provider/model" override
 * @returns {Promise<string>}
 */
export async function callSessionLlm(ctx, agent, messages, options = {}) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('dsh-memory: llm service absent')
  let provider
  let model
  let reasoningEffort
  // 1. explicit config override ("provider/model") wins
  const override = typeof options?.model === 'string' ? options.model.trim() : ''
  if (override) {
    const idx = override.indexOf('/')
    if (idx > 0 && idx < override.length - 1) {
      provider = override.slice(0, idx)
      model = override.slice(idx + 1)
    }
  }
  // 2. otherwise the acting session's model
  if (!provider || !model) {
    try {
      const header = agent?.session?.requestHeader ? agent.session.requestHeader() : undefined
      const config = header?.config
      if (config?.provider && config?.model) {
        provider = config.provider
        model = config.model
        reasoningEffort = config.reasoningEffort
      }
    } catch {
      // fall through to the default selection
    }
  }
  // 3. finally the agent default selection
  if (!provider || !model) {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    provider = provider ?? selection?.provider
    model = model ?? selection?.model
  }
  if (!provider || !model) throw new Error('dsh-memory: cannot resolve a provider/model')

  const request = {
    provider,
    model,
    messages,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DREAM_TIMEOUT_MS)
  try {
    const parts = []
    for await (const chunk of llm.stream(request)) {
      if (chunk.type === 'text-delta') parts.push(chunk.text)
    }
    return parts.join('')
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Watermark (source-level catalog)
// ---------------------------------------------------------------------------

function catalogPath() {
  return join(digestRoot(), CATALOG_FILE)
}

/** Load the Dream watermark: {note rel -> mtime ms}. Corrupt/absent -> {}. */
export function loadCatalog() {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveCatalog(catalog) {
  const file = catalogPath()
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(catalog, null, 1), 'utf8')
  renameSync(tmp, file)
}

/** Current mtime (ms) of a note file under memoryRoot(), null when absent. */
function noteMtime(rel) {
  try {
    return statSync(join(memoryRoot(), rel)).mtimeMs
  } catch {
    return null
  }
}

/** Drop catalog entries whose date is outside the window or whose file is gone. */
function pruneCatalog(catalog) {
  const yesterday = todayStamp(new Date(Date.now() - 24 * 60 * 60 * 1000))
  for (const rel of Object.keys(catalog)) {
    const m = /^(\d{4}-\d{2}-\d{2})\//.exec(rel)
    if ((m && m[1] < yesterday) || noteMtime(rel) === null) delete catalog[rel]
  }
}

// ---------------------------------------------------------------------------
// Window collection
// ---------------------------------------------------------------------------

/**
 * Group the notes of TODAY and YESTERDAY for one Dream pass.
 * @returns {Array<{date: string, files: Array<{rel: string, text: string}>}>}
 */
export function collectWindow() {
  const today = todayStamp()
  const yesterday = todayStamp(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const byDate = new Map()
  for (const entry of walkMemory()) {
    if (entry.kind !== 'note') continue
    if (!entry.date) continue
    if (entry.date < yesterday || entry.date > today) continue
    if (!byDate.has(entry.date)) byDate.set(entry.date, [])
    byDate.get(entry.date).push({ rel: entry.rel, text: entry.text })
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, files]) => ({ date, files }))
}

// ---------------------------------------------------------------------------
// Extract phase: ONE note file -> memory units
// ---------------------------------------------------------------------------

/** Build the LLM prompt for ONE note file. */
export function buildExtractPrompt(date, file) {
  return [
    '你是记忆巩固引擎。阅读「新记忆笔记」，抽取可整合进长期精炼库 dream/ 的记忆单元（unit）。后续步骤会单独决定每个 unit 是新建 digest 还是并入已有 digest。',
    `桶（bucket）只能是：${BUCKETS.join(' / ')}。`,
    '桶的选择按「未来读者会从哪里搜索」决定：用户/团队/项目偏好、约定与约束 → personal；怎么做某事 → procedure；通用知识、原则、作为先例的决策、事实、观察 → wiki。',
    '一个 unit = 一个可复用抽象，未来会在同一场景被召回。跨文件表达同一抽象的情况不需要在此合并（整合阶段会自动并入已有 digest）。',
    'digest 是抽象记忆层：只保存未来 agent 应该回忆的可复用原则、模式、流程、约定、偏好。原始细节留在 memory/ 每日笔记中；**不进入 digest 的笔记不会丢失**——它们仍可被 memory_search 直接检索到。',
    '禁止输出：一带而过的提及、已知概念复述、事件总括、一次性时间戳、没有复用价值的事实。',
    `待抽取的新记忆笔记（日期 ${date}）：`,
    `=== ${file.rel} ===\n${file.text}`,
    '',
    '要求：',
    '1. 输出严格 JSON（不要任何其他文字，不要 markdown 围栏）：',
    '{"units":[{"name":"<短名，标识该抽象>","bucket":"<桶>","summary":"<基于证据的抽象摘要：命名抽象 + 解释为什么重要 + 指向证据，50-120 词>","paths":["<源笔记 rel>"]}]}',
    `2. units 最多 ${MAX_UNITS} 个；每个 unit 的 paths 只能填写本文件 rel：${file.rel}。`,
    '3. 宁缺毋滥：如果这份笔记没有可复用的内容，返回 "units":[]。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Recall phase: deterministic candidate retrieval over existing digests
// ---------------------------------------------------------------------------

/** First non-empty line of a digest (its de-facto title line). */
function titleLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line ?? ''
}

/**
 * Deterministic recall over digest entries (local analogue of ReMe's
 * node_search). Scoring mirrors BM25's spirit without the machinery:
 * - each unit term (from name+summary) contributes an IDF-lite weight
 *   log(1 + N/(1+df)) — rare, discriminative terms outweigh generic ones;
 * - a term hitting the digest's title line (first non-empty line) adds a
 *   bonus, the local analogue of searching frontmatter name/description;
 * - when a vector index is available, the top substring hits are fused
 *   with vector hits through the same RRF used by memory_search.
 * @param {Array<{rel: string, date: string, kind: string, text: string}>} entries - digest entries
 * @param {{name?: string, summary?: string}} unit
 * @param {{limit?: number, vectorIndex?: object|null}} [opts]
 * @returns {Promise<Array<{rel: string, date: string, kind: string, score: number, snippet: string}>>}
 */
export async function recallDigests(entries, unit, opts = {}) {
  const limit = opts.limit ?? RECALL_LIMIT
  const blob = `${unit?.name ?? ''} ${unit?.summary ?? ''}`
  const terms = [...new Set(blob.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 12)
  if (terms.length === 0) return []
  const N = entries.length || 1
  const df = new Map()
  for (const e of entries) {
    for (const t of terms) {
      if (occurrenceCount(e.text, t) > 0) df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const weight = (t) => Math.log(1 + N / (1 + (df.get(t) ?? 0)))
  const scored = []
  for (const e of entries) {
    const title = titleLine(e.text).toLocaleLowerCase()
    let score = 0
    for (const t of terms) {
      if (occurrenceCount(e.text, t) === 0) continue
      score += weight(t) + (title.includes(t.toLocaleLowerCase()) ? 1.5 : 0)
    }
    if (score === 0) continue
    scored.push({
      rel: e.rel,
      date: e.date ?? '',
      kind: e.kind ?? 'digest',
      score,
      snippet: titleLine(e.text),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  const sub = scored.slice(0, limit * 2)
  const vectorIndex = opts?.vectorIndex ?? null
  if (vectorIndex !== null) {
    try {
      const vec = await vectorIndex.query(entries, blob, limit * 3)
      const fused = fuseHits(sub, vec, limit * 2)
      // dream candidates are FILE-level (integrate needs the full digest
      // text): normalize section-level rels (`rel#title`) back to the base
      // file, keeping the best-scoring block per file.
      const byBase = new Map()
      for (const h of fused) {
        const base = String(h.rel ?? '').split('#')[0]
        if (!base) continue
        if (!byBase.has(base) || h.score > byBase.get(base).score) byBase.set(base, h)
      }
      return [...byBase.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    } catch {
      // vector recall is best-effort: a broken embedding service falls back
      // to pure substring results
    }
  }
  return sub.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Integrate phase: one unit -> one digest node decision
// ---------------------------------------------------------------------------

const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`)

/** Build the per-unit integrate prompt (candidates + classification + action). */
export function buildIntegratePrompt(unit, bucket, sources, evidence, candidates, sameBucket) {
  const candText = candidates.length > 0
    ? candidates.map((c) => `- ${c.rel}\n${truncate(c.text, CANDIDATE_CHARS)}`).join('\n\n')
    : '（无）'
  const bucketTopics = sameBucket.length > 0
    ? sameBucket.map((r) => `- ${r}`).join('\n')
    : '（无）'
  return [
    '你是记忆巩固引擎。把一个「记忆单元」整合进长期精炼库 dream/。',
    `桶：${bucket}。`,
    '正文结构约定：**content 第一行必须是 `# <一句话标题>`**（简短、与该抽象对应），然后才是 `##` 小节；procedure 用 Trigger/Steps/Pre-conditions/Failure modes；personal 用 Rule/Why/How to apply；wiki 用简洁知识条目（定义/原则/事实/观察）。UPDATE 动作保留原 `#` 标题（仅当标题已不准确时修正）。',
    'digest 是抽象记忆层：正文简洁抽象（通常 50-200 词），不逐句摘抄笔记；细节留在 memory/。',
    '',
    '# 待整合单元',
    `name: ${unit.name}`,
    `summary: ${unit.summary}`,
    `sources: ${sources.join(', ')}`,
    '',
    '# 证据（来自每日笔记）',
    evidence,
    '',
    '# 候选已有 digest（召回，用于去重与互链）',
    candText,
    '',
    '# 同桶已有 digest（CREATE 的 topic 冲突检查）',
    bucketTopics,
    '',
    '要求：',
    '1. 分类候选：same_abstraction（触发条件相同、内容实质重叠）→ 最多选一个作为更新目标；related（相邻/互补，值得互链）→ 选入 related；其余 unrelated 忽略。',
    '2. 选择且只选择一个动作：',
    '   - CREATE：没有 same_abstraction。topic 用英文 kebab-case；若理想 topic 与同桶已有文件名冲突，说明它其实是同抽象 → 改选 REFINE/CORRECT。',
    '   - CORROBORATE：同一抽象再次出现且无实质新信息 → target 指向它，content 输出其完整正文（可微调措辞）。',
    '   - REFINE：有新细节/前置条件/边界/失败模式/例外 → 融合进对应段落，content 输出整合后的完整正文，target 指向它。',
    '   - CORRECT：与新证据冲突或已过时 → 收紧/修正表述，content 输出修正后的完整正文，target 指向它。',
    '3. content 是最终完整 digest 正文（保持桶的结构风格）。不要写 derived_from 行、不要写 Related 行、不要输出裸 [[...]] 链接行——来源与互链由系统维护。',
    '4. 输出严格 JSON（不要任何其他文字，不要 markdown 围栏）：',
    '{"action":"CREATE|CORROBORATE|REFINE|CORRECT","target":"<UPDATE 时的候选 rel 路径；CREATE 为 null>","topic":"<CREATE 时的主题名>","content":"<完整 digest 正文 Markdown>","related":[{"rel":"<候选 rel>","note":"<一句话关系说明>"}]}',
    '5. related 只能从候选列表选，最多 3 条，note 用一句话说明与本文的关系。',
  ].join('\n')
}

/** Build the merge prompt: fuse NEW evidence into an EXISTING digest. */
export function buildMergePrompt(oldText, newContent, sources) {
  return [
    '你是记忆巩固引擎。把「新证据」整合进已有的长期记忆 digest。目标是融合而非覆盖：保留旧内容的要点与适用范围，融入新证据（补充、细化或修正），让 digest 更准确。',
    '',
    '# 已有 digest（旧内容）',
    '',
    oldText.trim(),
    '',
    '# 新证据摘要（来自每日笔记的提炼）',
    '',
    String(newContent ?? '').trim(),
    ...(Array.isArray(sources) && sources.length > 0
      ? ['', '# 新证据来源', '', ...sources.map((s) => `- ${s}`)]
      : []),
    '',
    '要求：',
    '1. 输出整合后的完整 digest 正文（Markdown）。只输出正文本身，不要任何解释文字、不要 markdown 围栏、不要 derived_from 行（来源由系统合并）。',
    '2. 保留旧内容中仍然成立的所有要点，不删减有用信息。',
    '3. 融入新证据：重复则强化表述，新细节则补充，冲突则修正旧表述。',
    '4. 保持原有结构风格（procedure/personal/wiki 各自的结构），不要复刻每日笔记的细节——细节留在 memory/。',
    '5. 正文简洁抽象，通常 50-200 词，需要时再长一些。',
  ].join('\n')
}

/**
 * Extract the `derived_from:: [[...]]` lines of a digest file, returned as
 * FULL lines (prefix included) so an UPDATE can re-emit old provenance
 * verbatim. (Regression 0.1.1: returning only `m[1]` dropped the prefix and
 * wrote bare `[[...]]` lines into updated digests.)
 */
export function listDerivedFrom(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*derived_from::\s+(.+)$/.exec(line)
    if (m) out.push(m[0].trim())
  }
  return out
}

/** Parse a `Related: [[rel]] — note; [[rel]] — note` line into items. */
export function parseRelated(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^Related:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    for (const part of m[1].split(';')) {
      const mm = /\[\[([^\]]+)\]\]\s*(?:—|-)?\s*(.*)$/.exec(part.trim())
      if (mm) out.push({ rel: mm[1], note: mm[2].trim() })
    }
  }
  return out
}

/** Render Related items as one line; dedupes by rel; empty -> ''. */
export function renderRelated(items) {
  const seen = new Set()
  const parts = []
  for (const it of items || []) {
    const rel = String(it?.rel ?? '').trim()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const note = String(it?.note ?? '').trim()
    parts.push(note ? `[[${rel}]] — ${note}` : `[[${rel}]]`)
  }
  return parts.length > 0 ? `Related: ${parts.join('; ')}` : ''
}

/** Read an existing digest by rel path (dream/<bucket>/<topic>.md). */
function readDigest(rel) {
  const clean = String(rel ?? '').replace(/^dream\//, '')
  if (!clean || clean.includes('..') || clean.startsWith('/') || clean.includes('\\')) return null
  if (!clean.includes('/') || !clean.endsWith('.md')) return null
  const text = readMemoryFile(join(digestRoot(), clean))
  return text === null ? null : { rel: `dream/${clean}`, text }
}

/**
 * Integrate ONE unit: recall candidates, classify, act, and return the
 * final write plan. Throws on failure (the caller leaves the source note
 * file un-checkpointed so the next run retries).
 * @returns {Promise<{rel: string, action: string, relatedCount: number}>}
 */
async function integrateUnit(ctx, agent, unit, file, digestEntries, config, vectorIndex) {
  const sources = Array.isArray(unit.paths)
    ? unit.paths.filter((p) => typeof p === 'string' && p === file.rel)
    : []
  if (sources.length === 0) throw new Error('unit has no valid sources')
  const bucket = BUCKETS.includes(unit.bucket) ? unit.bucket : 'wiki'
  const evidence = `=== ${file.rel} ===\n${file.text}`

  const hits = await recallDigests(digestEntries, unit, { vectorIndex })
  const entryByRel = new Map(digestEntries.map((e) => [e.rel, e]))
  const candidates = hits.map((h) => ({ rel: h.rel, text: entryByRel.get(h.rel)?.text ?? '' }))
  const sameBucket = digestEntries
    .filter((e) => e.rel.startsWith(`dream/${bucket}/`))
    .map((e) => e.rel)

  let parsed = null
  let lastError = null
  let lastAnswer = ''
  for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
    try {
      const prompt = buildIntegratePrompt(unit, bucket, sources, evidence, candidates, sameBucket)
        + (attempt > 0 ? `\n${STRICT_JSON_REMINDER}` : '')
      const answer = await callSessionLlm(ctx, agent, [
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ], { model: config?.model })
      lastAnswer = answer
      parsed = parseJsonAnswer(answer)
      if (!['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT'].includes(parsed.action)) {
        throw new Error(`bad action: ${parsed.action}`)
      }
      if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
        throw new Error('empty content')
      }
    } catch (error) {
      lastError = error
    }
  }
  if (parsed === null) {
    throw new Error(`integrate LLM failed: ${lastError?.message ?? String(lastError)}${answerSnippet(lastAnswer)}`)
  }

  const body = cleanDigestBody(parsed.content)
  if (body.length === 0) throw new Error('integrate returned empty body')
  const related = (Array.isArray(parsed.related) ? parsed.related : [])
    .filter((r) => r && typeof r.rel === 'string' && typeof r.note === 'string' && candidates.some((c) => c.rel === r.rel))
    .slice(0, 3)
  const newProvenance = sources.map((s) => `derived_from:: [[${s}]]`)

  // Resolve the write target: UPDATE needs a real existing digest; a missing
  // or colliding target degrades to CREATE, and a CREATE topic that already
  // exists degrades to a REFINE-style merge (never overwrite, never stall).
  let action = parsed.action
  let oldDigest = null
  let target = null
  if (action === 'CREATE') {
    target = `dream/${bucket}/${safeTopic(parsed.topic || unit.name)}.md`
    const existing = readDigest(target)
    if (existing !== null) {
      action = 'REFINE'
      oldDigest = existing
    }
  } else {
    const t = String(parsed.target ?? '').trim()
    if (t && t.includes('/')) oldDigest = readDigest(t)
    if (oldDigest === null) {
      action = 'CREATE'
      target = `dream/${bucket}/${safeTopic(parsed.topic || unit.name)}.md`
      const existing = readDigest(target)
      if (existing !== null) {
        action = 'REFINE'
        oldDigest = existing
      }
    } else {
      target = oldDigest.rel
    }
  }

  let finalBody = body
  let provenance = newProvenance
  let relatedItems = related
  if (oldDigest !== null) {
    provenance = [...new Set([...listDerivedFrom(oldDigest.text), ...newProvenance])]
    relatedItems = [...parseRelated(oldDigest.text), ...related]
    if (parsed.action === 'CREATE') {
      // topic collision fallback: fuse the unit into the existing file
      let merged = null
      let mergeError = null
      let mergeAnswer = ''
      for (let attempt = 0; attempt < 2 && merged === null; attempt++) {
        try {
          const prompt = buildMergePrompt(oldDigest.text, unit.summary, sources)
            + (attempt > 0 ? `\n${STRICT_JSON_REMINDER}` : '')
          const answer = await callSessionLlm(ctx, agent, [
            { role: 'user', content: [{ type: 'text', text: prompt }] },
          ], { model: config?.model })
          mergeAnswer = answer
          merged = cleanDigestBody(String(answer))
        } catch (error) {
          mergeError = error
        }
      }
      if (merged === null || merged.length === 0) {
        throw new Error(`collision merge failed: ${mergeError?.message ?? String(mergeError)}${answerSnippet(mergeAnswer)}`)
      }
      finalBody = merged
    }
  }

  const relatedLine = renderRelated(relatedItems)
  const content = [finalBody, relatedLine, ...provenance].filter(Boolean).join('\n')
  writeDigest(join(digestRoot(), target.replace(/^dream\//, '')), `${content}\n`)
  return { rel: target, action, relatedCount: relatedItems.length }
}

/**
 * Run one Dream pass over the fixed two-day window (today + yesterday),
 * filtered by the source-level watermark catalog, executing ONE FILE at a
 * time (extract -> per-unit recall+integrate) so earlier files' digests are
 * visible to later files within the same run.
 * @param {object} ctx - Cordis context
 * @param {object} agent - acting agent (may be undefined)
 * @param {object} [config] - plugin config (model override etc.)
 * @param {object|null} [vectorIndex] - optional VectorIndex for hybrid recall
 * @returns {Promise<{processedDates: string[], scanned: number, changed: number, unchanged: number, units: number, written: string[], changes: string[], errors: string[], skipped: boolean}>}
 */
export async function runDream(ctx, agent, config, vectorIndex = null) {
  const catalog = loadCatalog()
  const window = collectWindow()
  const pending = []
  let scanned = 0
  let unchanged = 0
  for (const { date, files } of window) {
    const changed = []
    for (const f of files) {
      scanned += 1
      const mt = noteMtime(f.rel)
      if (mt !== null && catalog[f.rel] === mt) {
        unchanged += 1
        continue
      }
      changed.push(f)
    }
    if (changed.length > 0) pending.push({ date, files: changed.sort((a, b) => a.rel.localeCompare(b.rel)) })
  }
  const processedDates = window.map(({ date }) => date)
  const written = []
  const changes = []
  const errors = []

  if (pending.length === 0) {
    pruneCatalog(catalog)
    saveCatalog(catalog)
    return {
      processedDates,
      scanned,
      changed: 0,
      unchanged,
      units: 0,
      written,
      changes,
      errors,
      skipped: true,
    }
  }

  let unitsCount = 0
  for (const { date, files } of pending) {
    for (const file of files) {
      // extract: one file -> units (retry once; a failed file is NOT
      // checkpointed and gets its chance again on the next run)
      let unitResult = null
      let lastError = null
      let lastAnswer = ''
      for (let attempt = 0; attempt < 2 && unitResult === null; attempt++) {
        try {
          const prompt = buildExtractPrompt(date, file)
            + (attempt > 0 ? `\n${STRICT_JSON_REMINDER}` : '')
          const answer = await callSessionLlm(ctx, agent, [
            { role: 'user', content: [{ type: 'text', text: prompt }] },
          ], { model: config?.model })
          lastAnswer = answer
          const parsed = parseJsonAnswer(answer)
          if (!Array.isArray(parsed.units)) throw new Error('answer JSON has no units array')
          unitResult = parsed
        } catch (error) {
          lastError = error
        }
      }
      if (unitResult === null) {
        errors.push(`extract failed (${date}, ${file.rel}): ${lastError?.message ?? String(lastError)}${answerSnippet(lastAnswer)}`)
        continue
      }

      const units = Array.isArray(unitResult.units) ? unitResult.units.slice(0, MAX_UNITS) : []
      unitsCount += units.length
      let fileFailed = false
      for (const unit of units) {
        // fresh digest snapshot per unit: digests written earlier in this
        // run (from this file's earlier units or previous files) are visible
        const digestEntries = walkMemory().filter((e) => e.kind === 'digest')
        try {
          const res = await integrateUnit(ctx, agent, unit, file, digestEntries, config, vectorIndex)
          written.push(res.rel)
          changes.push(`[${res.rel}][${res.action}]`)
        } catch (error) {
          fileFailed = true
          errors.push(`unit "${unit?.name ?? '?'}" failed (${date}, ${file.rel}): ${error?.message ?? String(error)}`)
        }
      }

      // checkpoint: only a fully successful file is recorded; a file with
      // any failed unit stays pending and is retried on the next run
      if (!fileFailed) {
        const mt = noteMtime(file.rel)
        if (mt !== null) catalog[file.rel] = mt
      }
    }
  }

  pruneCatalog(catalog)
  saveCatalog(catalog)
  return {
    processedDates,
    scanned,
    changed: scanned - unchanged,
    unchanged,
    units: unitsCount,
    written,
    changes,
    errors,
    skipped: false,
  }
}

/** Format a run report for the model. */
export function formatDreamReport(report) {
  const lines = []
  if (report.processedDates.length === 0) {
    lines.push('无可整合的笔记（窗口内没有记忆文件）。')
  } else {
    lines.push(`已处理日期：${report.processedDates.join('、')}`)
  }
  lines.push(`扫描 ${report.scanned} 个笔记文件：${report.changed} 个变更（${report.unchanged} 个水位未变跳过）`)
  if (report.skipped) {
    if (report.errors.length === 0) lines.push('无新增/变更的笔记，水位跳过，无需整合。')
    else lines.push('本次整合失败（所有文件），下次运行自动重试。')
  } else {
    lines.push(`抽取 ${report.units} 个记忆单元`)
    if (report.changes.length > 0) {
      lines.push(`写入/更新 digest：\n${report.changes.map((c) => `- ${c}`).join('\n')}`)
    } else {
      lines.push('没有需要写入/更新的 digest。')
    }
  }
  if (report.errors.length > 0) lines.push(`失败（已跳过，不影响其他）：\n${report.errors.join('\n')}`)
  return lines.join('\n')
}

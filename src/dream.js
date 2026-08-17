// dsh-memory — Dream consolidation, V2: refine daily memory notes into the
// long-term digest library by running ONE background agent conversation.
//
// Design (user decisions 2026-08-17): the plugin no longer hand-builds prompt
// sequences and calls the LLM stream directly for each extract/integrate step
// (that pipeline was expensive — one uncacheable request per file+unit with
// full reasoning tokens — and slow). Instead EVERY Dream pass launches a fresh
// background agent session through ctx.agents.create() — the same path
// dsh-headless uses for one-shot tasks — bound to the plugin's dream/ workspace
// directory as its cwd. That session:
//   - receives ONE task brief: the watermark-filtered list of changed note
//     files plus the consolidation rules (buckets, 宁缺毋滥, digest body
//     structure, UPDATE-is-additive, topic-collision → REFINE);
//   - does all the work with its own read/glob/grep/write/edit tools: read the
//     notes, recall existing digests, write/update files under
//     $DSH_HOME/dsh-memory/digest/<bucket>/<topic>.md itself;
//   - finishes by emitting a strict JSON report the plugin parses to update
//     the watermark catalog.
//
// Why this is cheaper than the old multi-call pipeline: one session reuses its
// OWN context across many tool calls, so the provider's prefix caching hits on
// every turn after the first; the old pipeline rebuilt a fresh, uncacheable
// prompt per file+unit call and paid full reasoning token bills on every
// request. No JSON-parse-retry loops, no hand-maintained tool-call pairing
// (auto.js documents why hand-built requests broke providers), and the session
// is a real conversation the user can open in the UI under the dream workspace
// to inspect every step of the run.
//
// What stays DETERMINISTIC in the plugin:
//   - watermark: digest/.catalog.json ({note rel: mtime}) filters out notes
//     already processed unchanged — a note is checkpointed only when it is in
//     the session's handled set; failures stay un-checkpointed and are
//     retried on the next run. No LLM call when nothing changed.
//   - window: today + yesterday (fixed two-day scan).
//   - the session's raw writes are validated by the plugin: safe rel paths,
//     provenance lines maintained by the system (additive), Related lines
//     preserved, no stray bare [[...]] lines in the body.
//
// Session model follows the same resolution order as callSessionLlm used to:
// explicit config.model override ("provider/model") → agent default selection.
//
// No session timeout: the task is an ordinary agent conversation that runs to
// quiescence on its own (the agent loop is the lifecycle owner). Provenance:
// raw notes are NEVER deleted; digest is a refinement layer, not a gate —
// notes that never make it into digest/ remain fully searchable through
// memory_search. Only the NEW layout is visible to queries and Dream runs
// ($DSH_HOME/dsh-memory/{memory,digest}); the pre-rename $DSH_HOME/dream/
// library stays on disk for manual comparison but is NOT indexed.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  digestRoot,
  dreamWorkspace,
  memoryRoot,
  readMemoryFile,
  safeTopic,
  todayStamp,
  walkMemory,
} from './store.js'
import { setupDreamAgent } from './dream-setup.js'

/** Digest buckets (QwenPaw-aligned, user decision 2026-08-16). */
export const BUCKETS = ['personal', 'procedure', 'wiki']

/** Dream watermark file (source-level catalog) inside the digest root. */
const CATALOG_FILE = '.catalog.json'

// ---------------------------------------------------------------------------
// Digest write helpers (used for plugin-side validation/normalization of the
// session's raw writes)
// ---------------------------------------------------------------------------

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
 * Clean a digest body: drop system-maintained lines (derived_from::, Related:,
 * bare wikilink lines) and collapse blank runs.
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

/** Extract a strict-JSON object from an assistant answer (tolerates fences). */
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
// Task brief
// ---------------------------------------------------------------------------

/** True when a processed entry names a digest rel path (digest/<bucket>/<t>.md). */
function isDigestRel(rel) {
  return typeof rel === 'string' && rel.startsWith('digest/') && rel.endsWith('.md')
}

/**
 * True when a rel is a safe note/digest path for catalog bookkeeping.
 */
function isSafeRel(rel) {
  return typeof rel === 'string' && !rel.includes('..') && !rel.startsWith('/') && !rel.includes('\\')
}

/**
 * Build the Dream session task brief: the changed note list plus the minimal
 * operational contract. The full consolidation canon lives in the dream
 * workspace AGENTS.md (installed by the plugin on first run, user-editable,
 * loaded into every Dream session's system prompt by the `dream` preset's
 * instructions row) — the brief only references it, lists the pending notes
 * and demands the strict JSON report.
 * @param {Array<{rel: string}>} pending - changed notes to process
 * @returns {string}
 */
export function buildDreamBrief(pending) {
  const files = pending.map((f) => `- ${f.rel}`).join('\n')
  return [
    '本轮 Dream 巩固任务。',
    '',
    '# 先做',
    '- 先读工作区根目录的 AGENTS.md（巩固规则全集）并严格遵守。',
    '- 目录：笔记根 ' + memoryRoot() + '，digest 根 ' + digestRoot() + '。',
    '- 用 read/glob/grep 直接浏览笔记与已有 digest；不要依赖 memory_search 拼凑（它只能按块检索，只当辅助）。',
    '- 用 write/edit 新建或更新 digest 文件。',
    '',
    '# 本次待处理的笔记（只处理这些；未列出的笔记不要动）',
    files,
    '',
    '工作完成后，最后一条消息必须是严格 JSON（不要解释文字、不要 markdown 围栏）：',
    '{"processed":[{"rel":"<digest rel，如 digest/procedure/xxx.md>","action":"CREATE|UPDATE"}],"skipped":["<笔记 rel>"],"failed":["<笔记 rel>"]}',
    '其中 processed 列出你新建/更新的 digest；skipped 列出你判断无可复用内容的笔记 rel；failed 列出读取或处理失败的笔记 rel。无内容时三者可为空数组。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Resolve the session model
// ---------------------------------------------------------------------------

/**
 * Resolve the Dream session's provider/model/reasoningEffort: explicit config
 * override ("provider/model") wins; otherwise the agent default selection.
 */
function resolveSessionModel(ctx, config) {
  const override = String(config?.model ?? '').trim()
  if (override) {
    const idx = override.indexOf('/')
    if (idx > 0 && idx < override.length - 1) {
      return { provider: override.slice(0, idx), model: override.slice(idx + 1), reasoningEffort: undefined }
    }
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (!selection?.provider || !selection?.model) throw new Error('dsh-memory: cannot resolve a provider/model')
  return { provider: selection.provider, model: selection.model, reasoningEffort: undefined }
}

// ---------------------------------------------------------------------------
// Session launch
// ---------------------------------------------------------------------------

/**
 * Launch one background Dream session through the agents service (no parent
 * required — same path as dsh-headless). The session binds to the dream
 * workspace cwd, mounts the `dream` agent preset (file tools + AGENTS.md
 * rules) with danger-full-access permission, receives the task brief, runs to
 * quiescence, and its final assistant message is parsed as the strict JSON
 * report.
 * @param {object} ctx - Cordis context
 * @param {object} config - plugin runtime config (model override)
 * @param {string} brief - the task brief
 * @param {() => Promise<object|undefined>} [getWorkspace] - resolves the dream
 *   workspace entity (for UI grouping); resolved once per run, best-effort.
 * @returns {Promise<{sessionId: string, report: object}>}
 */
export async function runDreamSession(ctx, config, brief, getWorkspace = async () => undefined) {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('dsh-memory: agents service absent; Dream session unavailable')
  const { provider, model, reasoningEffort } = resolveSessionModel(ctx, config)
  const sessionId = `session-${randomUUID()}`
  let handle
  try {
    handle = await agents.create({
      sessionId: SessionId(sessionId),
      meta: {
        cwd: dreamWorkspace(),
        delegationDepth: 1,
        // persist the preset on the session header so UI/resume can resolve it
        agentPreset: 'dream',
      },
      agentOptions: { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) },
      // mount the dream preset + danger-full-access BEFORE the first request
      setup: (agentCtx) => setupDreamAgent(agentCtx),
    })
    // best-effort UI grouping: attach the fresh session to the dream workspace
    // record so its conversation shows under the "dream" workspace and is
    // inspectable there (without the record it lands in "Ungrouped")
    try {
      const entity = await getWorkspace()
      await entity?.attachSession?.(sessionId)
    } catch (error) {
      console.warn(`dsh-memory: cannot attach dream session ${sessionId} to the dream workspace: ${error?.message ?? String(error)}`)
    }
    const agent = handle.agent
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: brief }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    // read the final assistant text (last assistant/message event)
    const events = agent.session.events
    let reportText = ''
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type !== 'assistant/message') continue
      const content = e.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text.trim()) {
        reportText = text
        break
      }
    }
    const report = parseJsonAnswer(reportText)
    if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('dream report is not an object')
    return { sessionId, report }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch {
        // best-effort teardown; the persisted session stays viewable
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Digest read/update primitives (plugin side, for provenance/Related hygiene)
// ---------------------------------------------------------------------------

/** Read an existing digest by rel path (digest/<bucket>/<topic>.md). */
function readDigest(rel) {
  const clean = String(rel ?? '').replace(/^digest\//, '')
  if (!clean || clean.includes('..') || clean.startsWith('/') || clean.includes('\\')) return null
  if (!clean.includes('/') || !clean.endsWith('.md')) return null
  const text = readMemoryFile(join(digestRoot(), clean))
  return text === null ? null : { rel: `digest/${clean}`, text }
}

/** Extract the full `derived_from:: [[...]]` lines of a digest file. */
export function listDerivedFrom(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*derived_from::\s+(.+)$/.exec(line)
    if (m) out.push(m[0].trim())
  }
  return out
}

/** Extract note rels referenced by `derived_from:: [[rel]]` lines. */
export function derivedFromRels(text) {
  const out = []
  for (const line of listDerivedFrom(text)) {
    const m = /\[\[([^\]]+)\]\]/.exec(line)
    if (m) out.push(m[1])
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

/**
 * Finalize a digest file written by the Dream session: keep the agent's
 * system-managed lines (`derived_from::` provenance, `Related:` interlinks),
 * merge with the old digest's lines (additive, dedup), clean the body, and
 * re-render `Related:` so provenance and interlinks never carry bare [[...]]
 * residue. Returns the final content, or '' when the file is already final
 * (no change needed).
 */
export function finalizeDigest(rel, rawText) {
  const clean = String(rel ?? '').replace(/^digest\//, '')
  const old = readDigest(`digest/${clean}`)
  const agentProvenance = listDerivedFrom(rawText)
  const agentRelated = parseRelated(rawText)
  const cleaned = cleanDigestBody(rawText)
  if (cleaned.length === 0) return ''
  const title = cleaned.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const content = title.startsWith('# ') ? cleaned : `# ${safeTopic(clean.replace(/\.md$/, ''))}\n\n${cleaned}`
  const provenance = [...(old === null ? [] : listDerivedFrom(old.text))]
  for (const line of agentProvenance) {
    if (!provenance.includes(line)) provenance.push(line)
  }
  const related = renderRelated([...(old === null ? [] : parseRelated(old.text)), ...agentRelated])
  const parts = [content, related, ...provenance].filter(Boolean)
  const final = `${parts.join('\n')}\n`
  if (old !== null && old.text === final) return ''
  return final
}

// ---------------------------------------------------------------------------
// The Dream pass
// ---------------------------------------------------------------------------

/**
 * Run one Dream pass: collect the two-day window, filter by the watermark
 * catalog, and if anything changed launch ONE background Dream session that
 * executes the whole consolidation with its own tools (dream preset + file
 * tools + danger-full-access). Successful note files are checkpointed in the
 * catalog; failed/unprocessed files stay pending and are retried on the next
 * run.
 * @param {object} ctx - Cordis context
 * @param {object} [config] - plugin runtime config (model override)
 * @param {() => Promise<object|undefined>} [getWorkspace] - resolves the dream
 *   workspace entity for UI grouping (best-effort).
 * @returns {Promise<{processedDates: string[], scanned: number, changed: number, unchanged: number, sessionId: string|null, written: string[], changes: string[], errors: string[], skipped: boolean}>}
 */
export async function runDream(ctx, config = {}, getWorkspace = async () => undefined) {
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
      sessionId: null,
      written,
      changes,
      errors,
      skipped: true,
    }
  }

  const brief = buildDreamBrief(pending.flatMap((p) => p.files))
  let sessionId = null
  try {
    const { sessionId: sid, report } = await runDreamSession(ctx, config, brief, getWorkspace)
    sessionId = sid
    const processed = Array.isArray(report.processed) ? report.processed : []
    const skipped = Array.isArray(report.skipped) ? report.skipped : []
    const failed = Array.isArray(report.failed) ? report.failed : []

    // 1. finalize every reported digest (system provenance + Related hygiene)
    const handledNotes = new Set()
    for (const item of processed) {
      const rel = String(item?.rel ?? '').trim()
      const action = String(item?.action ?? 'UPDATE')
      if (!isDigestRel(rel) || !isSafeRel(rel)) {
        errors.push(`bad digest rel in report: ${rel}`)
        continue
      }
      const text = readMemoryFile(join(digestRoot(), rel.replace(/^digest\//, '')))
      if (text === null || text.length === 0) {
        errors.push(`reported digest missing on disk: ${rel}`)
        continue
      }
      // the digest carries derived_from:: [[note-rel]] lines the agent wrote;
      // they are the handle mapping digest -> source notes
      for (const noteRel of derivedFromRels(text)) {
        if (isSafeRel(noteRel)) handledNotes.add(noteRel)
      }
      const final = finalizeDigest(rel, text)
      if (final !== '') {
        writeDigest(join(digestRoot(), rel.replace(/^digest\//, '')), final)
      }
      written.push(rel)
      changes.push(`[${rel}][${action}]`)
    }

    // 2. checkpoint: a note is done when the session EXPLICITLY reports it as
    // skipped (nothing worth memorizing) OR a finalized digest references it
    // through derived_from — not merely because any digest was written.
    // failed notes and untouched notes stay pending and retry next run.
    const failedSet = new Set(failed.filter(isSafeRel))
    const skippedSet = new Set(skipped.filter(isSafeRel))
    const allRels = pending.flatMap((p) => p.files.map((f) => f.rel))
    for (const rel of allRels) {
      if (failedSet.has(rel)) continue
      if (!skippedSet.has(rel) && !handledNotes.has(rel)) continue
      const mt = noteMtime(rel)
      if (mt !== null) catalog[rel] = mt
    }
    if (failedSet.size > 0) {
      errors.push(`session reported failed notes: ${[...failedSet].join(', ')} (next run retries)`)
    }
  } catch (error) {
    errors.push(`dream session failed: ${error?.message ?? String(error)}`)
  }

  pruneCatalog(catalog)
  saveCatalog(catalog)
  return {
    processedDates,
    scanned,
    changed: scanned - unchanged,
    unchanged,
    sessionId,
    written,
    changes,
    errors,
    skipped: false,
  }
}

/** Format a run report for the model/log. */
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
    if (report.sessionId !== null) lines.push(`后台 Dream 会话：${report.sessionId}（可在 UI 的 dream 工作区查看）`)
    if (report.changes.length > 0) {
      lines.push(`写入/更新 digest：\n${report.changes.map((c) => `- ${c}`).join('\n')}`)
    } else {
      lines.push('没有需要写入/更新的 digest。')
    }
  }
  if (report.errors.length > 0) lines.push(`失败（已跳过，不影响其他）：\n${report.errors.join('\n')}`)
  return lines.join('\n')
}
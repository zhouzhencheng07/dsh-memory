// dsh-memory — storage layer (global under $DSH_HOME, node:fs, zero deps).
//
// Layout (GLOBAL — one shared library for every workspace; user decision
// 2026-08-18: the whole plugin data root IS the memory root — the `memory/`
// sublevel and the digest/dream layers were removed):
//   $DSH_HOME/dsh-memory/YYYY-MM-DD/<workspace-slug>.md
//                                                     one daily file per
//                                                     workspace; topics are
//                                                     `#` first-level headings
//
// The directory is named `dsh-memory` (not `memory`) on purpose: if the
// harness ever ships its own memory feature it will likely use `memory`.
//
// NO state files: Auto-Memory has no counters (the daily date is taken at
// assembly time), and there is no Dream layer anymore (user decision
// 2026-08-18 — memory search + recency guidance replaces the digest library;
// the old digest/ and dream/ directories were removed, the memory/ sublevel
// was merged into the root).
//
// The workspace slug matches $DSH_HOME/sessions/<slug>/ (e.g.
// `--D-Project-dsh-bundle-dsh-memory--`), so every conversation running in
// one workspace shares that workspace's daily memory file; `#` headings
// separate topics inside it.
//
// Write semantics (Auto-Memory 2.0, QwenPaw-style):
//   - one daily file per workspace; `# <title>` sections are UPSERTED:
//     same title replaces (or appends to) the section, a new title appends a
//     new section. No timestamps, no dates in headings (the date already
//     lives in the directory name).
//   - the leading provenance comment (`<!-- 会话来源: session-a, ... -->`)
//     before the first `# ` heading is PRESERVED across rewrites and new
//     session ids are merged into it (multi-session parallel capture).
//   - atomic: temp file + rename, so a crash never leaves a torn note.
//   - serialized through one in-process write queue.
//
// memory_write (2026-08-22): the model-facing write tool calls upsertSections
// from the plugin HOST process — node:fs direct, never through ctx.fs — so
// memory capture works identically under read-only / workspace-write /
// danger-full-access with no sandbox escalation (the agent's own fs tools can
// only touch $DSH_HOME under danger-full-access).
//
// Historical per-topic files (YYYY-MM-DD/<topic>.md) are still read by
// walkMemory; appendNote() remains for compatibility with old writers.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Plugin data root: $DSH_HOME/dsh-memory (one folder for the whole plugin). */
export function pluginRoot() {
  return join(dshHomePath(), 'dsh-memory')
}

/**
 * Memory root: $DSH_HOME/dsh-memory — the memory files live DIRECTLY under
 * the plugin data root (the `memory/` sublevel was removed 2026-08-18:
 * user decision — memory is the only layer left, so no nesting needed).
 */
export function memoryRoot() {
  return pluginRoot()
}

/**
 * Local date stamp YYYY-MM-DD.
 */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Turn a topic into a Windows-safe file basename. CJK characters are kept
 * (UTF-8 file names); only separators and reserved characters are replaced.
 */
export function safeTopic(topic) {
  let slug = String(topic ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0) slug = 'general'
  if (slug.length > 64) slug = slug.slice(0, 64)
  return slug
}

// --- in-process write serialization ---------------------------------------

let writeTail = Promise.resolve()

function serialized(fn) {
  const run = writeTail.then(fn, fn)
  writeTail = run.catch(() => {})
  return run
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

// --- public operations ------------------------------------------------------

/**
 * Append one note's body to the topic file of `date`. No daily index file:
 * the date directory IS the organization, and search reads topic files
 * directly (an index adds no information for the agent — snippets carry
 * more). The body is written verbatim (blank-line separated on append); it
 * should start with a `## heading` of its own.
 * @param {string} date - YYYY-MM-DD
 * @param {string} topic - topic name (slugified for the file name)
 * @param {string} text - note body (already summarized by the model)
 * @param {object} [opts]
 * @returns {Promise<{ file: string, appended: boolean }>}
 */
export async function appendNote(date, topic, text, opts = {}) {
  const slug = safeTopic(topic)
  const file = join(memoryRoot(), date, `${slug}.md`)
  const body = String(text).trim()
  if (body.length === 0) return { file, appended: existsSync(file) && statSync(file).size > 0 }
  return serialized(() => {
    const appended = existsSync(file) && statSync(file).size > 0
    ensureDir(join(file, '..'))
    if (appended) appendFileSync(file, `\n${body}\n`, 'utf8')
    else writeFileSync(file, `${body}\n`, 'utf8')
    return { file, appended }
  })
}

/**
 * Workspace slug for a session cwd, matching the $DSH_HOME/sessions/<slug>/
 * layout (`--D-Project-dsh-bundle-dsh-memory--`). Sessions without a cwd
 * share the `--general--` file.
 * @param {string|undefined} cwd - session working directory
 * @returns {string}
 */
export function sessionSlug(cwd) {
  const raw = String(cwd ?? '').trim()
  if (!raw) return '--general--'
  return `--${raw.replace(':', '').replaceAll('\\', '-')}--`
}

/**
 * Parse `# ` first-level sections of a memory file into
 * `[{ title, body }]` (bodies keep `##`/`###` sub-headings). Text before the
 * first heading is dropped.
 * @param {string} text
 * @returns {Array<{title: string, body: string}>}
 */
export function parseSections(text) {
  const out = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const m = /^#\s+(.*)$/.exec(line)
    if (m) {
      current = { title: m[1].trim(), body: [] }
      out.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }))
}

/**
 * Split the leading preamble (everything before the first `# ` heading line —
 * in practice the provenance comment) off a memory file's text.
 * @param {string} text
 * @returns {{preamble: string, body: string}}
 */
export function splitPreamble(text) {
  const lines = String(text ?? '').split('\n')
  let cut = 0
  while (cut < lines.length && !/^#\s/.test(lines[cut])) cut += 1
  return { preamble: lines.slice(0, cut).join('\n').trim(), body: lines.slice(cut).join('\n') }
}

const SOURCE_COMMENT = /^<!--\s*会话来源:\s*(.*?)\s*-->$/

/**
 * Merge one session id into the leading provenance comment(s): existing
 * `<!-- 会话来源: ... -->` lines are collapsed into ONE comment carrying all
 * ids in first-seen order (new id appended when missing); any other preamble
 * lines survive above it.
 * @param {string} preamble - current preamble text ('' when none)
 * @param {string} sessionId
 * @returns {string}
 */
export function mergeSourceComment(preamble, sessionId) {
  const id = String(sessionId ?? '').trim()
  const rest = []
  const ids = []
  for (const line of String(preamble ?? '').split('\n')) {
    const m = SOURCE_COMMENT.exec(line.trim())
    if (!m) {
      if (line.trim()) rest.push(line.trim())
      continue
    }
    for (const part of m[1].split(',')) {
      const known = part.trim()
      if (known && !ids.includes(known)) ids.push(known)
    }
  }
  if (id && !ids.includes(id)) ids.push(id)
  if (ids.length === 0) return rest.join('\n')
  const comment = `<!-- 会话来源: ${ids.join(', ')} -->`
  return rest.length > 0 ? `${rest.join('\n')}\n${comment}` : comment
}

/**
 * Upsert `# ` sections into `<date>/<slug>.md`.
 * @param {string} date - YYYY-MM-DD
 * @param {string} slug - workspace slug (see sessionSlug)
 * @param {Array<{title: string, content: string, mode?: 'replace'|'append'}>} ops
 *   replace (default): section body becomes `content` (a new title appends);
 *   append: `content` is appended to the existing section body.
 * @param {object} [opts]
 * @param {string} [opts.sourceSessionId] - merged into the leading
 *   `<!-- 会话来源: ... -->` comment; creating a file plants it as line one.
 * @returns {Promise<{file: string, created: boolean, changed: boolean, sections: number}>}
 */
export async function upsertSections(date, slug, ops, opts = {}) {
  const file = join(memoryRoot(), date, `${slug}.md`)
  const clean = (Array.isArray(ops) ? ops : []).filter(
    (op) => op && typeof op.title === 'string' && op.title.trim(),
  )
  if (clean.length === 0) return { file, created: false, changed: false, sections: 0 }
  return serialized(() => {
    const existed = existsSync(file) && statSync(file).size > 0
    const oldText = existed ? readFileSync(file, 'utf8') : ''
    const { preamble, body } = splitPreamble(oldText)
    const sections = parseSections(body)
    let changed = false
    for (const op of clean) {
      const title = op.title.trim()
      const content = String(op.content ?? '').trim()
      if (!content) continue
      const idx = sections.findIndex((s) => s.title === title)
      if (idx >= 0) {
        const old = sections[idx].body
        const next = op.mode === 'append' ? (old ? `${old}\n${content}` : content) : content
        if (next !== old) {
          sections[idx] = { title, body: next }
          changed = true
        }
      } else {
        sections.push({ title, body: content })
        changed = true
      }
    }
    const nextPreamble = opts.sourceSessionId ? mergeSourceComment(preamble, opts.sourceSessionId) : preamble
    if (nextPreamble !== preamble) changed = true
    if (!changed) return { file, created: !existed, changed: false, sections: sections.length }
    const out = [nextPreamble, sections.map((s) => `# ${s.title}\n\n${s.body}`).join('\n\n')]
      .filter((part) => part.length > 0)
      .join('\n\n')
    ensureDir(join(file, '..'))
    writeFileSync(file, `${out}\n`, 'utf8')
    return { file, created: !existed, changed: true, sections: sections.length }
  })
}

/** Read a memory file as text; null when absent; '' when over `maxBytes`. */
export function readMemoryFile(file, maxBytes = 2 * 1024 * 1024) {
  if (!existsSync(file)) return null
  const stat = statSync(file)
  if (stat.size > maxBytes) return ''
  return readFileSync(file, 'utf8')
}

/**
 * Walk every markdown file under the memory root (the only layer — the
 * digest/dream layers were removed 2026-08-18). rel paths use forward
 * slashes and are relative to memoryRoot() (YYYY-MM-DD/<topic>.md).
 * @returns {Array<{rel: string, date: string, kind: 'note', text: string}>}
 */
export function walkMemory() {
  const out = []
  const root = memoryRoot()
  if (!existsSync(root) || !statSync(root).isDirectory()) return out
  for (const day of readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue
    // YYYY-MM-DD/<topic>.md
    const dir = join(root, day.name)
    for (const inner of readdirSync(dir, { withFileTypes: true })) {
      if (!inner.isFile() || !inner.name.endsWith('.md')) continue
      const file = join(dir, inner.name)
      const text = readMemoryFile(file)
      if (text === null || text.length === 0) continue
      out.push({ rel: relative(root, file).replaceAll('\\', '/'), date: day.name, kind: 'note', text })
    }
  }
  return out
}

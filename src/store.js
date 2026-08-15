// dsh-memory — storage layer (global under $DSH_HOME, node:fs, zero deps).
//
// Layout (GLOBAL — one shared library for every workspace):
//   $DSH_HOME/memory/YYYY-MM-DD/<workspace-slug>.md   one daily file per
//                                                     workspace; topics are
//                                                     `#` first-level headings
//   $DSH_HOME/dream/<bucket>/<topic>.md               Dream digest (preference/
//                                                     procedure/fact/knowledge)
//
// NO state files: Dream uses a fixed two-day window (no watermark), and
// Auto-Memory has no counters (the daily date is taken at assembly time).
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
//   - atomic: temp file + rename, so a crash never leaves a torn note.
//   - serialized through one in-process write queue.
//
// Historical per-topic files (memory/YYYY-MM-DD/<topic>.md) are still read
// by walkMemory; appendNote() remains for compatibility with old writers.

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

/** Memory root: $DSH_HOME/memory (global, shared across every workspace). */
export function memoryRoot() {
  return dshHomePath('memory')
}

/** Digest root: $DSH_HOME/dream (Dream output). */
export function digestRoot() {
  return dshHomePath('dream')
}

/** Local date stamp YYYY-MM-DD. */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** HH:MM stamp for section headers. */
export function timeStamp(now = new Date()) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
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
 * Upsert `# ` sections into `memory/<date>/<slug>.md`.
 * @param {string} date - YYYY-MM-DD
 * @param {string} slug - workspace slug (see sessionSlug)
 * @param {Array<{title: string, content: string, mode?: 'replace'|'append'}>} ops
 *   replace (default): section body becomes `content` (a new title appends);
 *   append: `content` is appended to the existing section body.
 * @returns {Promise<{file: string, created: boolean, changed: boolean, sections: number}>}
 */
export async function upsertSections(date, slug, ops) {
  const file = join(memoryRoot(), date, `${slug}.md`)
  const clean = (Array.isArray(ops) ? ops : []).filter(
    (op) => op && typeof op.title === 'string' && op.title.trim(),
  )
  if (clean.length === 0) return { file, created: false, changed: false, sections: 0 }
  return serialized(() => {
    const existed = existsSync(file) && statSync(file).size > 0
    const oldText = existed ? readFileSync(file, 'utf8') : ''
    const sections = parseSections(oldText)
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
    if (!changed) return { file, created: !existed, changed: false, sections: sections.length }
    const body = sections.map((s) => `# ${s.title}\n\n${s.body}`).join('\n\n')
    ensureDir(join(file, '..'))
    writeFileSync(file, `${body}\n`, 'utf8')
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
 * Walk every markdown file under the global memory roots.
 * rel paths use forward slashes; notes are relative to memory/
 * (YYYY-MM-DD/<topic>.md), digests carry a `dream/` prefix (kept for
 * dream.js merge_with / derived_from handling).
 * @returns {Array<{rel: string, date: string, kind: 'note'|'digest', text: string}>}
 */
export function walkMemory() {
  const out = []
  const root = memoryRoot()
  const dig = digestRoot()
  if (existsSync(root) && statSync(root).isDirectory()) {
    for (const day of readdirSync(root, { withFileTypes: true })) {
      if (!day.isDirectory()) continue
      // memory/YYYY-MM-DD/<topic>.md
      const dir = join(root, day.name)
      for (const inner of readdirSync(dir, { withFileTypes: true })) {
        if (!inner.isFile() || !inner.name.endsWith('.md')) continue
        const file = join(dir, inner.name)
        const text = readMemoryFile(file)
        if (text === null || text.length === 0) continue
        out.push({ rel: relative(root, file).replaceAll('\\', '/'), date: day.name, kind: 'note', text })
      }
    }
  }
  if (existsSync(dig) && statSync(dig).isDirectory()) {
    for (const bucket of readdirSync(dig, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      for (const inner of readdirSync(join(dig, bucket.name), { withFileTypes: true })) {
        if (!inner.isFile() || !inner.name.endsWith('.md')) continue
        const file = join(dig, bucket.name, inner.name)
        const text = readMemoryFile(file)
        if (text === null || text.length === 0) continue
        out.push({ rel: `dream/${relative(dig, file).replaceAll('\\', '/')}`, date: '', kind: 'digest', text })
      }
    }
  }
  return out
}

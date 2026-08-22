// dsh-memory — storage vocabulary (global under $DSH_HOME, zero deps).
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
// Write path (2026-08-25, user decision — see index.js header): the `memory`
// tool is a path locator — it returns today's memory file (creating it with
// the provenance comment when absent, merging the calling session into the
// comment when present) by dispatching the host's NATIVE read/write tools.
// The model then maintains the note with its own native read/edit/write
// tools. No host hooks (tools/result etc.) are registered; provenance is
// maintained exclusively inside the memory tool. This file keeps only:
// path/slug/date derivation, the provenance-comment merge (preamble split +
// session-id merge, exported as mergeProvenance), the raw text read used to
// construct the merge input, and the walk used by memory_search.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Plugin data root: $DSH_HOME/dsh-memory (one folder for the whole plugin). */
export function pluginRoot() {
  return join(dshHomePath(), 'dsh-memory')
}

/** Memory root: $DSH_HOME/dsh-memory — the memory files live DIRECTLY under
 * the plugin data root (the `memory/` sublevel was removed 2026-08-18). */
export function memoryRoot() {
  return pluginRoot()
}

/** Local date stamp YYYY-MM-DD. */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

/** Read a memory file as text; null when absent; '' when over `maxBytes`. */
export function readMemoryFile(file, maxBytes = 2 * 1024 * 1024) {
  if (!existsSync(file)) return null
  const stat = statSync(file)
  if (stat.size > maxBytes) return ''
  return readFileSync(file, 'utf8')
}

/**
 * Merge one session id into a memory file's text: the leading provenance
 * comment(s) are collapsed into ONE `<!-- 会话来源: ... -->` line carrying
 * all ids in first-seen order (the new id appended when missing); any other
 * preamble lines survive above it. Exactly idempotent: when the comment
 * already carries the id (or there is no id to add), the text comes back
 * unchanged with `changed: false`, so a caller never rewrites on formatting
 * differences. The model never touches this — it is maintained exclusively
 * by the `memory` tool (2026-08-25, user decision).
 * @param {string} text - current file text ('' for an absent file)
 * @param {string|undefined} sessionId
 * @returns {{text: string, changed: boolean}}
 */
export function mergeProvenance(text, sessionId) {
  const split = splitPreamble(text)
  const merged = sessionId ? mergeSourceComment(split.preamble, sessionId) : split.preamble
  if (merged === split.preamble) {
    return { text: String(text ?? ''), changed: false }
  }
  const body = split.body.trim()
  return { text: body ? `${merged}\n\n${body}` : merged, changed: true }
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
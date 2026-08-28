// dsh-memory — storage vocabulary (global under $DSH_HOME, zero deps).
//
// Layout (GLOBAL — one shared library for every workspace; user decision
// 2026-08-18: the whole plugin data root IS the memory root):
//   $DSH_HOME/dsh-memory/YYYY-MM-DD/<workspace-slug>.md
//                                                     one daily file per
//                                                     workspace; topics are
//                                                     `#` first-level headings
//   $DSH_HOME/dsh-memory/memory/<topic>.md            LONG-TERM memory: free
//                                                     topic files, one topic
//                                                     per file (user decision
//                                                     2026-08-28, replacing
//                                                     the never-shipped
//                                                     single memory.md).
//                                                     The dir name is not a
//                                                     date, so it is exempt
//                                                     from both the recency
//                                                     decay and the daily
//                                                     hard window —
//                                                     walkMemory indexes any
//                                                     subdirectory, so this
//                                                     layer needs zero extra
//                                                     code.
//
// The directory is named `dsh-memory` (not `memory`) on purpose: if the
// harness ever ships its own memory feature it will likely use `memory`.
//
// Write path (2026-08-28, user decision — see index.js header): the
// three-mode `memory` tool does all file work itself via node:fs (trusted
// plugin data-root writes, native-shaped observation guard). The session
// provenance comment was removed with the 2026-08-23 locator design it
// belonged to, so this file keeps only path/slug/date derivation and the
// walk used by memory_search — no write helpers, no comment merging.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Plugin data root: $DSH_HOME/dsh-memory (one folder for the whole plugin). */
export function pluginRoot() {
  return join(dshHomePath(), 'dsh-memory')
}

/** Memory root: $DSH_HOME/dsh-memory — the memory files live DIRECTLY under
 * the plugin data root. */
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
 * share the `--general--` file. Both slash spellings normalize to the same
 * slug, so a cwd arriving as `D:\Project\x` (Win32) and `D:/Project/x`
 * (Git Bash) resolves to one and the same daily file.
 * @param {string|undefined} cwd - session working directory
 * @returns {string}
 */
export function sessionSlug(cwd) {
  const raw = String(cwd ?? '').trim()
  if (!raw) return '--general--'
  return `--${raw.replace(':', '').replaceAll('\\', '-').replaceAll('/', '-')}--`
}

/** Read a memory file as text; null when absent; '' when over `maxBytes`. */
export function readMemoryFile(file, maxBytes = 2 * 1024 * 1024) {
  if (!existsSync(file)) return null
  const stat = statSync(file)
  if (stat.size > maxBytes) return ''
  return readFileSync(file, 'utf8')
}

/**
 * Walk every markdown file under the memory root. Two layers:
 *   - dated subdirectories (YYYY-MM-DD/<topic>.md): the ephemeral daily
 *     layer — when `windowDays` > 0, directories whose name parses as a date
 *     OLDER than the window are skipped (hard window, user decision
 *     2026-08-24: too-old diaries leave the searchable corpus but stay on
 *     disk). The window applies ONLY to parseable dates.
 *   - any other subdirectory (in practice `memory/<topic>.md`, the long-term
 *     topic files): never windowed; their unparseable "date" also makes
 *     recencyWeight return 1 — no decay, always reachable.
 * rel paths use forward slashes relative to memoryRoot()
 * (YYYY-MM-DD/<topic>.md or memory/<topic>.md).
 * @param {number} [windowDays=0] - hard window for dated notes in days; 0 disables it
 * @returns {Array<{rel: string, date: string, kind: 'note', text: string}>}
 */
export function walkMemory(windowDays = 0) {
  const out = []
  const root = memoryRoot()
  if (!existsSync(root) || !statSync(root).isDirectory()) return out
  const cutoff = Number(windowDays) > 0 ? Date.now() - Number(windowDays) * 86400000 : null
  for (const day of readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue
    // hard window: only directory names that PARSE as dates can age out;
    // `memory/` (and any other non-date dir) is always indexed
    const ms = cutoff !== null ? Date.parse(day.name) : NaN
    if (cutoff !== null && Number.isFinite(ms) && ms < cutoff) continue
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

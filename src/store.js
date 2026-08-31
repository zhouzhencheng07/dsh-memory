// dsh-memory — storage vocabulary (global under $DSH_HOME, zero deps).
//
// Layout (GLOBAL — one shared library for every workspace; user decision
// 2026-08-18: the whole plugin data root IS the memory root):
//   <memory root>/YYYY-MM-DD/<workspace-slug>.md    one daily file per
//                                                   workspace; topics are
//                                                   `#` first-level headings
//   <memory root>/topics/<topic>.md                 LONG-TERM memory: free
//                                                   topic files, one topic
//                                                   per file (2026-08-29,
//                                                   renamed from memory/ now
//                                                   that the root itself is
//                                                   the memory library —
//                                                   "memory inside memory"
//                                                   was redundant). Any
//                                                   non-date directory stays
//                                                   indexed, so pre-rename
//                                                   memory/ files keep
//                                                   showing up in search.
//
// Root resolution (2026-09-01, user decision — configurable, NOT an
// environment variable): the `memoryRoot` setting of the `dsh-memory:`
// section wins when non-empty, otherwise the plugin data root
// $DSH_HOME/dsh-memory. The previous AGENT_MEMORY_HOME override is GONE: a
// library path is user-facing configuration and belongs where the user can
// see and edit it (the settings card), not in an invisible machine-wide
// variable that also differs per shell.
//
// Write path (2026-08-28, user decision — see index.js header): the `memory`
// tool does all file work itself via node:fs (trusted plugin data-root
// writes, native-shaped observation guard). The session provenance comment
// was removed with the 2026-08-23 locator design it belonged to, so this
// file keeps only path/slug/date derivation, the walk used by recall, and
// the diary address resolution — no write helpers, no comment merging.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Plugin data root: $DSH_HOME/dsh-memory (one folder for the whole plugin). */
export function pluginRoot() {
  return join(dshHomePath(), 'dsh-memory')
}

/**
 * Memory root: the configured library. `memoryRoot` (the `dsh-memory:`
 * settings section) wins when non-empty — a user-visible, hot-reloadable
 * setting — otherwise the plugin data root $DSH_HOME/dsh-memory, the same
 * default every pre-setting deployment already used.
 * @param {string} [configured] - the `memoryRoot` setting value
 * @returns {string}
 */
export function memoryRoot(configured) {
  const custom = String(configured ?? '').trim()
  return custom || pluginRoot()
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

/** True when `value` is an exactly YYYY-MM-DD date stamp. Every diary
 * address takes one, so validating here is what keeps a model-supplied
 * string from escaping the memory root as a path. */
export function isDateStamp(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && Number.isFinite(Date.parse(String(value)))
}

/**
 * Workspace token as the model sees it: the daily file name with its slug
 * bookends and extension stripped (`--D-Project-x--.md` → `D-Project-x`).
 * This is the value recall prints and the value the model feeds back into
 * `workspace` — a label, never a path, so it can never address anything
 * outside the library.
 * @param {string} name - daily file name (with or without `.md`)
 * @returns {string}
 */
export function workspaceLabel(name) {
  return String(name ?? '').replace(/\.md$/i, '').replace(/^-+/, '').replace(/-+$/, '')
}

/**
 * Resolve a diary address (<root>/<date>/<slug>.md) from the label recall
 * printed. Resolution is deliberately FORGIVING — the label can be a long
 * mouthful (`D-Project-dsh-plugin-dsh-memory`) and the model may copy only
 * a distinguishing fragment:
 *   1. an exact `--<label>--.md` file wins;
 *   2. otherwise the label is matched as a case-insensitive SUBSTRING of the
 *      day's file names, provided it matches exactly one;
 *   3. several matches are an ERROR that lists them (an ambiguous address
 *      must never silently resolve to the wrong workspace).
 * `label` empty/undefined resolves to the CALLING SESSION's own workspace
 * (the default diary file), which is why the common case needs no label.
 * @param {string} root - memory root
 * @param {string} date - YYYY-MM-DD
 * @param {string} [label] - workspace token; empty = this session's
 * @param {string} [cwd] - this session's cwd (only used when label is empty)
 * @returns {{ok: true, file: string} | {ok: false, error: string}}
 */
export function resolveDiary(root, date, label, cwd) {
  if (!isDateStamp(date)) return { ok: false, error: `date must be exactly YYYY-MM-DD (got "${date}")` }
  const dir = join(root, date)
  const raw = String(label ?? '').trim()
  if (!raw) return { ok: true, file: join(dir, `${sessionSlug(cwd)}.md`), label: workspaceLabel(sessionSlug(cwd)) }
  // normalize the label the same way workspaceLabel does, so any of the
  // printed form (`D-Project-x`), the raw file name (`--D-Project-x--.md`)
  // and a distinguishing fragment all resolve
  const wanted = workspaceLabel(raw).toLocaleLowerCase()
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return { ok: false, error: `no notes for ${date}` }
  }
  // the returned path always reuses the name AS IT EXISTS ON DISK: comparing
  // case-insensitively is fine, but rebuilding the path from a lowercased
  // label would point at a nonexistent file on a case-sensitive filesystem
  const exact = names.find((n) => workspaceLabel(n).toLocaleLowerCase() === wanted)
  if (exact !== undefined) return { ok: true, file: join(dir, exact), label: workspaceLabel(exact) }
  const loose = names.filter((n) => workspaceLabel(n).toLocaleLowerCase().includes(wanted))
  if (loose.length === 1) return { ok: true, file: join(dir, loose[0]), label: workspaceLabel(loose[0]) }
  if (loose.length > 1) {
    return { ok: false, error: `"${raw}" matches ${loose.length} workspaces on ${date}: ${loose.map(workspaceLabel).join(', ')} — give a more specific workspace` }
  }
  return { ok: false, error: `no note for ${date} in workspace "${raw}"${names.length > 0 ? ` (${names.map(workspaceLabel).join(', ')})` : ''}` }
}

/**
 * Walk every markdown file under the memory root. Two layers:
 *   - dated subdirectories (YYYY-MM-DD/<topic>.md): the ephemeral daily
 *     layer — when `windowDays` > 0, directories whose name parses as a date
 *     OLDER than the window are skipped (hard window, user decision
 *     2026-08-24: too-old diaries leave the searchable corpus but stay on
 *     disk). The window applies ONLY to parseable dates.
 *   - any other subdirectory (in practice `topics/<topic>.md`, the long-term
 *     topic files): never windowed; their unparseable "date" also makes
 *     recencyWeight return 1 — no decay, always reachable.
 * rel paths use forward slashes relative to memoryRoot()
 * (YYYY-MM-DD/<topic>.md or topics/<topic>.md).
 * @param {number} [windowDays=0] - hard window for dated notes in days; 0 disables it
 * @param {string} [root=memoryRoot()] - memory root (the configured one)
 * @returns {Array<{rel: string, date: string, kind: 'note', text: string}>}
 */
export function walkMemory(windowDays = 0, root = memoryRoot()) {
  const out = []
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

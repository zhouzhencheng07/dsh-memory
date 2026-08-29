#!/usr/bin/env node
// agent-memory — portable CLI half of the dsh-memory plugin.
//
// Shares ONE memory library with the dsh plugin: the same layout (daily
// diaries `YYYY-MM-DD/<workspace-slug>.md` + long-term topic files
// `topics/<topic>.md`), the same block-level keyword scoring (search.js is a
// verbatim mirror of the plugin's src/search.js, byte-identity guarded by
// tests/test-mem-skill.mjs). The dsh plugin stays the library's primary
// writer (per-turn capture reminder, settings card); other agents use this
// CLI to search and record against the same corpus.
//
// Home resolution: the AGENT_MEMORY_HOME environment variable — the SAME
// variable the dsh plugin resolves, so one machine-wide setting points every
// agent at one library. There is deliberately NO default and NO --home flag:
// silently creating a second, divergent library would be worse than refusing
// to run. Point AGENT_MEMORY_HOME at the dsh plugin's data root
// (e.g. D:\agent\.dsh\dsh-memory); changing it takes effect in NEW processes.
//
// Write guard: the plugin enforces a per-session observation guard in memory;
// a CLI process is stateless between invocations, so the guard is a
// content-hash CAS instead — every read prints `[hash: <12 hex>]`, and write
// (full replace of an existing file) / edit must pass it as `--expect-hash`.
// Every mutation prints the NEW hash, so consecutive edits chain without
// re-reading (mirroring the plugin updating its observation after success).
// Like the plugin: atomic tmp+rename writes, 1 MB content cap, topic names
// locked to a single safe path segment, diary slugs derived from the cwd.
//
// Differences from the plugin's memory_search: keyword-only (no optional
// vector fusion — keeps this file dependency-free). Search parameters are
// LOCKED like the plugin's config (user decision 2026-08-29): limit 2 and
// the 45-day diary window are constants — no --limit/--days overrides, the
// agent-facing interface is keywords only, exactly like the plugin's tool.
//
// Plain ESM JavaScript on purpose: zero dependencies, runs on any agent that
// has Node and a shell. See SKILL.md for the model-facing usage contract.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { formatHits, parseKeywords, searchMemory } from './search.js'

/** Result count, LOCKED to the plugin's searchLimit default of 2 (user
 * decision 2026-08-29: never agent-specifiable, same as the plugin tool). */
const SEARCH_LIMIT = 2
/** Hard window for dated notes in days, LOCKED to the plugin's
 * dailyWindowDays default — aged-out diaries leave the corpus on purpose. */
const WINDOW_DAYS = 45
/** Long-term layer classification: a rel whose FIRST path segment does not
 * parse as a date is a long-term topic file (topics/<topic>.md — and any
 * pre-rename memory/ files), mirroring the plugin and walkMemory's window
 * rule instead of hardcoding a directory name. */
const isLongtermRel = (rel) => !Number.isFinite(Date.parse(String(rel ?? '').split('/')[0]))
/** Write cap, mirroring the plugin: memory notes are small curated files. */
const MAX_WRITE_BYTES = 1024 * 1024
/** Read display cap, mirroring store.readMemoryFile's indexing cap. */
const MAX_READ_BYTES = 2 * 1024 * 1024
/** Long-term topic names: letters/digits/`-`/`_`, one safe path segment. */
const TOPIC_RE = /^[\p{L}\p{N}_-]+$/u

const USAGE = `agent-memory — cross-session, cross-agent memory CLI

Usage: node mem.mjs <command> [options]

Commands:
  search  --keywords "a b c"
          Block-level keyword search; up to 5 space-separated terms, most
          essential FIRST (first 3 weigh x3, next 2 x1). Result count (2) and
          the 45-day diary window are fixed — no --limit/--days overrides.
  read    [--topic NAME]
          Print today's note for this workspace (or topics/<NAME>.md) with
          its [hash: ...] footer. ABSENT output lists existing topics.
  write   [--topic NAME] [--expect-hash H]
          Create a file, or fully replace an existing one (then --expect-hash
          is required). Full note text on stdin.
  edit    --expect-hash H [--topic NAME]
          Literal replacement. JSON on stdin: {"old":"...","new":"...","replace_all":false}

Home: the AGENT_MEMORY_HOME environment variable (no default, no flags).`

// --- shared vocabulary (mirrors src/store.js; store.js itself imports
// @deepseek-ai/dsh-home-paths and must stay dsh-only) ------------------------

/** Local date stamp YYYY-MM-DD. */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Workspace slug for a cwd, matching the dsh plugin's sessionSlug (store.js):
 * `--D-Project-x--`. Both slash spellings normalize to the same slug, so this
 * CLI and the plugin write the SAME daily file for the same workspace.
 */
export function sessionSlug(cwd) {
  const raw = String(cwd ?? '').trim()
  if (!raw) return '--general--'
  return `--${raw.replace(':', '').replaceAll('\\', '-').replaceAll('/', '-')}--`
}

/** Read a memory file as text; null when absent; '' when over maxBytes. */
function readMemoryFile(file, maxBytes = MAX_READ_BYTES) {
  if (!existsSync(file)) return null
  const stat = statSync(file)
  if (stat.size > maxBytes) return ''
  return readFileSync(file, 'utf8')
}

/**
 * Walk the memory root (same shape as store.walkMemory): dated
 * subdirectories are the diary layer — names parsing as a date older than
 * `windowDays` leave the corpus; any other subdirectory (in practice
 * `topics/`, the long-term topic files) is always indexed and never decays
 * (its unparseable "date" makes recencyWeight return 1).
 */
export function walkMemory(root, windowDays = 0) {
  const out = []
  if (!existsSync(root) || !statSync(root).isDirectory()) return out
  const cutoff = Number(windowDays) > 0 ? Date.now() - Number(windowDays) * 86400000 : null
  for (const day of readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue
    const ms = cutoff !== null ? Date.parse(day.name) : NaN
    if (cutoff !== null && Number.isFinite(ms) && ms < cutoff) continue
    const dir = join(root, day.name)
    for (const inner of readdirSync(dir, { withFileTypes: true })) {
      if (!inner.isFile() || !inner.name.endsWith('.md')) continue
      const text = readMemoryFile(join(dir, inner.name))
      if (text === null || text.length === 0) continue
      out.push({
        rel: relative(root, join(dir, inner.name)).replaceAll('\\', '/'),
        date: day.name,
        kind: 'note',
        text,
      })
    }
  }
  return out
}

// --- CLI plumbing -------------------------------------------------------------

/** Flags that TAKE a value. Their next token is consumed unconditionally —
 * even when it starts with `--`, because realistic values (a `--slug` like
 * `--D-Project-x--`) start with dashes too. Only SUPPORTED value flags are
 * listed: anything else (e.g. the removed --limit/--days/--home) parses as
 * boolean and can never swallow a following flag. Unknown flags are boolean. */
const VALUE_FLAGS = new Set(['keywords', 'topic', 'slug', 'expect-hash'])

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--') || arg.length === 2) continue
    const eq = arg.indexOf('=')
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    if (VALUE_FLAGS.has(key)) {
      flags[key] = args[i + 1] ?? true
      i += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function resolveHome() {
  const home = String(process.env.AGENT_MEMORY_HOME ?? '').trim()
  if (!home) {
    throw new Error(
      'agent-memory: memory home is not configured — set the AGENT_MEMORY_HOME environment variable to the library root; ' +
        'this CLI deliberately has no default home',
    )
  }
  return resolve(home)
}

/** Content hash for the CAS guard (12 hex chars). */
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
}

function statInfo(file) {
  return statSync(file, { throwIfNoEntry: false }) ?? null
}

/** Atomic publish: same-directory temp file + rename. */
function atomicWrite(file, content) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Long-term topic names currently on disk (empty when the dir is absent). */
function listTopics(root) {
  try {
    return readdirSync(join(root, 'topics'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** Today's diary note by default; `--topic` targets topics/<topic>.md. The
 * regex plus the join keep every reachable path strictly inside the home —
 * the caller only ever supplies a single safe segment. */
function resolveTarget(root, flags) {
  const topic = String(flags.topic ?? '').trim()
  if (!topic) {
    const cwd = typeof flags.slug === 'string' ? flags.slug : process.cwd()
    return { file: join(root, todayStamp(), `${sessionSlug(cwd)}.md`), topic: '' }
  }
  if (!TOPIC_RE.test(topic)) throw new Error(`agent-memory: invalid topic "${topic}" — letters, digits, "-" or "_" only`)
  return { file: join(root, 'topics', `${topic}.md`), topic }
}

// --- commands -------------------------------------------------------------------

function cmdSearch(root, flags) {
  if (flags.keywords === true || flags.keywords === undefined) {
    throw new Error('agent-memory: pass --keywords "term1 term2 ..." (up to 5 terms, most essential first)')
  }
  // Locked parameters, mirroring the plugin's locked searchLimit/window
  // config (user decision 2026-08-29): the interface is keywords only — a
  // stale --limit/--days habit gets an instructive refusal, not a silent
  // ignore.
  if (flags.limit !== undefined || flags.days !== undefined) {
    throw new Error('agent-memory: search takes no --limit/--days — result count (2) and the diary window (45 days) are fixed')
  }
  const limit = SEARCH_LIMIT
  const windowDays = WINDOW_DAYS
  const kw = parseKeywords(String(flags.keywords ?? ''))
  if (kw.primary.length === 0 && kw.secondary.length === 0) {
    throw new Error('agent-memory: no usable keywords')
  }
  // keyword health (absent / too-generic terms) is reported back so the
  // caller can reword its query
  const stats = []
  const ranked = searchMemory(walkMemory(root, windowDays), kw.primary, kw.secondary, limit * 3, stats)
  const isLongterm = (h) => isLongtermRel(h?.rel)
  const hits = ranked.slice(0, limit)
  // Long-term append seat (same as the plugin): when no long-term block made
  // the cut, the best-ranking one from the pool is APPENDED after the
  // regular results — additive, never evicts; it also flips the hint branch.
  if (hits.length > 0 && !hits.some(isLongterm)) {
    const reserve = ranked.slice(limit).find(isLongterm)
    if (reserve) hits.push(reserve)
  }
  let out = formatHits(hits, root)
  const allNotices = [...kw.notices, ...stats]
  if (allNotices.length > 0) out = `${allNotices.join('; ')}\n${out}`
  // Composition-driven long-term guidance (same branch as the plugin's
  // memory_search; "the memory tool" becomes this CLI's verbs).
  if (hits.length > 0) {
    out += hits.some(isLongterm)
      ? '\nLong-term topic blocks above are authoritative (never windowed) — correct outdated statements in their topic files in place, and merge topic files that clearly overlap.'
      : '\nIf a fact above proved worth keeping long term, file it into topics/<topic>.md (mem write --topic <name>) — update the matching topic file, or start a new one when none matches.'
  }
  return out
}

function cmdRead(root, flags) {
  const { file, topic } = resolveTarget(root, flags)
  const info = statInfo(file)
  if (!info) {
    let out = `ABSENT ${file} — create it: mem write (full note text on stdin)`
    if (!topic) {
      const topics = listTopics(root)
      out += topics.length > 0
        ? `\nExisting long-term topics: ${topics.join(', ')} (target with --topic <name>)`
        : '\nLong-term topic files live under topics/<topic>.md (target with --topic <name>)'
    }
    return out
  }
  if (info.size > MAX_READ_BYTES) {
    return `${file} · too large to display (${info.size} bytes) — trim it down before further edits`
  }
  const hash = hashFile(file)
  const text = readFileSync(file, 'utf8')
  return `${file}\n\n${text}\n\n— mutate with --expect-hash ${hash}: mem edit ({"old","new"} on stdin) or mem write (full replace)`
}

function cmdWrite(root, flags, stdin) {
  const { file } = resolveTarget(root, flags)
  const content = String(stdin ?? '')
  if (!content.trim()) {
    throw new Error('agent-memory: nothing on stdin — pipe the full note text, e.g. mem write --topic <name> < note.md')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`agent-memory: content is ${bytes} bytes — the ${MAX_WRITE_BYTES}-byte cap keeps notes curated; split the content across topic files`)
  }
  const current = statInfo(file)
  if (current) {
    const want = typeof flags['expect-hash'] === 'string' ? flags['expect-hash'] : ''
    if (!want) {
      throw new Error(`agent-memory: "${file}" already exists — read it first (mem read) and pass --expect-hash <hash> to fully replace it`)
    }
    if (want !== hashFile(file)) {
      throw new Error(`agent-memory: "${file}" changed since it was read — read it again and pass the fresh --expect-hash`)
    }
  }
  atomicWrite(file, content)
  return `${file} · ${current ? 'replaced' : 'created'} (${bytes} bytes)\n[hash: ${hashFile(file)}]`
}

function cmdEdit(root, flags, stdin) {
  const { file } = resolveTarget(root, flags)
  let payload
  try {
    payload = JSON.parse(String(stdin ?? ''))
  } catch {
    throw new Error('agent-memory: edit payload must be JSON on stdin: {"old":"...","new":"...","replace_all":false}')
  }
  if (typeof payload?.old !== 'string' || payload.old.length === 0) {
    throw new Error('agent-memory: edit requires a non-empty "old" ("new" defaults to "")')
  }
  const newValue = payload.new == null ? '' : String(payload.new)
  const current = statInfo(file)
  if (!current) throw new Error(`agent-memory: cannot edit "${file}": not found — create it with mem write`)
  const want = typeof flags['expect-hash'] === 'string' ? flags['expect-hash'] : ''
  if (!want) {
    throw new Error(`agent-memory: "${file}" was never read this session — read it first and pass --expect-hash <hash>`)
  }
  if (want !== hashFile(file)) {
    throw new Error(`agent-memory: "${file}" changed since it was read — read it again and pass the fresh --expect-hash`)
  }
  const text = readFileSync(file, 'utf8')
  const count = text.split(payload.old).length - 1
  if (count === 0) throw new Error(`agent-memory: "old" not found in "${file}" — copy it exactly from the read output`)
  const replaceAll = payload.replace_all === true
  if (count > 1 && !replaceAll) {
    throw new Error(`agent-memory: ${count} occurrences of "old" in "${file}" — it must be unique, or pass "replace_all":true`)
  }
  atomicWrite(file, replaceAll ? text.replaceAll(payload.old, newValue) : text.replace(payload.old, newValue))
  return `${file} · edited (${count} occurrence${count === 1 ? '' : 's'} replaced)\n[hash: ${hashFile(file)}]`
}

/**
 * Programmatic entry point (tests import this; the CLI shim below calls it
 * with process argv/stdin). Throws on refusals; returns the output text.
 * @param {string[]} argv - arguments AFTER the command name? No: argv[0] is
 *   the command (search/read/write/edit/--help), the rest are flags.
 * @param {string} [stdin] - stdin payload (write: note text; edit: JSON)
 * @returns {Promise<string>} output text (one command, no trailing newline)
 */
export async function run(argv, stdin = '') {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') return USAGE
  const flags = parseFlags(rest)
  const root = resolveHome()
  if (command === 'search') return cmdSearch(root, flags)
  if (command === 'read') return cmdRead(root, flags)
  if (command === 'write') return cmdWrite(root, flags, stdin)
  if (command === 'edit') return cmdEdit(root, flags, stdin)
  throw new Error(`agent-memory: unknown command "${command}"\n\n${USAGE}`)
}

/** Read stdin fully when piped (empty string on a TTY). */
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((res, rej) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => {
      buf += d
    })
    process.stdin.on('end', () => res(buf))
    process.stdin.on('error', rej)
  })
}

async function main() {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    console.log(USAGE)
    return
  }
  try {
    console.log(await run(process.argv.slice(2), await readStdin()))
  } catch (error) {
    console.error(error?.message ?? String(error))
    process.exitCode = 1
  }
}

// CLI shim: execute only when invoked directly (case-tolerant on Windows).
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  await main()
}

// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes under <memory root>/
// YYYY-MM-DD/, long-term topic files under <memory root>/topics/, and
// memory search. The root is the `memoryRoot` setting of the `dsh-memory:`
// section (default: the plugin data root $DSH_HOME/dsh-memory).
//
// Design (agreed with the user, 2026-08-16..2026-09-01):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive. FINAL capture mechanism (2026-08-29, user
//     decision — the 2026-08-28 AGENTS.md externalization experiment is
//     ABANDONED: usage rules kept leaking into the user-curated file and it
//     put a curation burden on the user): the per-turn reminder is BACK and
//     stays SHORT — timing only ("worth keeping in this turn → MUST use the
//     memory tool", gated on `autoMemory`, subagents excluded) — while usage
//     mechanics AND organization rules (what to record, # headings, merge,
//     in-place correction) live in the memory tool description. Long-term
//     filing is NEVER pre-judged at capture: it follows the search result
//     composition (see the retrieval bullet).
//   - ONE tool, TWO modes (2026-09-01, user decision — `memory_search` is
//     GONE, folded in as `mode:"recall"`): `recall` = search + read (a
//     single "get memory out" verb), `remember` = create + replace + edit
//     (a single "put memory in" verb, whose shape the FILE STATE decides —
//     absent → `content` creates; present → `old_string` edits in place).
//     The naming follows the semantics: read/write were narrower than what
//     the modes actually do (read never covered search, write never covered
//     edit), and `remember` deliberately does not distinguish creating from
//     revising — "remember this" is one act.
//   - retrieval (`mode:"recall"` with `keywords`): block-level; POSITIONAL
//     keyword scoring 2026-08-25 — ONE `keywords` parameter of up to 5
//     terms, first 3 ×3 then next 2 ×1, partial credit per matched keyword,
//     no hard AND gate, MIN_SCORE floor, IDF term weighting — plus optional
//     vector, recency-weighted. Long-term guidance is COMPOSITION-DRIVEN
//     since 2026-08-29: the output ends with a hint branched on the result
//     composition — a topics/ block among the hits ⇒ treat as
//     authoritative / fix in place / merge overlapping topic files; none ⇒
//     file proved-lasting facts into topics/<topic>.md. Promotion happens at
//     reuse time and is never pre-judged at capture (user decision:
//     被搜到才说明值得长存).
//   - NO FILE PATHS in any output (2026-09-01, user decision): recall rows
//     and read/write receipts identify notes by ADDRESS (`2026-08-20 ·
//     D-Project-x`, `topics/windows-env`) instead of by path. The model is
//     never told where the library lives, so it cannot bypass this tool with
//     its native read/write/edit — the whole writable surface stays inside
//     the observation guard, and stale diary notes (which decay and expire
//     by design) can no longer be dredged up and "fixed" by hand. A hit row
//     is therefore also the READ KEY: `date` + `workspace` + `block`
//     addresses the exact block again.
//   - long-term layer = FREE TOPIC FILES (2026-08-28, user decision):
//     topics/<topic>.md, one file per topic (renamed from memory/ on
//     2026-08-29). walkMemory indexes ANY non-date subdirectory, so
//     pre-rename memory/ files stay searchable and the long-term
//     classification is "first rel segment is not a date", not a
//     directory-name check). Topic files have NO directory listing anywhere
//     in the tool output (2026-09-01, user decision): a list of every topic
//     is noise that grows without bound and invites browsing by file name
//     instead of retrieval — the ONLY way to learn that a topic exists is to
//     have it surface in a recall result.
//   - WHY the tool writes via plain node:fs instead of dispatching the
//     native tools (2026-08-28, user decision): the sandbox fence lives
//     INSIDE the fs backend (@deepseek-ai/dsh-fs-sandbox checkedTarget —
//     even a direct ctx.fs.writeText falls back to ctx.sandboxPolicy
//     .resolve()), so native-pipeline writes to $DSH_HOME are refused under
//     workspace-write, and the only legitimate wider path is the tool
//     layer's one-shot escalation which requires per-write user approval —
//     unusable for automatic capture. A plugin writing its OWN data root is
//     trusted host behavior (same class as settings.yaml persistence); the
//     sandbox protects MODEL-controlled paths, and here the model only
//     supplies content while paths are tool-derived (today's note, a
//     whitelisted topic, or an address-resolved dated note). Capture works
//     in every permission mode.
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (memoryRoot / searchLimit / dailyWindowDays / embeddingBaseUrl /
//     embeddingModel / autoMemory / longtermAppend), see README.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/*` resolves at runtime
// through Node's parent-walk (the harness installs them in the profile
// fallback node_modules).

import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRoot, resolveDiary, sessionSlug, todayStamp, walkMemory } from './store.js'
import { findBlock, formatHits, fuseHits, parseKeywords, searchMemory, splitBlocks } from './search.js'
import { EmbeddingClient, VectorIndex } from './embed.js'

export const name = 'dsh-memory'

/** Settings namespace of this plugin; its registration is what makes the
 * browser card appear in the Plugins settings section (the card half lives
 * in client/bundle.js and binds ctx.settingsScope to this namespace). */
const NS = settingsNamespace('dsh-memory')

export const inject = ['tools']

/**
 * Plugin configuration, editable through the `dsh-memory:` section of
 * $DSH_HOME/settings.yaml (hot-reloaded, no restart needed).
 * Schema notes: `z` is @deepseek-ai/schemastery (Koishi), NOT zod — no
 * `.integer()` / `.optional()` / `.nullable()`; use `.natural()`, `.min()`,
 * `.max()` and plain defaults (a field without `.required()` is optional).
 */
export const Config = z.object({
  /** Memory library root: where the notes live. Empty = the plugin data
   * root $DSH_HOME/dsh-memory (2026-09-01: a user-visible setting, in place
   * of the old AGENT_MEMORY_HOME environment override — a library path is
   * configuration, not a machine-wide invariant). */
  memoryRoot: z.string(),
  /** Default result count for recall (user decision 2026-08-29: 2 is enough
   * now that the longtermAppend seat surfaces a long-term block). */
  searchLimit: z.natural().min(1).max(10).default(2),
  /** Hard window in days for the DAILY notes (user decision 2026-08-24;
   * lowered 90 → 45 days on 2026-08-29 — agent work iterates fast, stale
   * diaries stop earning their tokens): dated notes older than this leave
   * the searchable corpus (files stay on disk). 0 disables the window.
   * Long-term topic files (topics/) are never windowed and never decay. */
  dailyWindowDays: z.natural().default(45),
  /** Ollama base URL for optional vector search (e.g. http://localhost:11434); empty disables it. */
  embeddingBaseUrl: z.string(),
  /** Embedding model served by embeddingBaseUrl. */
  embeddingModel: z.string().default('bge-m3'),
  /** Per-turn system-prompt reminder ("use the memory tool when something is
   * worth keeping"); off = no reminder, the memory tool remains usable. */
  autoMemory: z.boolean().default(true),
  /** Long-term append seat (2026-08-25): when no topics/ block made the
   * results, the best-ranking one from the candidate pool is APPENDED after
   * them (never evicting a regular result). Off = pure top-N. */
  longtermAppend: z.boolean().default(true),
})

const MAX_LIMIT = 10

/** Long-term layer classification: a rel whose FIRST path segment does not
 * parse as a date is a long-term topic file (topics/<topic>.md — and any
 * pre-rename memory/ files, which walkMemory keeps indexing). Date-based
 * classification mirrors walkMemory's window rule instead of hardcoding
 * directory names. */
const isLongtermRel = (rel) => !Number.isFinite(Date.parse(String(rel ?? '').split('/')[0]))

/** Write cap: memory files are small curated notes; refuse runaway content. */
const MAX_WRITE_BYTES = 1024 * 1024
/** Read display cap, mirroring store.readMemoryFile's indexing cap. */
const MAX_READ_BYTES = 2 * 1024 * 1024
/** Guard bookkeeping cap: beyond this many sessions, drop the oldest
 * session's observation records (plugin code cannot weakly observe session
 * disposal, so the map needs an explicit bound). */
const MAX_TRACKED_SESSIONS = 256

/**
 * The one `memory` tool (2026-09-01, user decision — replaces the
 * memory_search + three-mode memory pair with a single two-mode tool).
 *
 *   mode:"recall"   search + read: `keywords` searches the whole library and
 *                   returns whole blocks; `date`/`topic` (+ optional
 *                   `block`) opens one note. Default (no addressing
 *                   parameter) = today's note for this workspace.
 *   mode:"remember" create / replace / edit: `content` creates an absent
 *                   note or fully replaces a read one; `old_string` edits a
 *                   read one in place.
 *
 * Observation guard, mirroring @deepseek-ai/dsh-fs-observation-policy:
 * per-session records of present {mtimeMs, size} / absent per file. Write on
 * an existing-but-unread file is refused (createIfAbsent semantics); write
 * and edit on a stale observation are refused (CAS — "read it again"); edit
 * without a prior read is refused (FS_NOT_OBSERVED); old_string must match
 * exactly once unless replace_all (FS_AMBIGUOUS_EDIT). A call with no
 * session owner reads freely but, like the native policy, cannot satisfy
 * the prior-observation requirement: write proceeds only as create, edit is
 * always refused.
 */
function memoryTool(getConfig, getVectorIndex) {
  /** sessionId -> Map(file -> {kind:'present', mtimeMs, size} | {kind:'absent'}) */
  const observed = new Map()

  function owner(exec) {
    return exec?.agent?.session?.id ?? null
  }

  function record(sessionId, file, kind) {
    if (!sessionId) return
    let byFile = observed.get(sessionId)
    if (!byFile) {
      if (observed.size >= MAX_TRACKED_SESSIONS) {
        observed.delete(observed.keys().next().value)
      }
      byFile = new Map()
      observed.set(sessionId, byFile)
    }
    byFile.set(file, kind === 'absent' ? { kind } : { kind, ...statInfo(file) })
  }

  function prior(sessionId, file) {
    return sessionId ? observed.get(sessionId)?.get(file) : undefined
  }

  /** Current stat summary; null when the file is absent. */
  function statInfo(file) {
    const info = statSync(file, { throwIfNoEntry: false })
    return info ? { mtimeMs: info.mtimeMs, size: info.size } : null
  }

  const STALE = (label) => `memory: ${label} changed since you read it — recall it again`

  /** Publish atomically: same-directory temp file + rename, so a crash or
   * concurrent reader never observes a half-written note. */
  function atomicWrite(file, content) {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  }

  const TOPIC_RE = /^[\p{L}\p{N}_-]+$/u
  /** Long-term directory names, mirroring walkMemory: anything whose name
   * does not parse as a date is a long-term directory. A write always lands
   * in `topics/` (the current layout); a read may address any of them, so
   * pre-rename `memory/` files stay readable. */
  const LONGTERM_DIRS = ['topics', 'memory']

  /**
   * Split a `topic` argument into its long-term directory and file name.
   * Both the bare form (`windows-env`) and the addressed form
   * (`topics/windows-env`, as printed in a recall row) are accepted; a bare
   * topic means `topics/`. Anything with a path separator beyond that one
   * optional directory, or with characters outside the safe set, is refused
   * — the model may name a file but never navigate.
   * @param {string} topic
   * @returns {ok: true, dir: string, name: string} | {ok: false, error: string}
   */
  function splitTopic(topic) {
    const parts = String(topic).split('/')
    let dir = 'topics'
    if (parts.length === 2) {
      dir = parts[0]
      parts.shift()
    } else if (parts.length !== 1) {
      return { ok: false, error: `memory: invalid topic "${topic}" — at most one directory level` }
    }
    const name = parts[0]
    if (!TOPIC_RE.test(dir) || !TOPIC_RE.test(name)) {
      return { ok: false, error: `memory: invalid topic "${topic}" — letters, digits, "-" or "_" only` }
    }
    if (!LONGTERM_DIRS.includes(dir)) {
      return { ok: false, error: `memory: "${dir}" is not a long-term directory (${LONGTERM_DIRS.join(' or ')})` }
    }
    return { ok: true, dir, name }
  }

  /** The configured memory root (hot-reloadable). */
  function root() {
    return memoryRoot(getConfig().memoryRoot)
  }

  /**
   * Resolve one call's target note.
   *
   * `topic` targets the long-term library (topics/<name>.md for writes, any
   * long-term directory for reads); `date` (+ optional `workspace`)
   * addresses a diary note. The topic regex and resolveDiary's stamp check +
   * label matching keep every reachable path strictly inside the memory root
   * — the model only ever supplies safe segments, never a path.
   * @returns {{ok: true, file: string, label: string, kind: 'diary'|'topic'}
   *          | {ok: false, error: string}}
   */
  function resolveTarget(args, exec, { write = false } = {}) {
    const topic = String(args?.topic ?? '').trim()
    const date = String(args?.date ?? '').trim()
    const workspace = String(args?.workspace ?? '').trim()
    if (topic && date) return { ok: false, error: 'memory: pass either topic or date, not both' }
    if (workspace && !date) return { ok: false, error: 'memory: workspace requires a date' }
    if (topic) {
      const parsed = splitTopic(topic)
      if (!parsed.ok) return parsed
      // writes always land in the current layout: reading a legacy
      // `memory/` file is fine, but new content belongs in `topics/`
      const dir = write ? 'topics' : parsed.dir
      return { ok: true, file: join(root(), dir, `${parsed.name}.md`), label: `${dir}/${parsed.name}`, kind: 'topic' }
    }
    if (date) {
      const cwd = exec?.agent?.session?.header?.cwd
      const hit = resolveDiary(root(), date, workspace, cwd)
      return hit.ok
        ? { ok: true, file: hit.file, label: `${date} · ${hit.label ?? workspace}`, kind: 'diary' }
        : { ok: false, error: `memory: ${hit.error}` }
    }
    const stamp = todayStamp()
    const slug = sessionSlug(exec?.agent?.session?.header?.cwd)
    return { ok: true, file: join(root(), stamp, `${slug}.md`), label: `today's note (${stamp})`, kind: 'diary' }
  }

  /**
   * mode:"recall" — search the library, or read one note/block.
   * A `keywords` argument that is PRESENT but blank is an error (the model
   * asked to search and gave nothing to search for), while an absent one
   * means "read".
   */
  function doRecall(args, sessionId, exec) {
    const keywords = String(args?.keywords ?? '').trim()
    if (args?.keywords != null && keywords === '') throw new Error('memory: no usable keywords')
    if (keywords) return recallSearch(keywords)
    const target = resolveTarget(args, exec)
    if (!target.ok) throw new Error(target.error)
    return readNote(target, String(args?.block ?? '').trim(), sessionId)
  }

  /**
   * Block-level keyword search over the whole corpus, with the
   * composition-driven long-term guidance appended (2026-08-29).
   */
  async function recallSearch(keywords) {
    const kw = parseKeywords(keywords)
    if (kw.primary.length === 0 && kw.secondary.length === 0) throw new Error('memory: no usable keywords')
    // Result count is locked to the configured searchLimit (user decision
    // 2026-08-22): no agent-facing override.
    const limit = Math.min(Math.max(Number(getConfig().searchLimit) || 5, 1), MAX_LIMIT)
    const windowDays = Math.max(0, Math.floor(Number(getConfig().dailyWindowDays) || 0))
    const entries = walkMemory(windowDays, root())
    // gather a candidate pool several times the result window so fusion and
    // the long-term append seat have room to rank; keyword health (absent /
    // too-generic terms) is reported back so the model can reword
    const stats = []
    const poolSize = Math.min(limit * 3, MAX_LIMIT * 3)
    const sub = searchMemory(entries, kw.primary, kw.secondary, poolSize, stats)
    const index = getVectorIndex()
    let fused = null
    if (index !== null) {
      try {
        const vec = await index.query(entries, [...kw.primary, ...kw.secondary].join(' '), poolSize)
        fused = fuseHits(sub, vec, poolSize)
      } catch (error) {
        // vector search is best-effort: a broken embedding service falls
        // back to pure substring results instead of failing the tool
        console.warn(`dsh-memory: vector search unavailable (${error?.message ?? String(error)}), using substring results`)
      }
    }
    const ranked = fused ?? sub
    const hits = ranked.slice(0, limit)
    // Long-term append seat (2026-08-25, replaces the 2026-08-24 last-slot
    // eviction): when NO long-term block made the cut, the best-ranking one
    // from the candidate pool is APPENDED after the regular results — it
    // never evicts anything, and works for limit=1 too. The seat is NOT
    // mandatory: the candidate must exist (i.e. have cleared MIN_SCORE and
    // ranked into the pool). Off by config `longtermAppend: false`.
    const isLongterm = (h) => isLongtermRel(h?.rel)
    if (getConfig().longtermAppend !== false && hits.length > 0 && !hits.some(isLongterm)) {
      const reserve = ranked.slice(limit).find(isLongterm)
      if (reserve) hits.push(reserve)
    }
    // rows carry ADDRESSES, never paths (2026-09-01) — see the module header
    let out = formatHits(hits)
    // tell the calling model when its input was trimmed, or when a keyword
    // matched nothing / matched everything, so the next call rewords
    const allNotices = [...kw.notices, ...stats]
    if (allNotices.length > 0) out = `${allNotices.join('; ')}\n${out}`
    if (hits.length === 0) return out
    // how to read a hit further: date + workspace + block, or topic + block
    out += '\nRead one in full with memory {mode:"recall", date:"<date>", workspace:"<workspace>"} (or topic:"<name>"), optionally block:"<breadcrumb>".'
    // Long-term guidance is COMPOSITION-DRIVEN (2026-08-29, user decision):
    // promotion into the topic files happens at REUSE time — the result set
    // itself decides which hint the model sees, instead of the agent
    // pre-judging at capture time (被搜到才说明值得长存). The append seat
    // above participates: an appended long-term block flips the branch.
    out += hits.some(isLongterm)
      ? '\nLong-term (topics/) blocks above are authoritative (never windowed) — correct outdated statements in their topic file in place, and merge topic files that clearly overlap.'
      : '\nIf a fact above proved worth keeping long term, file it with memory {mode:"remember", topic:"<name>", content:"…"} — update the matching topic file, or start a new one when none matches.'
    return out
  }

  /** Heading breadcrumbs of a note, for the "no such block" message. */
  function blockTitles(text) {
    return splitBlocks(text).map((b) => b.title).filter(Boolean)
  }

  /**
   * Read one note (whole file, or one block of it) and record the
   * observation the guard later checks.
   */
  function readNote(target, blockTitle, sessionId) {
    const info = statInfo(target.file)
    if (!info) {
      record(sessionId, target.file, 'absent')
      // a legacy `memory/<name>` read is offered the topics/ write form:
      // new content belongs in the current layout
      const shape = target.kind === 'topic'
        ? `memory {mode:"remember", topic:"${String(target.label).replace(/^memory\//, '')}", content:"<full note text>"}`
        : 'memory {mode:"remember", content:"<full note text>"}'
      return `ABSENT — no ${target.label} note exists yet; create it with ${shape}`
    }
    if (info.size > MAX_READ_BYTES) {
      record(sessionId, target.file, 'present')
      return `${target.label} · too large to display (${info.size} bytes) — trim it down before further edits`
    }
    const text = readFileSync(target.file, 'utf8')
    record(sessionId, target.file, 'present')
    if (blockTitle) {
      const block = findBlock(text, blockTitle)
      if (!block) {
        const titles = blockTitles(text)
        return `No block "${blockTitle}" in ${target.label}${titles.length > 0 ? ` — its blocks are: ${titles.join(' | ')}` : ''}`
      }
      return `${target.label} · ${block.title}\n\n${block.text}\n\n— maintain it with memory {mode:"remember", old_string, new_string}`
    }
    return `${target.label}\n\n${text}\n\n— maintain it with memory {mode:"remember", old_string, new_string}`
  }

  /**
   * mode:"remember" — create (content on an absent note), replace (content
   * on a read note), or edit (old_string on a read note).
   */
  function doRemember(args, sessionId, exec) {
    const hasContent = typeof args?.content === 'string'
    const hasEdit = typeof args?.old_string === 'string' && args.old_string.length > 0
    if (hasContent && hasEdit) {
      throw new Error('memory: pass either content (create/replace) or old_string (edit in place), not both')
    }
    if (!hasContent && !hasEdit) {
      throw new Error('memory: remember needs either content (create/replace) or old_string (edit in place)')
    }
    if (String(args?.date ?? '').trim()) {
      throw new Error('memory: diary notes of past days are read-only — only today\'s note and topics/<name>.md can be written')
    }
    const target = resolveTarget(args, exec, { write: true })
    if (!target.ok) throw new Error(target.error)
    return hasContent
      ? writeNote(target, String(args.content), sessionId)
      : editNote(target, args, sessionId)
  }

  /** Content-only create: writeNote is called ONLY when the file is absent or
   * empty (the caller — doRemember — gates content vs old_string). A present
   * non-empty note that slipped through to content is rejected immediately. */

  /** Create a new note, or append if the file is empty (guard opened it as absent
   * but a file appeared). Present non-empty notes MUST use `old_string` instead
   * of `content` — `content` on an existing note is rejected to prevent
   * accidental overwrite of the whole text (2026-09-01, user decision after a
   * real loss incident). */
  function writeNote(target, content, sessionId) {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(`memory: content is ${bytes} bytes — the ${MAX_WRITE_BYTES}-byte cap keeps notes curated; split the content across topic files`)
    }
    const current = statInfo(target.file)
    const seen = prior(sessionId, target.file)
    if (current) {
      // File exists and has content → content is not allowed
      if (current.size > 0) {
        throw new Error(`memory: ${target.label} already has content — use old_string to edit in place, not content (which would overwrite the whole note)`)
      }
      // File exists but is empty: treat as absent (allow content to fill it)
      if (!seen || seen.kind === 'absent') {
        throw new Error(`memory: ${target.label} ${seen ? 'appeared since you read it as absent' : 'already exists'} — recall it first`)
      }
      if (seen.mtimeMs !== current.mtimeMs || seen.size !== current.size) throw new Error(STALE(target.label))
    }
    atomicWrite(target.file, content)
    record(sessionId, target.file, 'present')
    return `${target.label} · created (${bytes} bytes)`
  }

  /** Edit in place: unique literal replace, guarded by prior read + CAS. */
  function editNote(target, args, sessionId) {
    const newValue = args?.new_string == null ? '' : String(args.new_string)
    const current = statInfo(target.file)
    const seen = prior(sessionId, target.file)
    if (!current) {
      throw new Error(`memory: cannot edit ${target.label}: ${seen ? 'not found' : 'editing requires recalling it first'}`)
    }
    if (!seen || seen.kind === 'absent') {
      throw new Error(`memory: ${target.label} ${seen ? 'appeared since you read it as absent' : 'was never read this session'} — recall it before editing`)
    }
    if (seen.mtimeMs !== current.mtimeMs || seen.size !== current.size) throw new Error(STALE(target.label))
    const text = readFileSync(target.file, 'utf8')
    const count = text.split(args.old_string).length - 1
    if (count === 0) throw new Error(`memory: old_string not found in ${target.label} — copy it exactly from the recall output`)
    const replaceAll = args?.replace_all === true
    if (count > 1 && !replaceAll) {
      throw new Error(`memory: ${count} occurrences of old_string in ${target.label} — it must be unique, or pass replace_all:true`)
    }
    atomicWrite(target.file, replaceAll ? text.replaceAll(args.old_string, newValue) : text.replace(args.old_string, newValue))
    record(sessionId, target.file, 'present')
    return `${target.label} · edited (${count} occurrence${count === 1 ? '' : 's'} replaced)`
  }

  return {
    name: 'memory',
    description:
      'Read and maintain the cross-session memory library — reusable experience from earlier sessions (decisions and their reasons, pitfalls and fixes, reusable commands and processes, state changes). ' +
      'Two modes: ' +
      '`recall` gets memory out — `keywords` searches the whole library and returns whole blocks; `date` (default: today) or `topic` opens one note, and `block:"<breadcrumb>"` narrows it to one block. ' +
      '`remember` puts memory in — `content` creates a note that does not exist yet; to revise an existing note use `old_string`/`new_string` to edit in place (read before modify, exactly like the native file tools). ' +
      '**IMPORTANT safety rule**: once a note has content, `content` is REJECTED — you must use `old_string` to edit in place. `content` on an existing note would overwrite the entire text, which is almost never what you want. ' +
      'Recall rows are addressed by `date` + `workspace` (diary) or `topic` (long term), never by file path: copy them back into `recall` to read a hit in full. Writable notes are today\'s note and `topics/<name>.md`; older diary notes are read-only and retire on their own. ' +
      'What to record: reusable experience only, never play-by-play. ' +
      'Organize under # headings, merge related topics, keep each block concise, and correct outdated statements in place — today\'s note and topic files only; aged diary blocks need no fixing (the window and per-day decay retire them on their own). ' +
      'Topic files hold cross-project evergreen experience (environment/tooling lessons, collaboration preferences, general patterns): one topic per file, update the matching file in place and merge near-duplicates instead of spawning parallel ones.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['recall', 'remember'],
        description: '"recall" (search + read) or "remember" (create / replace / edit in place)',
      },
      keywords: { type: 'string', description: 'recall: up to 5 space-separated search terms, most essential first — earlier terms weigh more; distinctive (rare) terms beat generic ones' },
      date: { type: 'string', description: 'recall: which day\'s note to read, YYYY-MM-DD (default: today)' },
      workspace: { type: 'string', description: 'recall: with `date`, which workspace\'s note to read (a distinguishing fragment of the label in the hit row, e.g. "dsh-memory"); default: this workspace' },
      topic: { type: 'string', description: 'The long-term topic file, short kebab-case (e.g. "windows-env"): recall reads it, remember writes it' },
      block: { type: 'string', description: 'recall: read only the block whose heading breadcrumb matches (e.g. "工具链 > pnpm"), copied from a hit row' },
      content: { type: 'string', description: 'remember: full note text — creates the note only when it does not exist yet; once a note has content, content is rejected (use old_string to edit in place instead)' },
      old_string: { type: 'string', description: 'remember: literal text to replace in place; must match exactly and appear once unless replace_all' },
      new_string: { type: 'string', description: 'remember: replacement text for old_string (an empty string deletes the match)' },
      replace_all: { type: 'boolean', description: 'remember: replace every occurrence instead of requiring uniqueness' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const mode = String(args?.mode ?? '').trim()
      const sessionId = owner(exec)
      if (mode === 'recall') return doRecall(args ?? {}, sessionId, exec)
      if (mode === 'remember') return doRemember(args ?? {}, sessionId, exec)
      throw new Error('memory: mode must be "recall" (search + read) or "remember" (create / replace / edit)')
    },
  }
}

export function apply(ctx) {
  // runtime configuration: seeded with schema defaults, then driven by the
  // `dsh-memory:` section of settings.yaml (hot-reloaded). installSettingsSection
  // waits for the settings service itself (ctx.inject); do NOT gate it on
  // ctx.get('settings') at apply time — the service may mount after this
  // plugin activates, and a skipped registration makes settings.mutate fail
  // with "settings namespace ... is not registered".
  const DEFAULTS = {
    memoryRoot: '',
    searchLimit: 2,
    dailyWindowDays: 45,
    embeddingBaseUrl: '',
    embeddingModel: 'bge-m3',
    autoMemory: true,
    longtermAppend: true,
  }
  const runtime = { ...DEFAULTS }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
      runtime.memoryRoot = String(source.memoryRoot ?? '').trim()
      runtime.searchLimit = source.searchLimit
      runtime.dailyWindowDays = Math.max(0, Math.floor(Number(source.dailyWindowDays) || 0))
      runtime.embeddingBaseUrl = source.embeddingBaseUrl ?? ''
      runtime.embeddingModel = source.embeddingModel || 'bge-m3'
      runtime.autoMemory = source.autoMemory !== false
      runtime.longtermAppend = source.longtermAppend !== false
    }
    // setSource hands over a THUNK (() => scope.get()), not the value; it
    // fires at attach/detach, while every committed change goes through
    // onChange — both must mirror into runtime or settings.yaml edits (and
    // card saves) never take effect until restart.
    //
    // The `entry` argument IS the settings `base` layer (2026-09-01, bug fix):
    // an empty object made the browser snapshot's `base` empty, so the card's
    // "Reset to default" staged an EMPTY text and the field appeared blank
    // (the official plugins pass their full defaults here — their reset works
    // because base carries every field). DEFAULTS is the same object the
    // runtime seeds with, and resolve() folds it under the user layer, so
    // passing it changes nothing about the resolved values.
    let getSource = () => runtime
    installSettingsSection(ctx, NS, Config, DEFAULTS, {
      setSource: (get) => {
        getSource = get
        applySource(get())
      },
      onChange: () => applySource(getSource()),
    })
  }

  const getConfig = () => runtime

  // lazy vector index: null until embeddingBaseUrl is configured; recreated
  // when the base URL, model, or memory root changes (hot-reload safe)
  let vectorIndex = null
  const getVectorIndex = () => {
    if (!runtime.embeddingBaseUrl) return null
    const base = memoryRoot(runtime.memoryRoot)
    if (
      vectorIndex === null ||
      vectorIndex.baseUrl !== runtime.embeddingBaseUrl ||
      vectorIndex.model !== runtime.embeddingModel ||
      vectorIndex.root !== base
    ) {
      vectorIndex = new VectorIndex(new EmbeddingClient(runtime.embeddingBaseUrl, runtime.embeddingModel), {
        // persisted signature-keyed vector cache next to the corpus: kills the
        // full-corpus rebuild on the first search after a dsh restart (the
        // cache file sits at the memory root, invisible to walkMemory)
        cachePath: join(base, '.vector-cache.json'),
      })
      vectorIndex.baseUrl = runtime.embeddingBaseUrl
      vectorIndex.model = runtime.embeddingModel
      vectorIndex.root = base
    }
    return vectorIndex
  }

  // Per-turn capture reminder (restored 2026-08-29, user decision — the
  // AGENTS.md externalization experiment is abandoned): a runtime-context
  // contribution assembled fresh on every model request. Deliberately SHORT
  // — timing only ("worth keeping in this turn → you MUST use the memory
  // tool"); the usage mechanics and organization rules live in the memory
  // tool description, which rides the tool schema on every request. Gated on
  // config autoMemory (empty text is dropped from the rendered snapshot) and
  // on subagents (delegationDepth > 0): their memory belongs to the main
  // agent's consolidation.
  ctx.effect(() => {
    const fiber = ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'dsh-memory:auto',
        order: 200,
        text: (context) => {
          if (!runtime.autoMemory) return ''
          const session = context.agent?.session
          if (!session?.id) return ''
          if ((session.header?.delegationDepth ?? 0) > 0) return ''
          return 'When this turn produced something worth keeping across sessions, you MUST use the `memory` tool.'
        },
      })
    })
    return () => fiber.dispose()
  })

  // Model tool: the single two-mode `memory` tool (recall = search + read,
  // remember = create / replace / edit; the description carries the usage
  // mechanics and organization rules). No host hooks.
  ctx.tools.register(defineTool(memoryTool(getConfig, getVectorIndex)))
}

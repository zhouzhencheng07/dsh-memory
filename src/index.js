// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes under
// $DSH_HOME/dsh-memory/YYYY-MM-DD/, long-term topic files under
// $DSH_HOME/dsh-memory/memory/, and memory search.
//
// Design (agreed with the user, 2026-08-16..28):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive. FINAL capture mechanism (2026-08-29, user
//     decision — the 2026-08-28 AGENTS.md externalization experiment is
//     ABANDONED: usage rules kept leaking into the user-curated file and it
//     put a curation burden on the user): the per-turn reminder is BACK and
//     stays SHORT — timing only ("worth keeping in this turn → MUST use the
//     memory tool", gated on `autoMemory`, subagents excluded) — while usage
//     mechanics AND organization rules (what to record, # headings, merge,
//     in-place correction) live in the memory tool description. Long-term
//     filing is NEVER pre-judged at capture: it follows the memory_search
//     result composition (see the retrieval bullet).
//   - retrieval: memory_search over the corpus (block-level; POSITIONAL
//     keyword scoring 2026-08-25 — ONE `keywords` parameter of up to 7
//     terms, first 3 ×3 then next 4 ×1, partial credit per matched keyword,
//     no hard AND gate, MIN_SCORE floor — plus optional vector,
//     recency-weighted). Long-term guidance is COMPOSITION-DRIVEN since
//     2026-08-29: the output ends with a hint branched on the result
//     composition — a memory/ block among the hits ⇒ treat as
//     authoritative / fix in place / merge overlapping topic files; none ⇒
//     file proved-lasting facts into memory/<topic>.md via the memory tool.
//     Promotion happens at reuse time and is never pre-judged at capture
//     (user decision: 被搜到才说明值得长存). Long-term append seat
//     (2026-08-25): when no long-term block made the cut, the best-ranking
//     one from the candidate pool is APPENDED after the regular results
//     (config `longtermAppend`, additive — never evicts); it also flips the
//     hint branch.
//   - long-term layer = FREE TOPIC FILES (2026-08-28, user decision):
//     memory/<topic>.md, one file per topic. walkMemory already indexes any
//     non-date subdirectory (never windowed, never decayed), so this needed
//     zero search changes. The earlier single memory/memory.md design
//     (2026-08-24) never shipped — the file was never created, so there is
//     nothing to migrate. Durable project-specific facts have no layer by
//     design: they graduate into the user's AGENTS.md or die in the 90-day
//     diary window (accepted trade-off, forces curation).
//   - the `memory` tool (2026-08-28, user decision — replaces the 2026-08-23
//     path locator): a THREE-MODE file tool mirroring the native read/write/
//     edit contract. No arguments reads TODAY's note (ABSENT output lists
//     existing topics); mode:"write" creates or fully replaces; mode:"edit"
//     replaces a unique literal old_string; an optional `topic` parameter
//     targets memory/<topic>.md. The observation guard mirrors
//     @deepseek-ai/dsh-fs-observation-policy semantics (per-session
//     present/absent + version records; write refused on exists-unread and
//     stale-version; edit refused when unread; unique-match enforcement).
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
//     supplies content while paths are derived (today's note) or whitelisted
//     (topic regex, containment under memoryRoot()). Capture now works in
//     every permission mode. Session provenance comments were REMOVED with
//     the locator (2026-08-28): they existed for a conversation-replay tool
//     that was judged not worth building (daily notes suffice; replaying
//     whole sessions wastes context).
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / dailyWindowDays / embeddingBaseUrl / embeddingModel /
//     autoMemory / longtermAppend), see README.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/*` resolves at runtime
// through Node's parent-walk (the harness installs them in the profile
// fallback node_modules).

import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRoot, sessionSlug, todayStamp, walkMemory } from './store.js'
import { formatHits, fuseHits, parseKeywords, searchMemory } from './search.js'
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
  /** Default result count for memory_search. */
  searchLimit: z.natural().min(1).max(10).default(5),
  /** Hard window in days for the DAILY notes (user decision 2026-08-24):
   * dated notes older than this leave the searchable corpus (files stay on
   * disk). 0 disables the window. Long-term topic files (memory/) are never
   * windowed and never decay. */
  dailyWindowDays: z.natural().default(90),
  /** Ollama base URL for optional vector search (e.g. http://localhost:11434); empty disables it. */
  embeddingBaseUrl: z.string(),
  /** Embedding model served by embeddingBaseUrl. */
  embeddingModel: z.string().default('bge-m3'),
  /** Per-turn system-prompt reminder ("use the memory tool when something is
   * worth keeping"); off = no reminder, the memory tool remains usable. */
  autoMemory: z.boolean().default(true),
  /** Long-term append seat (2026-08-25): when no memory/ block made the
   * results, the best-ranking one from the candidate pool is APPENDED after
   * them (never evicting a regular result). Off = pure top-N. */
  longtermAppend: z.boolean().default(true),
})

const MAX_LIMIT = 10

/** Long-term topic directory prefix (rel paths like `memory/<topic>.md`). */
const LONGTERM_DIR_PREFIX = 'memory/'

/** Write cap: memory files are small curated notes; refuse runaway content. */
const MAX_WRITE_BYTES = 1024 * 1024
/** Read display cap, mirroring store.readMemoryFile's indexing cap. */
const MAX_READ_BYTES = 2 * 1024 * 1024
/** Guard bookkeeping cap: beyond this many sessions, drop the oldest
 * session's observation records (plugin code cannot weakly observe session
 * disposal, so the map needs an explicit bound). */
const MAX_TRACKED_SESSIONS = 256

function memorySearchTool(ctx, getConfig, getVectorIndex) {
  return {
    name: 'memory_search',
    description:
      'Search the cross-session memory library by literal keyword matching with partial credit per matched keyword. ' +
      '`keywords` holds up to 7 space-separated terms, most essential FIRST — earlier terms weigh more; pick words the notes actually contain, not synonyms. ' +
      'Returns block-level hits whose snippet is the whole block; low-scoring hits are dropped. ' +
      'When a hit is not enough on its own, open its source file and continue from the matching block.',
    parameters: {
      keywords: { type: 'string', required: true, description: 'Up to 7 space-separated terms, most essential first — earlier terms weigh more' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const kw = parseKeywords(String(args.keywords ?? ''))
      if (kw.primary.length === 0 && kw.secondary.length === 0) throw new Error('memory_search: no usable keywords')
      // Result count is locked to the configured searchLimit (user decision
      // 2026-08-22): no agent-facing override.
      const limit = Math.min(Math.max(Number(getConfig().searchLimit) || 5, 1), MAX_LIMIT)
      const windowDays = Math.max(0, Math.floor(Number(getConfig().dailyWindowDays) || 0))
      const entries = walkMemory(windowDays)
      // gather a candidate pool several times the result window so fusion and
      // the long-term append seat have room to rank
      const poolSize = Math.min(limit * 3, MAX_LIMIT * 3)
      const sub = searchMemory(entries, kw.primary, kw.secondary, poolSize)
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
      const isLongterm = (h) => String(h?.rel ?? '').startsWith(LONGTERM_DIR_PREFIX)
      if (getConfig().longtermAppend !== false && hits.length > 0 && !hits.some(isLongterm)) {
        const reserve = ranked.slice(limit).find(isLongterm)
        if (reserve) hits.push(reserve)
      }
      // rows carry ABSOLUTE file paths — the agent cannot be assumed to know
      // $DSH_HOME/dsh-memory, so hits must be directly usable with the
      // memory tool's topic targeting or its read output
      let out = formatHits(hits, memoryRoot())
      // tell the calling model when its input was trimmed, so the next call
      // respects the cap (keywords ≤ 7)
      if (kw.notices.length > 0) out = `${kw.notices.join('; ')}\n${out}`
      // Long-term guidance is COMPOSITION-DRIVEN (2026-08-29, user decision):
      // promotion into the topic files happens at REUSE time — the result set
      // itself decides which hint the model sees, instead of the agent
      // pre-judging at capture time (被搜到才说明值得长存). The append seat
      // above participates: an appended long-term block flips the branch.
      // Empty results carry no hint — there is nothing above to file.
      if (hits.length > 0) {
        out += hits.some(isLongterm)
          ? '\nLong-term topic blocks above are authoritative (never windowed) — correct outdated statements in their topic files in place, and merge topic files that clearly overlap.'
          : '\nIf a fact above proved worth keeping long term, file it via the memory tool into memory/<topic>.md — update the matching topic file, or start a new one when none matches.'
      }
      return out
    },
  }
}

/**
 * The three-mode `memory` file tool (2026-08-28, user decision): a
 * native-read/write/edit-shaped mechanism confined to this plugin's data
 * root. See the module header for why it writes via node:fs directly
 * instead of dispatching the native tools.
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
function memoryFileTool() {
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

  const STALE = (file) => `memory: "${file}" changed since it was read — read it again (no-arg memory or mode:"read")`

  /** Content changed under an unchanged size within one mtime tick is not
   * worth a hash: memory notes grow when edited, so size catches the
   * realistic races; the CAS exists to force a re-read, not to be a lock. */

  /** Publish atomically: same-directory temp file + rename, so a crash or
   * concurrent reader never observes a half-written note. */
  function atomicWrite(file, content) {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  }

  /** Long-term topic names currently on disk (empty when the dir is absent). */
  function listTopics() {
    try {
      return readdirSync(join(memoryRoot(), 'memory'))
        .filter((n) => n.endsWith('.md'))
        .map((n) => n.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }

  const TOPIC_RE = /^[\p{L}\p{N}_-]+$/u

  /** Today's note by default; `topic` targets the long-term library file.
   * The regex plus the join keep every reachable path strictly inside
   * memoryRoot() — the model only ever supplies a single safe segment. */
  function resolveTarget(args, exec) {
    const topic = String(args?.topic ?? '').trim()
    if (!topic) return join(memoryRoot(), todayStamp(), `${sessionSlug(exec?.agent?.session?.header?.cwd)}.md`)
    if (!TOPIC_RE.test(topic)) throw new Error(`memory: invalid topic "${topic}" — letters, digits, "-" or "_" only`)
    return join(memoryRoot(), 'memory', `${topic}.md`)
  }

  function doRead(file, sessionId, withTopics) {
    const info = statInfo(file)
    if (!info) {
      record(sessionId, file, 'absent')
      let out = `ABSENT ${file} — create it with memory {mode:"write", content:"<full note text>"}`
      if (withTopics) {
        const topics = listTopics()
        out += topics.length > 0
          ? `\nExisting long-term topics: ${topics.join(', ')} (target with topic:"<name>")`
          : '\nLong-term topic files live under memory/<topic>.md (target with topic:"<name>")'
      }
      return out
    }
    if (info.size > MAX_READ_BYTES) {
      record(sessionId, file, 'present')
      return `${file} · too large to display (${info.size} bytes) — trim it down before further edits`
    }
    const text = readFileSync(file, 'utf8')
    record(sessionId, file, 'present')
    return `${file}\n\n${text}\n\n— maintain with memory {mode:"edit", old_string, new_string} or {mode:"write", content} (full replace)`
  }

  function doWrite(file, content, sessionId) {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) throw new Error(`memory: content is ${bytes} bytes — the ${MAX_WRITE_BYTES}-byte cap keeps notes curated; split the content across topic files`)
    const current = statInfo(file)
    const seen = prior(sessionId, file)
    if (current) {
      if (!seen || seen.kind === 'absent') {
        throw new Error(`memory: "${file}" ${seen ? 'appeared since it was read as absent' : 'already exists'} — read it first (no-arg memory or mode:"read")`)
      }
      if (seen.mtimeMs !== current.mtimeMs || seen.size !== current.size) throw new Error(STALE(file))
    }
    atomicWrite(file, content)
    record(sessionId, file, 'present')
    return `${file} · ${current ? 'replaced' : 'created'} (${bytes} bytes)`
  }

  function doEdit(file, args, sessionId) {
    if (typeof args?.old_string !== 'string' || args.old_string.length === 0) {
      throw new Error('memory: mode:"edit" requires a non-empty old_string (new_string defaults to "")')
    }
    const newValue = args?.new_string == null ? '' : String(args.new_string)
    const current = statInfo(file)
    const seen = prior(sessionId, file)
    if (!current) {
      throw new Error(`memory: cannot edit "${file}": ${seen ? 'not found' : 'edit requires reading it first (no-arg memory or mode:"read")'}`)
    }
    if (!seen || seen.kind === 'absent') {
      throw new Error(`memory: "${file}" ${seen ? 'appeared since it was read as absent' : 'was never read this session'} — read it before editing`)
    }
    if (seen.mtimeMs !== current.mtimeMs || seen.size !== current.size) throw new Error(STALE(file))
    const text = readFileSync(file, 'utf8')
    const count = text.split(args.old_string).length - 1
    if (count === 0) throw new Error(`memory: old_string not found in "${file}" — copy it exactly from the read output`)
    const replaceAll = args?.replace_all === true
    if (count > 1 && !replaceAll) {
      throw new Error(`memory: ${count} occurrences of old_string in "${file}" — it must be unique, or pass replace_all:true`)
    }
    atomicWrite(file, replaceAll ? text.replaceAll(args.old_string, newValue) : text.replace(args.old_string, newValue))
    record(sessionId, file, 'present')
    return `${file} · edited (${count} occurrence${count === 1 ? '' : 's'} replaced)`
  }

  return {
    name: 'memory',
    description:
      "Read and maintain this plugin's memory files under $DSH_HOME/dsh-memory. " +
      "No arguments reads TODAY's note for this workspace and returns its full text (ABSENT when there is none yet). " +
      'mode:"write" creates or fully replaces a file with content (refused when the file exists but was not read this session, or changed since that read). ' +
      'mode:"edit" replaces a literal old_string with new_string (read the file first; old_string must appear exactly once unless replace_all). ' +
      "The optional topic parameter targets the long-term library file memory/<topic>.md instead of today's note. " +
      'Read before modify, exactly like the native file tools. ' +
      'What to record: reusable experience only, never play-by-play — decisions and their reasons, pitfalls and fixes, reusable commands and processes, state changes; ' +
      'organize under # headings, merge related topics, keep each block concise, and correct outdated statements in place. ' +
      'Topic files hold cross-project evergreen experience (environment/tooling lessons, collaboration preferences, general patterns): one topic per file, update the matching file in place and merge near-duplicates instead of spawning parallel ones.',
    parameters: {
      mode: { type: 'string', description: '"read" (default), "write" or "edit"' },
      topic: { type: 'string', description: 'Target the long-term topic file memory/<topic>.md instead of today\'s note (short kebab-case names, e.g. "windows-env")' },
      content: { type: 'string', description: 'Full note text for mode:"write"' },
      old_string: { type: 'string', description: 'Literal text to replace for mode:"edit"; must match exactly and appear once unless replace_all' },
      new_string: { type: 'string', description: 'Replacement text for mode:"edit" (an empty string deletes the match)' },
      replace_all: { type: 'boolean', description: 'mode:"edit": replace every occurrence instead of requiring uniqueness' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const mode = String(args?.mode ?? 'read')
      const sessionId = owner(exec)
      const file = resolveTarget(args, exec)
      if (mode === 'read') return doRead(file, sessionId, args?.topic == null)
      if (mode === 'write') return doWrite(file, String(args?.content ?? ''), sessionId)
      if (mode === 'edit') return doEdit(file, args ?? {}, sessionId)
      throw new Error(`memory: unknown mode "${mode}" — use "read" (default), "write" or "edit"`)
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
    searchLimit: 5,
    dailyWindowDays: 90,
    embeddingBaseUrl: '',
    embeddingModel: 'bge-m3',
    autoMemory: true,
    longtermAppend: true,
  }
  const runtime = { ...DEFAULTS }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
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
    let getSource = () => runtime
    installSettingsSection(ctx, NS, Config, {}, {
      setSource: (get) => {
        getSource = get
        applySource(get())
      },
      onChange: () => applySource(getSource()),
    })
  }

  const getConfig = () => runtime

  // lazy vector index: null until embeddingBaseUrl is configured; recreated
  // when the base URL or model changes (hot-reload safe)
  let vectorIndex = null
  const getVectorIndex = () => {
    if (!runtime.embeddingBaseUrl) return null
    if (
      vectorIndex === null ||
      vectorIndex.baseUrl !== runtime.embeddingBaseUrl ||
      vectorIndex.model !== runtime.embeddingModel
    ) {
      vectorIndex = new VectorIndex(new EmbeddingClient(runtime.embeddingBaseUrl, runtime.embeddingModel))
      vectorIndex.baseUrl = runtime.embeddingBaseUrl
      vectorIndex.model = runtime.embeddingModel
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

  // Model tools: memory_search (retrieval with composition-driven long-term
  // guidance) + the three-mode `memory` file tool (native-shaped
  // read/write/edit confined to the plugin data root; description carries
  // the usage mechanics and organization rules). No host hooks.
  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
    memoryFileTool(),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }
}

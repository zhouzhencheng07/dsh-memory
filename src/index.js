// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes under
// $DSH_HOME/dsh-memory/YYYY-MM-DD/, the long-term memory/memory.md, and
// memory search.
//
// Design (agreed with the user, 2026-08-16/17/18/22/25):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive; project detail lives in the workspace docs.
//   - retrieval: memory_search over the daily notes (block-level;
//     POSITIONAL keyword scoring 2026-08-25 — ONE `keywords` parameter of up
//     to 7 terms, first 3 ×3 then next 4 ×1, partial credit per matched
//     keyword, no hard AND gate, MIN_SCORE floor — plus optional vector,
//     recency-weighted). Long-term etiquette 2026-08-25: whenever results
//     came back, ONE unconditional hint points lasting-fact writes at
//     memory/memory.md; and when no long-term block made the cut, the best
//     ranking one from the candidate pool is APPENDED after the regular
//     results (config `longtermAppend`, additive — never evicts). The
//     digest/dream layer was REMOVED
//     (2026-08-18, user decision): memory notes are edited in place and carry
//     their date in the rel, so recency guidance ("newer notes win conflicts,
//     older notes still hold details") plus a recency decay in ranking covers
//     the old digest's convergence job; the digest/ and dream/ directories
//     were deleted, the memory/ sublevel was merged into the plugin root.
//   - capture (2026-08-23, user decision, final revision): NO host hooks and
//     NO end-of-turn reminder hook. Two layers only:
//       a) a per-turn system-prompt reminder (context contribution
//          `dsh-memory:auto`, order 200, gated on config `autoMemory`,
//          subagents excluded): its text is deliberately SHORT — "when this
//          turn produced something worth keeping across sessions, you MUST
//          use the memory tool" — the timing detail, the content rules, and
//          the usage (native read/write/edit) all live in the `memory` tool
//          description, which rides the tool schema on every request.
//          `autoMemory: false` removes the reminder: the tool stays usable
//          (neutral description, no "must" wording) for users who prefer to
//          record rarely or only when asked.
//       b) ONE path-locating tool `memory`: no arguments; returns TODAY's
//          memory file for the calling workspace. When the file is absent it
//          is CREATED (content = the provenance comment) and when present
//          the calling session id is merged into the leading
//          `<!-- 会话来源: ... -->` comment (exactly idempotent). All file
//          work dispatches the host's NATIVE read/write through
//          `ctx.tools.execute()`, so every dsh mechanism applies honestly:
//          the fs observation policy (read-before-modify) gates the merge
//          write exactly as for the native tools, and the sandbox fence
//          applies honestly: memory capture needs danger-full-access, like
//          any native $DSH_HOME write. After the tool returns the path, the
//          agent maintains the note with its own native read/edit/write
//          tools — provenance is NOT re-merged afterwards (a session that
//          knows the path has already called the tool, so its id is already
//          in the comment; no hook needed, user decision).
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / embeddingBaseUrl / embeddingModel / autoMemory), see
//     README.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/*` resolves at runtime
// through Node's parent-walk (the harness installs them in the profile
// fallback node_modules).

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { memoryRoot, mergeProvenance, readMemoryFile, sessionSlug, todayStamp, walkMemory } from './store.js'
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
   * disk). 0 disables the window. The long-term memory/memory.md is never
   * windowed and never decays. */
  dailyWindowDays: z.natural().default(90),
  /** Ollama base URL for optional vector search (e.g. http://localhost:11434); empty disables it. */
  embeddingBaseUrl: z.string(),
  /** Embedding model served by embeddingBaseUrl. */
  embeddingModel: z.string().default('bge-m3'),
  /** Per-turn system-prompt reminder ("use the memory tool when something is
   * worth keeping"); off = no reminder, the neutral memory tool remains. */
  autoMemory: z.boolean().default(true),
  /** Long-term append seat (2026-08-25): when no memory/ block made the
   * results, the best-ranking one from the candidate pool is APPENDED after
   * them (never evicting a regular result). Off = pure top-N. */
  longtermAppend: z.boolean().default(true),
})

const MAX_LIMIT = 10

/** Long-term memory file (single, topic-heading organized — user decision
 * 2026-08-24). Lives under its own non-date subdirectory: never windowed,
 * never decayed. Created by the AGENT on first promotion (native write) —
 * the `memory` tool stays a single-path daily locator by design. */
const LONGTERM_REL = 'memory/memory.md'
const LONGTERM_DIR_PREFIX = 'memory/'

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
      // tell the calling model when its input was trimmed, so the next call
      // respects the cap (keywords ≤ 7); rows carry ABSOLUTE file paths —
      // the agent cannot be assumed to know $DSH_HOME/dsh-memory, so both
      // the hits and the long-term target below must be directly usable
      // with its native read/edit tools
      const rootDir = memoryRoot()
      let out = formatHits(hits, rootDir)
      if (kw.notices.length > 0) out = `${kw.notices.join('; ')}\n${out}`
      // One unconditional success hint (2026-08-25, simplifies the 2026-08-24
      // composition-based branches): ANY non-empty result ends with the same
      // pointer to the long-term file — record lasting facts there, fix stale
      // ones. No results → no hint. The path is ABSOLUTE: a bare
      // `memory/memory.md` would not resolve for the calling model.
      if (hits.length > 0) {
        const ltAbs = `${String(rootDir).replaceAll('\\', '/').replace(/\/+$/, '')}/memory/memory.md`
        out += `\nNote: add factual information referenced above that will be reused long term to the matching topic heading in ${ltAbs} (read before edit); fix outdated statements there.`
      }
      return out
    },
  }
}

/**
 * The path-locating `memory` tool (2026-08-23, user decision): NO arguments —
 * it returns the calling workspace's TODAY memory file. When the file is
 * absent it is CREATED (content = the provenance comment); when present the
 * calling session id is merged into the leading `<!-- 会话来源: ... -->`
 * comment (exactly idempotent — no write when the id is already there). All
 * file work dispatches the host's NATIVE read/write through
 * `ctx.tools.execute()`: the probe read records the observation so the merge
 * write passes the version guard (replaceIfVersion on an existing file,
 * createIfAbsent on a new one), and the sandbox fence applies honestly. The
 * agent then maintains the note with its own native read/edit/write tools;
 * provenance is NOT re-merged afterwards — a session that knows the path has
 * already called this tool, so its id is already in the comment.
 */
function memoryLocatorTool(ctx) {
  let subSeq = 0

  /** Dispatch one native tool call through the real registry pipeline. */
  async function dispatch(name, arguments_, exec) {
    const input = {
      callId: CallId(`${String(exec.callId)}:memory:${++subSeq}`),
      rootCallId: exec.rootCallId,
      name,
      arguments: arguments_,
      ...(exec.agent ? { agent: exec.agent } : {}),
      parent: exec.token,
      signal: exec.signal,
    }
    const result = await ctx.tools.execute(input)
    if (result.isError) {
      const message = result.error?.message ?? String(result.error ?? 'unknown error')
      throw new Error(`memory: ${message}`)
    }
    return result.value
  }

  /** Today's memory file for the calling session. */
  function dailyFile(exec) {
    return join(memoryRoot(), todayStamp(), `${sessionSlug(exec?.agent?.session?.header?.cwd)}.md`)
  }

  return {
    name: 'memory',
    description:
      "Returns today's cross-session memory note path for this workspace, creating it with a session-source comment when missing. " +
      'Maintain the note with the native read/write/edit tools (read before modify): record only experience worth reusing across sessions — decisions and reasons, preferences, pitfalls and fixes, reusable commands; organize under # headings, keep each block concise and split long content under deeper headings, merge related topics, and correct outdated statements in place.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const file = dailyFile(exec)
      const sessionId = exec?.agent?.session?.id
      // Probe read first: success records the observation (so a merge write on
      // an existing file passes replaceIfVersion); failure (ENOENT) means the
      // file is absent and the write below goes createIfAbsent.
      let existed = true
      try {
        await dispatch('read', { file_path: file }, exec)
      } catch {
        existed = false
      }
      const current = existed ? readMemoryFile(file) : null
      const { text, changed } = mergeProvenance(sessionId ? current ?? '' : '', sessionId)
      if (!existed || changed) {
        await dispatch('write', { file_path: file, content: text }, exec)
      }
      return `${file} · ${existed ? 'existing' : 'created'} — maintain with native read/edit/write (read before modify)`
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

  // Per-turn capture reminder (2026-08-23, restored from git history with a
  // SHORT text — the timing detail, content rules, and usage live in the
  // memory tool description): a runtime-context contribution assembled fresh
  // on every model request. Deliberately short: "worth keeping in this turn →
  // you MUST use the memory tool". Gated on config autoMemory (empty text is
  // dropped from the rendered snapshot) and on subagents (delegationDepth >
  // 0): their memory belongs to the main agent's consolidation.
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

  // Model tools: memory_search (retrieval) + the path-locating `memory` tool
  // (returns today's note path; creates/provenance-tags it; the agent then
  // maintains the note with native read/edit/write). No host hooks.
  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
    memoryLocatorTool(ctx),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }
}
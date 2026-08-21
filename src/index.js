// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes under
// $DSH_HOME/dsh-memory/YYYY-MM-DD/, and memory search.
//
// Design (agreed with the user, 2026-08-16/17/18):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive; project detail lives in the workspace docs.
//   - retrieval: memory_search over the daily notes (block-level, substring +
//     optional vector, recency-weighted). The digest/dream layer was REMOVED
//     (2026-08-18, user decision): memory notes are edited in place and carry
//     their date in the rel, so recency guidance ("newer notes win conflicts,
//     older notes still hold details") plus a recency decay in ranking covers
//     the old digest's convergence job; the digest/ and dream/ directories
//     were deleted, the memory/ sublevel was merged into the plugin root.
//   - memory is written by the MAIN AGENT inside the conversation: while
//     autoMemory is on, the plugin contributes a system-prompt section
//     (assembled fresh per request) that reminds the agent every turn to
//     judge and, when worth it, capture via the host-side `memory_write`
//     tool (upserts one `# ` section into the workspace daily memory file).
//     The daily path is computed at assembly time, so crossing midnight
//     switches days on its own — no turn counting. No background LLM call,
//     no manual command (the per-turn reminder IS the capture path).
//     (2026-08-22, user decision: the original "agent writes with its own
//     read/edit/write tools" design died on the sandbox — $DSH_HOME sits
//     outside the session workspace, so workspace-write denied every write
//     and approval=never removed the escalation path. memory_write executes
//     in the plugin host process over node:fs, never through ctx.fs, so all
//     three sandbox modes behave identically.)
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / embeddingBaseUrl / embeddingModel / autoMemory), see
//     README.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/dsh-tools` and the settings
// helpers resolve at runtime through Node's parent-walk (the harness installs
// them in the profile fallback node_modules).

import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installAutoMemory } from './auto.js'
import { sessionSlug, todayStamp, upsertSections, walkMemory } from './store.js'
import { formatHits, fuseHits, searchMemory } from './search.js'
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
  /** Ollama base URL for optional vector search (e.g. http://localhost:11434); empty disables it. */
  embeddingBaseUrl: z.string(),
  /** Embedding model served by embeddingBaseUrl. */
  embeddingModel: z.string().default('bge-m3'),
  /** Per-turn automatic memory: on = a system-prompt section reminds the agent every turn to judge and write; off = no reminder. */
  autoMemory: z.boolean().default(true),
})

const MAX_LIMIT = 10

function memorySearchTool(ctx, getConfig, getVectorIndex) {
  return {
    name: 'memory_search',
    description:
      'Search the memory library: daily notes (memory/) only. ' +
      'Returns BLOCK-level hits: rel carries the multi-level breadcrumb (file#主题 > 小节 > 子节, any heading level starts its own block), and each snippet is the WHOLE block text (up to ~1000 chars) — ' +
      'usually enough to continue without opening the file; read the source only when the block is truncated or more context is needed. ' +
      'The rel embeds the note date (YYYY-MM-DD/...): when several hits bear on the same topic, prefer the NEWER note (it reflects the latest state); ' +
      'an older note may still hold details the new one dropped — merge them rather than trusting either alone. ' +
      'Ranking already discounts older notes (recency decay), so older but still relevant blocks remain reachable. ' +
      'When embeddingBaseUrl is configured, vector search is fused with keyword hits automatically (unified RRF score).',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords (Chinese or English, substring match)' },
      limit: { type: 'number', description: 'Max results, default from config searchLimit' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('memory_search: query is empty')
      const defaultLimit = getConfig().searchLimit
      const limit = Math.min(Math.max(Number(args.limit) || defaultLimit, 1), MAX_LIMIT)
      const entries = walkMemory()
      // gather extra candidates from each signal so the fusion has room to rank
      const sub = searchMemory(entries, query, Math.min(limit * 3, MAX_LIMIT * 3))
      let hits = sub.slice(0, limit)
      const index = getVectorIndex()
      if (index !== null) {
        try {
          const vec = await index.query(entries, query, limit * 3)
          hits = fuseHits(sub, vec, limit)
        } catch (error) {
          // vector search is best-effort: a broken embedding service falls
          // back to pure substring results instead of failing the tool
          console.warn(`dsh-memory: vector search unavailable (${error?.message ?? String(error)}), using substring results`)
        }
      }
      return formatHits(hits)
    },
  }
}

/**
 * The model-facing capture path: upserts one `# ` section into today's daily
 * memory file. Executes in the plugin host process (node:fs via store.js,
 * never through ctx.fs), so it is unaffected by the agent file sandbox — the
 * whole reason it exists (2026-08-22).
 */
function memoryWriteTool() {
  return {
    name: 'memory_write',
    description:
      'Upsert one first-level `# ` section into TODAY\'s cross-session memory note for this workspace. ' +
      'The per-turn 【自动记忆】 reminder names this tool as the capture path: call it once per section worth keeping. ' +
      'A new title appends a new section; an existing title is overwritten by content (mode replace, default — use it to correct or update stale notes) or extended with it (mode append). ' +
      'Content goes in verbatim as markdown (`##`/`###` sub-headings allowed); never include dates/timestamps; ' +
      'the leading provenance comment is maintained automatically.',
    parameters: {
      title: { type: 'string', required: true, description: "First-level `# ` section title (the topic, e.g. 'dsh-kit 文件树 v0.2')" },
      content: { type: 'string', required: true, description: 'Markdown body of the section; may contain ## sub-headings; verbatim, no dates/timestamps' },
      mode: { type: 'string', description: "'replace' (default): overwrite the existing section body with content; 'append': add content to its end" },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '').trim()
      if (!title) throw new Error('memory_write: title is empty')
      if (!content) throw new Error('memory_write: content is empty')
      const mode = args.mode === 'append' ? 'append' : 'replace'
      const session = exec?.agent?.session
      const result = await upsertSections(
        todayStamp(),
        sessionSlug(session?.header?.cwd),
        [{ title, content, mode }],
        { sourceSessionId: session?.id },
      )
      const action = result.created ? 'created' : result.changed ? mode + 'd' : 'unchanged'
      return `${result.file} · # ${title} · ${action} (${result.sections} sections)`
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
    embeddingBaseUrl: '',
    embeddingModel: 'bge-m3',
    autoMemory: true,
  }
  const runtime = { ...DEFAULTS }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
      runtime.searchLimit = source.searchLimit
      runtime.embeddingBaseUrl = source.embeddingBaseUrl ?? ''
      runtime.embeddingModel = source.embeddingModel || 'bge-m3'
      runtime.autoMemory = source.autoMemory !== false
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

  // Model tools: memory_search (retrieval) + memory_write (the capture path —
  // host-side write, sandbox-proof since 2026-08-22; no Dream layer).
  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
    memoryWriteTool(),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }

  // Auto-Memory: a per-turn system-prompt reminder (autoMemory on); the main
  // agent writes the daily memory file with its own read/edit/write tools.
  // No background LLM call, no turn counting, no manual command.
  ctx.effect(() => installAutoMemory(ctx, getConfig))
}

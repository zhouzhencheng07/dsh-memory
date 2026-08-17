// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes (memory/), Dream digest
// buckets (digest/), and memory search.
//
// Design (agreed with the user, 2026-08-16/17):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive; project detail lives in the project's AGENTS.md
//     and project docs.
//   - retrieval layers: digest library (refined) -> memory (daily notes).
//     (session_search was removed 2026-08-17: raw conversations are no
//     longer searchable through this plugin.)
//   - memory is written by the MAIN AGENT inside the conversation: while
//     autoMemory is on, the plugin contributes a system-prompt section
//     (assembled fresh per request) that reminds the agent every turn to
//     judge and, when worth it, incrementally write the workspace daily
//     memory file with its own read/edit/write tools (write only when the
//     file does not exist; edit otherwise). The daily path is computed at
//     assembly time, so crossing midnight switches days on its own — no turn
//     counting. No background LLM call, no dedicated write tool, no manual
//     command (the per-turn reminder IS the capture path). (A background
//     pipeline was tried and failed: hand-built requests broke provider
//     pairing -> 400, and reasoning-max models answered nothing. The
//     conversation loop assembles valid requests.)
//   - Dream V2 (2026-08-17): scheduled daily when dreamTime is set; the /dream
//     command and memory_dream tool were REMOVED (user decision — the
//     mechanism is now a dedicated dream/ workspace where every pass runs as a
//     background agent conversation the user can inspect in the UI). Each pass
//     collects the notes of today+yesterday, filters them by a source-level
//     watermark catalog (digest/.catalog.json, {note rel: mtime}), and if
//     anything changed launches ONE background agent session through the
//     agents service (no parent required — the same path dsh-headless uses),
//     bound to the dream workspace cwd, mounted on the dedicated `dream`
//     agent preset (file tools + danger-full-access). The session reads the
//     notes and existing digests with its own tools and writes/updates digest
//     files under digest/{personal,procedure,wiki}/<topic>.md itself; the
//     plugin then validates the writes (provenance/Related hygiene, safe
//     paths) and checkpoints the handled notes in the catalog. The session
//     model is the agent default selection (config.model override removed).
//   - layout (user decision 2026-08-17): one plugin data root
//     $DSH_HOME/dsh-memory/ holding memory/ (notes), digest/ (refined
//     library, renamed from the former $DSH_HOME/dream directory), and dream/
//     (Dream session workspace). The legacy $DSH_HOME/dream/ library stays on
//     disk untouched for manual comparison but is NOT indexed: all queries
//     and Dream runs see only the new layout.
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / dreamTime / embeddingBaseUrl / embeddingModel /
//     autoMemory), see README. dreamTime non-empty = Dream timer on;
//     autoMemory true = per-turn reminder on. The Dream model override
//     (config.model) was REMOVED 2026-08-17: every Dream session now uses the
//     agent default selection — the `dream` preset session is a normal agent
//     conversation, and a separate override had no consumer left.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/dsh-tools` and the settings
// helpers resolve at runtime through Node's parent-walk (the harness installs
// them in the profile fallback node_modules).

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync } from 'node:fs'
import { installAutoMemory } from './auto.js'
import { dreamWorkspace, todayStamp, timeStamp, walkMemory } from './store.js'
import { formatHits, fuseHits, searchMemory } from './search.js'
import { EmbeddingClient, VectorIndex } from './embed.js'
import { formatDreamReport, runDream } from './dream.js'
import { ensureDreamAgentsMd, ensureDreamPreset } from './dream-setup.js'
import { NS, installConfigEndpoint } from './config-http.js'

export const name = 'dsh-memory'

export const inject = ['tools']

/**
 * Plugin configuration, editable through the `dsh-memory:` section of
 * $DSH_HOME/settings.yaml (hot-reloaded, no restart needed).
 * Schema rules (schemastery, NOT zod) live in this directory's AGENTS.md.
 */
export const Config = z.object({
  /** Default result count for memory_search. */
  searchLimit: z.natural().min(1).max(10).default(5),
  /** Daily Dream trigger time, HH:MM; non-empty = timer on, empty = off. */
  dreamTime: z.string().default('23:00'),
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
      'Search the memory library: daily notes (memory/) and the refined digest library (digest/). ' +
      'Returns BLOCK-level hits: rel carries the multi-level breadcrumb (file#主题 > 小节 > 子节, any heading level starts its own block), and each snippet is the WHOLE block text (up to ~1000 chars) — ' +
      'usually enough to continue without opening the file; read the source only when the block is truncated or more context is needed. ' +
      'Digest hits get a ranking bonus (not a hard guarantee); one file may appear several times with different blocks. ' +
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

export function apply(ctx) {
  // runtime configuration: seeded with schema defaults, then driven by the
  // `dsh-memory:` section of settings.yaml (hot-reloaded). installSettingsSection
  // waits for the settings service itself (ctx.inject); do NOT gate it on
  // ctx.get('settings') at apply time — the service may mount after this
  // plugin activates, and a skipped registration makes settings.mutate fail
  // with "settings namespace ... is not registered".
  // DEFAULTS mirrors what clearing a user value resolves to; it is reported
  // to the browser card (GET /dsh-memory/config) so the UI can show the true
  // default when a field is reset/cleared but not yet saved.
  const DEFAULTS = {
    searchLimit: 5,
    dreamTime: '23:00',
    embeddingBaseUrl: '',
    embeddingModel: 'bge-m3',
    autoMemory: true,
  }
  const runtime = { ...DEFAULTS }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
      runtime.searchLimit = source.searchLimit
      runtime.dreamTime = source.dreamTime
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

  // Dream is NOT exposed as a tool/command anymore (2026-08-17): it runs as a
  // scheduled background agent session in the dream workspace. The only model
  // tool is memory_search.
  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }

  // Auto-Memory: a per-turn system-prompt reminder (autoMemory on); the main
  // agent writes the daily memory file with its own read/edit/write tools.
  // No background LLM call, no turn counting, no manual command.
  ctx.effect(() => installAutoMemory(ctx, getConfig))

  // Dream session bootstrap: ensure the pieces every Dream pass needs BEFORE
  // the first run —
  //   - the dream workspace directory (every background Dream session's cwd);
  //   - the `dream` agent preset in $DSH_HOME/.agent-presets/dream (file
  //     tools; without a preset the agent resolves only the empty global tool
  //     layer and cannot write digest files);
  //   - the consolidation rulebook as dream/AGENTS.md (auto-loaded into every
  //     Dream session's system prompt);
  //   - a UI workspace record titled "dream" so Dream conversations group
  //     under one workspace instead of "Ungrouped".
  // All steps are best-effort: an existing file/record is respected, a
  // missing service degrades with a warning, and the Dream pass itself still
  // reports the outcome.
  try {
    mkdirSync(dreamWorkspace(), { recursive: true })
  } catch (error) {
    console.warn(`dsh-memory: cannot create dream workspace: ${error?.message ?? String(error)}`)
  }
  ensureDreamPreset()
  ensureDreamAgentsMd()
  const dreamWorkspaceReady = (async () => {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) {
        console.warn('dsh-memory: workspaceRegistry service absent; dream sessions will show as ungrouped')
        return undefined
      }
      const entity = await registry.create(dreamWorkspace(), 'dream')
      console.log(`dsh-memory: dream workspace record ensured (${dreamWorkspace()})`)
      return entity
    } catch (error) {
      console.warn(`dsh-memory: cannot register dream workspace: ${error?.message ?? String(error)}`)
      return undefined
    }
  })()

  // scheduled Dream: fires once per day at dreamTime when it is non-empty; a
  // blank dreamTime disables the timer. Each pass runs as a background agent
  // session in the dream workspace (no parent, no /dream command anymore).
  const timer = ctx.get('timer')
  if (timer !== undefined) {
    let dreamedToday = ''
    const disposer = timer.interval(() => {
      try {
        if (!runtime.dreamTime) return
        const now = new Date()
        const today = todayStamp(now)
        if (dreamedToday === today) return
        if (timeStamp(now) !== runtime.dreamTime) return
        dreamedToday = today
        runDream(ctx, () => dreamWorkspaceReady)
          .then((report) => console.log(`dsh-memory dream: ${report.processedDates.length} date(s), session ${report.sessionId ?? 'n/a'}, ${report.changes.length} digest change(s), ${report.errors.length} error(s)`))
          .catch((error) => console.error(`dsh-memory dream failed: ${error?.message ?? String(error)}`))
      } catch (error) {
        console.error(`dsh-memory dream scheduler: ${error?.message ?? String(error)}`)
      }
    }, 60 * 1000)
    ctx.effect(() => disposer)
  }

  // browser configuration card: our own webServer endpoint (the official
  // plugin-configuration surface has a hardcoded api-proxy whitelist this
  // plugin cannot extend; see config-http.js)
  installConfigEndpoint(ctx, getConfig, () => DEFAULTS)
}

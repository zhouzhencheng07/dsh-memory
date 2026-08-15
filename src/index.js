// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes (memory/), Dream digest
// buckets (dream/), and memory search.
//
// Design (agreed with the user, 2026-08-16):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive; project detail lives in the project's AGENTS.md
//     and project docs.
//   - retrieval layers: dream digest (refined) -> memory (daily notes).
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
//   - Dream: scheduled daily when dreamTime is set, plus the /dream command;
//     consolidates memory -> dream/{personal,procedure,wiki}/<topic>.md with
//     the session's own model, derived_from provenance, raw notes kept,
//     fixed two-day window without a watermark.
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / model / dreamTime / embeddingBaseUrl / embeddingModel /
//     autoMemory), see README. dreamTime non-empty = Dream timer on;
//     autoMemory true = per-turn reminder on.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/dsh-tools` and the settings
// helpers resolve at runtime through Node's parent-walk (the harness installs
// them in the profile fallback node_modules).

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installAutoMemory } from './auto.js'
import { todayStamp, timeStamp, walkMemory } from './store.js'
import { formatHits, fuseHits, searchMemory } from './search.js'
import { EmbeddingClient, VectorIndex } from './embed.js'
import { formatDreamReport, runDream } from './dream.js'
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
  /** Provider/model override for Dream LLM calls; empty = the session's model. */
  model: z.string(),
  /** Daily Dream trigger time, HH:MM; non-empty = timer on, empty = off (/dream still works). */
  dreamTime: z.string().default('23:00'),
  /** Ollama base URL for optional vector search (e.g. http://localhost:11434); empty disables it. */
  embeddingBaseUrl: z.string(),
  /** Embedding model served by embeddingBaseUrl. */
  embeddingModel: z.string().default('bge-m3'),
  /** Per-turn automatic memory: on = a system-prompt section reminds the agent every turn to judge and write; off = no reminder. */
  autoMemory: z.boolean().default(true),
})

const MAX_LIMIT = 10

/** Resolve the acting agent from a tool execution, falling back to the initiator. */
function resolveAgent(ctx, exec) {
  if (exec?.agent !== undefined) return exec.agent
  const agents = ctx.get('agents')
  return agents?.currentInitiator()
}

function memorySearchTool(ctx, getConfig, getVectorIndex) {
  return {
    name: 'memory_search',
    description:
      'Search the memory library: daily notes (memory/) and refined digest (dream/). Digest hits rank first. ' +
      'When embeddingBaseUrl is configured, vector search is fused with keyword hits automatically.',
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

function memoryDreamTool(ctx, getConfig) {
  return {
    name: 'memory_dream',
    description:
      'Run one Dream consolidation: refine recent daily notes into dream/ with the session model, ' +
      'keeping derived_from provenance and raw notes.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const agent = resolveAgent(ctx, exec)
      const report = await runDream(ctx, agent, getConfig())
      return formatDreamReport(report)
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
  const runtime = {
    searchLimit: 5,
    model: '',
    dreamTime: '23:00',
    embeddingBaseUrl: '',
    embeddingModel: 'bge-m3',
    autoMemory: true,
  }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
      runtime.searchLimit = source.searchLimit
      runtime.model = source.model ?? ''
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

  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
    memoryDreamTool(ctx, getConfig),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }

  // Auto-Memory: a per-turn system-prompt reminder (autoMemory on); the main
  // agent writes the daily memory file with its own read/edit/write tools.
  // No background LLM call, no turn counting, no manual command.
  ctx.effect(() => installAutoMemory(ctx, getConfig))

  // scheduled Dream: fires once per day at dreamTime when it is non-empty;
  // a blank dreamTime disables the timer (/dream command still works).
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
        runDream(ctx, undefined, runtime)
          .then((report) => console.log(`dsh-memory dream: ${report.processedDates.length} date(s), ${report.written.length} digest(s), ${report.errors.length} error(s)`))
          .catch((error) => console.error(`dsh-memory dream failed: ${error?.message ?? String(error)}`))
      } catch (error) {
        console.error(`dsh-memory dream scheduler: ${error?.message ?? String(error)}`)
      }
    }, 60 * 1000)
    ctx.effect(() => disposer)
  }

  // manual Dream command: /dream — the user's own trigger, independent of
  // the timer (which dreamTime can disable)
  {
    const registerDream = (commands) => {
      const dispose = commands.register({
        name: 'dream',
        description: '立即执行一次 Dream 巩固：把 memory/ 每日记忆提炼进 dream/ 长期库',
        handler: async (inv) => {
          try {
            const report = await runDream(ctx, inv.agent, runtime)
            return { kind: 'success', text: formatDreamReport(report) }
          } catch (error) {
            return { kind: 'error', text: `Dream 执行失败：${error?.message ?? String(error)}` }
          }
        },
      })
      ctx.effect(() => dispose)
    }
    const commands = ctx.get('commands')
    if (commands !== undefined) {
      registerDream(commands)
    } else {
      ctx.effect(() => {
        const fiber = ctx.inject(['commands'], (childCtx) => registerDream(childCtx.commands))
        return () => fiber.dispose()
      })
    }
  }

  // browser configuration card: our own webServer endpoint (the official
  // plugin-configuration surface has a hardcoded api-proxy whitelist this
  // plugin cannot extend; see config-http.js)
  installConfigEndpoint(ctx, getConfig)
}

// dsh-memory plugin for DeepSeek Harness (dsh)
//
// Cross-session memory: daily per-workspace notes under
// $DSH_HOME/dsh-memory/YYYY-MM-DD/, and memory search.
//
// Design (agreed with the user, 2026-08-16/17/18/22):
//   - memory = reusable experience reference (decisions, pitfalls, ideas),
//     NOT a project archive; project detail lives in the workspace docs.
//   - retrieval: memory_search over the daily notes (block-level, substring +
//     optional vector, recency-weighted). The digest/dream layer was REMOVED
//     (2026-08-18, user decision): memory notes are edited in place and carry
//     their date in the rel, so recency guidance ("newer notes win conflicts,
//     older notes still hold details") plus a recency decay in ranking covers
//     the old digest's convergence job; the digest/ and dream/ directories
//     were deleted, the memory/ sublevel was merged into the plugin root.
//   - capture (2026-08-22/23 evening, user decision, simple version): NO
//     per-turn system-prompt reminder (recoverable in git history) — the
//     capture timing and the quality rules live in the tool description
//     instead. ONE path-fixed tool `memory` (mode=read | write | edit) wraps
//     the host's NATIVE read/write/edit through `ctx.tools.execute()`, so
//     every dsh mechanism applies honestly:
//       - the daily file path is fixed inside the tool (the model never
//         supplies it), but every result echoes the path — one call is
//         enough for the agent to learn it and use native tools afterwards;
//       - the fs observation policy (read-before-modify) guards edits and
//         overwrites exactly as for the native tools: mode=edit on an unread
//         note is denied with "please read first"; mode=write over an
//         existing unread note hits createIfAbsent;
//       - the sandbox fence applies honestly: memory capture needs
//         danger-full-access, like any native $DSH_HOME write;
//       - the leading `<!-- 会话来源: ... -->` comment is maintained
//         automatically (merge on write, one follow-up write after edit) —
//         zero agent burden.
//     Native-shape parameters per mode (no composite title/content/mode
//     upsert) on purpose: the agent reads/writes/edits the note exactly like
//     a normal file, which is the mode whose output quality the user
//     accepts.
//   - config: `dsh-memory:` section in $DSH_HOME/settings.yaml, hot-reloaded
//     (searchLimit / embeddingBaseUrl / embeddingModel), see README.
//
// Plain ESM JavaScript on purpose. `@deepseek-ai/*` resolves at runtime
// through Node's parent-walk (the harness installs them in the profile
// fallback node_modules).

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { memoryRoot, mergeSourceComment, readMemoryFile, sessionSlug, splitPreamble, todayStamp, walkMemory } from './store.js'
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
      query: { type: 'string', required: true, description: 'Search keywords (Chinese or English); formatting marks like backticks/quotes are tolerated, and multiple whitespace-separated keywords are AND-matched' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('memory_search: query is empty')
      // Result count is locked to the configured searchLimit (user decision
      // 2026-08-22): no agent-facing override.
      const limit = Math.min(Math.max(Number(getConfig().searchLimit) || 5, 1), MAX_LIMIT)
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
 * The single path-fixed memory tool (2026-08-23, user decision): ONE tool
 * `memory` with three modes (read | write | edit), each forwarding to the
 * host's NATIVE tool of the same name through `ctx.tools.execute()` — same
 * sandbox fence, same "must read before modify" observation, same semantics.
 * Differences from the native tools: the daily file path is fixed inside
 * (the model never supplies it; every result echoes it), and the
 * `<!-- 会话来源: ... -->` comment is maintained automatically (merged into
 * the written text on mode=write; one follow-up write on mode=edit — the
 * edit just recorded an observation for the session, so the follow-up passes
 * the version guard; a no-op merge skips it).
 */
function memoryTool(ctx) {
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

  /** Fold the session id into the provenance comment and the new content. */
  function withProvenance(content, oldPreamble, sessionId) {
    const trimmed = content.trimStart()
    const hasOwnComment = /^<!--\s*会话来源:/.test(trimmed)
    const base = hasOwnComment ? splitPreamble(content).preamble : oldPreamble
    const merged = sessionId ? mergeSourceComment(base, sessionId) : base
    if (hasOwnComment) {
      const rest = content.replace(/^<!--[\s\S]*?-->\s*/m, '').trim()
      return merged ? (rest ? `${merged}\n\n${rest}` : merged) : rest
    }
    return merged ? (content.trim() ? `${merged}\n\n${content.trim()}` : merged) : content.trim()
  }

  return {
    name: 'memory',
    description:
      "Manage the agent's daily workspace memory note. Call it when this turn produced durable knowledge worth keeping across sessions: decisions and their reasons, user preferences or corrections, pitfalls and how they were fixed, reusable commands or processes, state changes. Keep content concise and worth referencing — no play-by-play; merge related topics into one section; outdated memories pass in a sentence or two. mode=read reviews the note; mode=write is for creating the note when it does not exist; mode=edit modifies a portion of an existing note via old_string/new_string.",
    parameters: {
      mode: { type: 'string', required: true, description: "'read' | 'write' | 'edit'" },
      offset: { type: 'number', description: 'mode=read: 1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'mode=read: maximum number of lines to return.' },
      content: { type: 'string', description: 'mode=write: full new content of the note (markdown).' },
      old_string: { type: 'string', description: 'mode=edit: literal text to replace. Must match exactly.' },
      new_string: { type: 'string', description: 'mode=edit: literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'mode=edit: replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const mode = String(args.mode ?? '').trim()
      const file = dailyFile(exec)
      const sessionId = exec?.agent?.session?.id

      if (mode === 'read') {
        const value = await dispatch(
          'read',
          {
            file_path: file,
            ...(args.offset ? { offset: args.offset } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
          },
          exec,
        )
        const lines = (Array.isArray(value.lines) ? value.lines : []).map((l) => `${String(l.number).padStart(4)}: ${l.text}`)
        return [`${value.path} (${value.totalLines} lines)`, ...lines].join('\n')
      }

      if (mode === 'write') {
        // provenance merge first; then the native write itself enforces the
        // gates: create when absent, overwrite only after a prior read
        const current = readMemoryFile(file)
        const oldPreamble = current !== null ? splitPreamble(current).preamble : ''
        const finalText = withProvenance(String(args.content ?? ''), oldPreamble, sessionId)
        const outcome = await dispatch('write', { file_path: file, content: finalText }, exec)
        return `${file} · ${outcome.operation} (${outcome.version})`
      }

      if (mode === 'edit') {
        const outcome = await dispatch(
          'edit',
          {
            file_path: file,
            old_string: String(args.old_string ?? ''),
            new_string: String(args.new_string ?? ''),
            replace_all: args.replace_all === true,
          },
          exec,
        )
        // provenance follow-up (no-op when the comment already carries the id)
        try {
          const text = readMemoryFile(file)
          if (text !== null) {
            const next = withProvenance(text, '', sessionId)
            if (next !== text && next !== null) await dispatch('write', { file_path: file, content: next }, exec)
          }
        } catch (error) {
          console.warn(`dsh-memory: provenance follow-up failed (${error?.message ?? String(error)})`)
        }
        return `${file} · edited (${String(outcome.before).length} → ${String(outcome.after).length} chars)`
      }

      throw new Error("memory: mode must be 'read', 'write' or 'edit'")
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
  }
  const runtime = { ...DEFAULTS }
  {
    /** Mirror one resolved source onto the live runtime object. */
    const applySource = (source) => {
      runtime.searchLimit = source.searchLimit
      runtime.embeddingBaseUrl = source.embeddingBaseUrl ?? ''
      runtime.embeddingModel = source.embeddingModel || 'bge-m3'
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

  // Model tools: memory_search (retrieval) + the single path-fixed `memory`
  // tool (mode read|write|edit). No per-turn reminder, no Dream layer.
  const tools = [
    memorySearchTool(ctx, getConfig, getVectorIndex),
    memoryTool(ctx),
  ]
  for (const tool of tools) {
    if (tool === undefined) continue
    ctx.tools.register(defineTool(tool))
  }
}
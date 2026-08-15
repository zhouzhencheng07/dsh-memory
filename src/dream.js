// dsh-memory — Dream: consolidate daily memory notes into the long-term
// refined library (dream/<bucket>/<topic>.md).
//
// Pipeline (fixed window per pass — NO watermark):
//   1. extract: collect the notes of TODAY and YESTERDAY (a note file gets
//      two scan chances: the day it was written and the next day);
//   2. integrate: the session LLM reads the existing digest catalog + the
//      notes, decides bucket/topic and merge-vs-create, and returns strict
//      JSON; the plugin validates and writes atomically;
//   3. evolution: a merge_with target is fused through a SECOND LLM pass over
//      the old digest text (keep old points, weave in new evidence), and ALL
//      old derived_from provenance is preserved — no blind overwrite;
//   4. provenance: every digest file ends with `derived_from:: [[memory/…]]`
//      lines; raw notes are NEVER deleted.
//
// No watermark by design (user decision 2026-08-17): re-running the same
// window converges through merge_with (no duplicate nodes), failed batches
// simply get their second chance the next day, and notes that never make it
// into dream/ remain fully searchable through memory_search — digest is a
// refinement layer, not a gate.
//
// The LLM is the acting session's model (quality matters; the user's
// decision 2026-08-15): provider/model/reasoning come from the session
// request header, falling back to agentDefaultModel.

import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { digestRoot, readMemoryFile, safeTopic, todayStamp, walkMemory } from './store.js'

/** Digest buckets (QwenPaw-aligned, user decision 2026-08-16). */
export const BUCKETS = ['personal', 'procedure', 'wiki']

/** Max note-batch characters per LLM call. */
const BATCH_CHARS = 8000
/** Max output tokens for one integration call. */
const DREAM_MAX_TOKENS = 8192
/** Hard safety timeout for one LLM call. */
const DREAM_TIMEOUT_MS = 10 * 60 * 1000

/** Atomic write of a digest file. */
function writeDigest(file, content) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Strip trailing `derived_from::` lines (they are re-emitted on merge). */
export function stripDerivedFrom(text) {
  return String(text)
    .split('\n')
    .filter((line) => !line.trim().startsWith('derived_from::'))
    .join('\n')
    .replace(/\n{3,}$/, '\n')
    .trimEnd()
}

/** Parse strict JSON from an LLM answer (tolerates ```json fences). */
export function parseJsonAnswer(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/**
 * Call the acting session's LLM and return the full text.
 * @param {object} ctx - Cordis context
 * @param {object} agent - acting agent (may be undefined for scheduled runs)
 * @param {Array<{role: string, content: unknown}>} messages
 * @param {number} maxTokens
 * @param {{model?: string}} [options] - optional "provider/model" override
 * @returns {Promise<string>}
 */
export async function callSessionLlm(ctx, agent, messages, maxTokens, options = {}) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('dsh-memory: llm service absent')
  let provider
  let model
  let reasoningEffort
  // 1. explicit config override ("provider/model") wins
  const override = typeof options?.model === 'string' ? options.model.trim() : ''
  if (override) {
    const idx = override.indexOf('/')
    if (idx > 0 && idx < override.length - 1) {
      provider = override.slice(0, idx)
      model = override.slice(idx + 1)
    }
  }
  // 2. otherwise the acting session's model
  if (!provider || !model) {
    try {
      const header = agent?.session?.requestHeader ? agent.session.requestHeader() : undefined
      const config = header?.config
      if (config?.provider && config?.model) {
        provider = config.provider
        model = config.model
        reasoningEffort = config.reasoningEffort
      }
    } catch {
      // fall through to the default selection
    }
  }
  // 3. finally the agent default selection
  if (!provider || !model) {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    provider = provider ?? selection?.provider
    model = model ?? selection?.model
  }
  if (!provider || !model) throw new Error('dsh-memory: cannot resolve a provider/model')

  const request = {
    provider,
    model,
    messages,
    ...(Number.isInteger(maxTokens) ? { maxTokens } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DREAM_TIMEOUT_MS)
  try {
    const parts = []
    for await (const chunk of llm.stream(request)) {
      if (chunk.type === 'text-delta') parts.push(chunk.text)
    }
    return parts.join('')
  } finally {
    clearTimeout(timer)
  }
}

/** Build the catalog of existing digests (rel + first heading line). */
export function digestCatalog() {
  const out = []
  for (const entry of walkMemory()) {
    if (entry.kind !== 'digest') continue
    const first = entry.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)[0]
    out.push(`${entry.rel}: ${first ? first.slice(0, 120) : ''}`)
  }
  return out
}

/**
 * Group the notes of TODAY and YESTERDAY for one Dream pass.
 *
 * Fixed two-day window, NO watermark (user decision 2026-08-17): each note
 * file gets two scan chances (the day it was written and the next day);
 * re-running the window converges through merge_with instead of duplicating
 * nodes, so repeated manual runs add no noise.
 * @returns {Array<{date: string, files: Array<{rel: string, text: string}>}>}
 */
export function collectWindow() {
  const today = todayStamp()
  const yesterday = todayStamp(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const byDate = new Map()
  for (const entry of walkMemory()) {
    if (entry.kind !== 'note') continue
    if (!entry.date) continue
    if (entry.date < yesterday || entry.date > today) continue
    if (!byDate.has(entry.date)) byDate.set(entry.date, [])
    byDate.get(entry.date).push({ rel: entry.rel, text: entry.text })
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, files]) => ({ date, files }))
}

/**
 * Split a date's files into batches bounded by BATCH_CHARS.
 * @param {Array<{rel: string, text: string}>} files
 * @returns {Array<Array<{rel: string, text: string}>>}
 */
export function splitBatches(files) {
  const batches = []
  let current = []
  let size = 0
  for (const file of files) {
    const add = file.text.length + file.rel.length + 8
    if (current.length > 0 && size + add > BATCH_CHARS) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += add
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Build the LLM prompt for one batch (notes already bounded). */
export function buildBatchPrompt(catalog, date, files) {
  const notes = files
    .map((f) => `=== ${f.rel} ===\n${f.text}`)
    .join('\n\n')
  return [
    '你是记忆巩固引擎。把「新记忆笔记」整合进长期精炼库 dream/（按知识类型分桶）。',
    `桶（bucket）只能是：${BUCKETS.join(' / ')}。`,
    '桶的选择按「未来读者会从哪里搜索」决定：用户/团队/项目偏好、约定与约束 → personal；怎么做某事 → procedure；通用知识、原则、作为先例的决策、事实、观察 → wiki。',
    'procedure 用 Trigger/Steps/Pre-conditions/Failure modes 结构；personal 用 Rule/Why/How to apply；wiki 用简洁知识条目（定义/原则/事实/观察）。',
    'digest 是抽象记忆层：只保存未来 agent 应该回忆的可复用原则、模式、流程、约定、偏好。原始细节留在 memory/ 每日笔记中；**不进入 digest 的笔记不会丢失**——它们仍可被 memory_search 直接检索到。',
    '禁止输出：一带而过的提及、已知概念复述、事件总括、一次性时间戳、没有复用价值的事实。',
    '已有 digest 清单（rel 路径 + 首行）：',
    catalog.length > 0 ? catalog.map((l) => `- ${l}`).join('\n') : '（无）',
    '',
    `待整合的新记忆笔记（日期 ${date}）：`,
    notes,
    '',
    '要求：',
    '1. 输出严格 JSON（不要任何其他文字，不要 markdown 围栏）：',
    '{"digests":[{"bucket":"<桶>","topic":"<短英文主题名>","title":"<一句话标题>","content":"<digest 正文 Markdown>","merge_with":"<已有 digest 的 rel 路径，同主题整合时填，否则 null>","derived_from":["<本次用到的源笔记 rel>"]}]}',
    '2. 宁缺毋滥：只提取可长期复用的抽象知识；如果这批笔记没有可复用的内容，返回空数组 "digests":[]。',
    '3. 聚合：多条笔记表达同一个抽象时必须合并成一个 digest（derived_from 可包含多个来源），不要逐条生成摘要。',
    '4. 同主题演化：与已有 digest 同主题（内容实质相同）时 merge_with 指向它，整合进旧文件，绝不新建重复节点；新主题 merge_with 为 null。',
    '5. content 要命名抽象、解释为什么重要、指向证据，不要逐句摘抄笔记；正文简洁抽象，通常 50-200 词。',
    '6. topic 用 kebab-case 英文/拼音，避免与已有文件名冲突。',
  ].join('\n')
}

/** Build the merge prompt: fuse NEW evidence into an EXISTING digest. */
export function buildMergePrompt(oldText, newContent, sources) {
  return [
    '你是记忆巩固引擎。把「新证据」整合进已有的长期记忆 digest。目标是融合而非覆盖：保留旧内容的要点与适用范围，融入新证据（补充、细化或修正），让 digest 更准确。',
    '',
    '# 已有 digest（旧内容）',
    '',
    oldText.trim(),
    '',
    '# 新证据摘要（来自每日笔记的提炼）',
    '',
    String(newContent ?? '').trim(),
    ...(Array.isArray(sources) && sources.length > 0
      ? ['', '# 新证据来源', '', ...sources.map((s) => `- ${s}`)]
      : []),
    '',
    '要求：',
    '1. 输出整合后的完整 digest 正文（Markdown）。只输出正文本身，不要任何解释文字、不要 markdown 围栏、不要 derived_from 行（来源由系统合并）。',
    '2. 保留旧内容中仍然成立的所有要点，不删减有用信息。',
    '3. 融入新证据：重复则强化表述，新细节则补充，冲突则修正旧表述。',
    '4. 保持原有结构风格（procedure/personal/wiki 各自的结构），不要复刻每日笔记的细节——细节留在 memory/。',
    '5. 正文简洁抽象，通常 50-200 词，需要时再长一些。',
  ].join('\n')
}

/** Extract the `derived_from:: [[...]]` lines of a digest file. */
export function listDerivedFrom(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*derived_from::\s+(.+)$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

/** Read an existing digest by rel path (dream/<bucket>/<topic>.md). */
function readDigest(rel) {
  const clean = String(rel ?? '').replace(/^dream\//, '')
  if (!clean.includes('/') || !clean.endsWith('.md')) return null
  const text = readMemoryFile(join(digestRoot(), clean))
  return text === null ? null : { rel: `dream/${clean}`, text }
}

/**
 * Run one Dream pass over the fixed two-day window (today + yesterday).
 * No watermark: re-running converges through merge_with; failed batches get
 * their second chance on the next day's window.
 * @param {object} ctx - Cordis context
 * @param {object} agent - acting agent (may be undefined)
 * @param {object} [config] - plugin config (model override etc.)
 * @returns {Promise<{processedDates: string[], written: string[], errors: string[]}>}
 */
export async function runDream(ctx, agent, config) {
  const pending = collectWindow()
  const written = []
  const errors = []
  const processedDates = pending.map(({ date }) => date)
  const catalog = digestCatalog()

  for (const { date, files } of pending) {
    const batches = splitBatches(files)
    for (const batch of batches) {
      // the session model is a reasoning chat model: strict-JSON output from
      // a cold call fails occasionally, so retry the whole call+parse once
      let parsed = null
      let lastError = null
      for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
        try {
          const answer = await callSessionLlm(ctx, agent, [
            { role: 'user', content: [{ type: 'text', text: buildBatchPrompt(catalog, date, batch) }] },
          ], DREAM_MAX_TOKENS, { model: config?.model })
          parsed = parseJsonAnswer(answer)
          if (!Array.isArray(parsed.digests)) {
            lastError = new Error('answer JSON has no digests array')
            parsed = null
          }
        } catch (error) {
          lastError = error
        }
      }
      if (parsed === null) {
        errors.push(`batch failed (${date}): ${lastError?.message ?? String(lastError)}`)
        continue
      }
      try {
        const digests = parsed.digests
        for (const d of digests) {
          try {
            if (!d || typeof d.content !== 'string' || d.content.trim().length === 0) continue
            const bucket = BUCKETS.includes(d.bucket) ? d.bucket : 'wiki'
            const topic = safeTopic(d.topic || 'untitled')
            const sources = Array.isArray(d.derived_from)
              ? d.derived_from.filter((s) => typeof s === 'string')
              : []
            const newProvenance = sources.map((s) => `derived_from:: [[${s.replace(/^dream\//, 'memory/')}]]`)

            // merge_with: fuse into the existing digest (second LLM pass over
            // the old content) and KEEP the old provenance — evolution, not
            // blind overwrite.
            let oldDigest = null
            if (d.merge_with && typeof d.merge_with === 'string' && d.merge_with.includes('/')) {
              oldDigest = readDigest(d.merge_with)
            }

            let body
            let provenance
            if (oldDigest !== null) {
              let merged = null
              let lastError = null
              for (let attempt = 0; attempt < 2 && merged === null; attempt++) {
                try {
                  const answer = await callSessionLlm(ctx, agent, [
                    { role: 'user', content: [{ type: 'text', text: buildMergePrompt(oldDigest.text, d.content, sources) }] },
                  ], DREAM_MAX_TOKENS, { model: config?.model })
                  merged = String(answer).trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim()
                } catch (error) {
                  lastError = error
                }
              }
              if (merged === null || merged.length === 0) {
                throw new Error(`merge failed: ${lastError?.message ?? String(lastError)}`)
              }
              body = stripDerivedFrom(merged)
              const oldProvenance = listDerivedFrom(oldDigest.text)
              provenance = [...new Set([...oldProvenance, ...newProvenance])]
            } else {
              body = stripDerivedFrom(d.content).trim()
              provenance = newProvenance
            }

            const target = oldDigest !== null
              ? join(digestRoot(), oldDigest.rel.replace(/^dream\//, ''))
              : join(digestRoot(), bucket, `${topic}.md`)
            writeDigest(target, `${body}\n${provenance.length > 0 ? `\n${provenance.join('\n')}\n` : '\n'}`)
            written.push(relative(digestRoot(), target))
          } catch (error) {
            errors.push(`digest write failed (${date}): ${error?.message ?? String(error)}`)
          }
        }
      } catch (error) {
        errors.push(`batch failed (${date}): ${error?.message ?? String(error)}`)
      }
    }
  }
  return { processedDates, written, errors }
}

/** Format a run report for the model. */
export function formatDreamReport(report) {
  const lines = []
  if (report.processedDates.length === 0) {
    if (report.errors.length === 0) lines.push('无可整合的笔记（没有上次 Dream 之后、今天之前的记忆）。')
    else lines.push('本次整合失败（所有批次），次日窗口会再扫描。')
  } else {
    lines.push(`已处理日期：${report.processedDates.join('、')}`)
  }
  if (report.written.length > 0) lines.push(`写入/更新 digest：\n${report.written.map((w) => `- dream/${w}`).join('\n')}`)
  if (report.errors.length > 0) lines.push(`失败（已跳过，不影响其他）：\n${report.errors.join('\n')}`)
  return lines.join('\n')
}

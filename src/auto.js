// dsh-memory — Auto-Memory (per-turn, agent-driven memory capture).
//
// Mechanism (user decision 2026-08-16, second revision; /memory removed
// 2026-08-17): while `autoMemory` is on, the plugin contributes a
// system-prompt section assembled FRESH on every model request; the main
// agent itself decides each turn whether anything worth keeping happened
// and, when it did, writes it incrementally with its own read/edit/write
// tools (write only when the file does not exist; edit otherwise). The daily
// file path is computed at assembly time, so a session spanning midnight
// switches to the new day's file automatically — no watermark, no cross-day
// staleness, no turn bookkeeping. `autoMemory: false` removes the section;
// the /memory command is gone (the per-turn reminder IS the capture path).
//
// Why not a background LLM call (two live failures): hand-built requests
// forwarding message objects broke provider tool-call/tool-result pairing
// (400); reasoningEffort:max models spent all output tokens on thinking
// (empty answer). The conversation loop assembles valid requests and the
// main model answers normally, so neither failure mode exists. No retry: a
// failure means the design is wrong and must surface.
//
// Layer simplification (2026-08-18): the Dream/digest layer was removed.
// Memory is the ONLY layer — the daily notes are edited in place across
// days, carry their date in the rel, and search applies recency guidance
// plus a recency decay, so converging "the current state of a convention"
// happens at query time instead of in a nightly background session.

import { join } from 'node:path'
import { memoryRoot, sessionSlug, todayStamp } from './store.js'

/** Today's daily memory file for one session (assembly-time fresh). */
const memoryFileFor = (session) =>
  join(memoryRoot(), todayStamp(), `${sessionSlug(session.header?.cwd)}.md`)

/**
 * The per-turn system-prompt reminder (short: it is present on EVERY model
 * request). The agent judges per turn whether anything is worth keeping;
 * writing happens with its own read/edit/write tools.
 * @param {string} file - today's daily memory file
 * @param {string} sessionId - source session id (for the provenance line)
 * @returns {string}
 */
export function buildMemoryReminder(file, sessionId) {
  return [
    '【自动记忆】每轮审视本轮内容：有值得跨会话保留的新内容（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、当前状态变化）时，增量写入今日记忆文件 ' + file + '：',
    '- 文件不存在 → write 新建；已存在 → 只用 edit 精确修改（禁止整体 write 覆盖）。',
    '- 只写尚未覆盖的新内容；已有内容过时或错误时更新修正；关键处逐字引用；用正常 markdown 多级标题组织；全文不写日期/时间戳。',
    '- 首行维护来源注释 <!-- 会话来源: ' + sessionId + ' -->（多会话并列追加）。',
  ].join('\n')
}

/**
 * Install the Auto-Memory pipeline: the per-turn system-prompt reminder.
 * @param {object} ctx - Cordis context
 * @param {() => object} getConfig - plugin runtime config getter
 * @returns {() => void} disposer
 */
export function installAutoMemory(ctx, getConfig) {
  const disposers = []

  // Per-turn reminder: a systemPrompt context assembled fresh on every model
  // request, so the daily file path always names TODAY (a midnight-crossing
  // session switches days on its own). The entry stays registered; the text
  // goes empty while autoMemory is off, so the switch applies immediately.
  // Sub-agents (delegationDepth > 0) are excluded: their memory belongs to
  // the main agent's consolidation. Empty text is filtered out of the
  // assembled prompt (dsh-system-prompt renderContextSections), so the
  // disabled/excluded cases leave no stray paragraph.
  disposers.push(
    ctx.effect(() => {
      const fiber = ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'dsh-memory:auto',
          order: 200,
          text: (context) => {
            if (!getConfig().autoMemory) return ''
            const session = context.agent?.session
            if (!session?.id) return ''
            // Sub-agents (delegationDepth > 0) are excluded: their memory
            // belongs to the main agent's consolidation.
            if ((session.header?.delegationDepth ?? 0) > 0) return ''
            return buildMemoryReminder(memoryFileFor(session), session.id)
          },
        })
        console.log('dsh-memory: auto memory reminder registered (per-turn systemPrompt context, order 200)')
      })
      return () => fiber.dispose()
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

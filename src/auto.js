// dsh-memory — Auto-Memory (per-turn, agent-driven memory capture).
//
// Mechanism (user decision 2026-08-16, second revision; /memory removed
// 2026-08-17): while `autoMemory` is on, the plugin contributes a
// system-prompt section assembled FRESH on every model request; the main
// agent itself decides each turn whether anything worth keeping happened
// and, when it did, captures it through the host-side `memory_write` tool.
// The daily file/date is resolved inside the tool at EXECUTE time, so a
// session spanning midnight switches to the new day's file automatically —
// no watermark, no cross-day staleness, no turn bookkeeping.
// `autoMemory: false` removes the section; the /memory command is gone (the
// per-turn reminder IS the capture path).
//
// 2026-08-22: the capture path changed from "agent writes the daily file
// with its own read/edit/write tools" to `memory_write` (user decision).
// Reason: $DSH_HOME/dsh-memory sits outside the session workspace, so under
// workspace-write every direct write was denied by the DSH file sandbox and
// approval=never removed the escalation path. memory_write executes in the
// plugin host process over node:fs — identical behavior in all three modes.
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

/**
 * The per-turn system-prompt reminder (short: it is present on EVERY model
 * request). It only names the CAPTURE MOMENT — what is worth keeping and when
 * to call; how to call lives in the memory_write tool description.
 * @returns {string}
 */
export function buildMemoryReminder() {
  return '【自动记忆】每轮审视本轮内容：有值得跨会话保留的新内容（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、当前状态变化）时，调用 memory_write 增量写入今日跨会话记忆；已有记忆过时或错误时更新修正，只写尚未覆盖的新内容。'
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
            return buildMemoryReminder()
          },
        })
      })
      return () => fiber.dispose()
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

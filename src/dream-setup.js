// dsh-memory — Dream session bootstrap: the files the plugin installs once and
// the setup callback every Dream session runs before its first request.
//
// Two problems this module solves (see the repository AGENTS.md -> Dream):
//   1. Agents created through ctx.agents.create() mount NO agent preset, and
//      in the web composition every model-facing file tool (read/write/edit/
//      glob/grep) lives BEHIND agent presets (the web surface disables the
//      base rows and lets each session mount a preset instead). A preset-less
//      session thus resolves only the empty global tool layer — the first
//      Dream sessions saw only memory_search, could not read notes or write
//      digest files, and every digest they reported was missing on disk.
//      Fix: install a dedicated `dream` preset into
//      $DSH_HOME/.agent-presets/dream (file tools + the instructions loader)
//      and mount it inside the agents.create() setup callback.
//   2. The dream workspace directory is not a workspace RECORD, so its
//      sessions showed under "Ungrouped" in the UI. Fix: create the record
//      (title "dream") via workspaceRegistry and attach each new session.
//
// Everything here is best-effort: each step logs and degrades instead of
// failing the Dream pass, and an existing user file is always respected
// (never overwritten).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestRoot, dreamPresetRoot, dreamWorkspace, memoryRoot } from './store.js'

/** The agent preset every Dream session mounts. */
export const DREAM_PRESET_ID = 'dream'

/** Files copied from the shipped `preset/` directory into the preset root. */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml']

/** Resolve one asset shipped beside this module (../preset/<name>). */
function shippedAsset(name) {
  return fileURLToPath(new URL(`../preset/${name}`, import.meta.url))
}

/**
 * Install the `dream` agent preset into $DSH_HOME/.agent-presets/dream when
 * any of its files is absent. Existing files are never overwritten (the user
 * may edit them; the plugin respects the edits).
 * @returns {string|null} the preset root, or null when nothing could be installed.
 */
export function ensureDreamPreset(log = console) {
  try {
    const root = dreamPresetRoot()
    mkdirSync(root, { recursive: true })
    let changed = false
    for (const name of PRESET_FILES) {
      const target = join(root, name)
      if (existsSync(target)) continue
      const source = shippedAsset(name)
      if (!existsSync(source)) {
        log.warn(`dsh-memory: shipped preset asset missing: ${source}`)
        continue
      }
      writeFileSync(target, readFileSync(source, 'utf8'), 'utf8')
      changed = true
    }
    if (changed) {
      log.warn(`dsh-memory: installed dream agent preset at ${root} (edit freely; never overwritten)`)
    }
    return root
  } catch (error) {
    log.warn(`dsh-memory: cannot install dream preset: ${error?.message ?? String(error)}`)
    return null
  }
}

/**
 * Install the consolidation rulebook into the dream workspace root as
 * AGENTS.md when absent (the dream preset's `agent-instructions` row loads it
 * automatically into every Dream session's system prompt). `{{MEMORY_ROOT}}`
 * and `{{DIGEST_ROOT}}` placeholders are resolved to the live absolute paths.
 * Existing files are never overwritten.
 * @returns {string|null} the target path, or null when it could not be written.
 */
export function ensureDreamAgentsMd(log = console) {
  try {
    const source = shippedAsset('AGENTS.md')
    const target = join(dreamWorkspace(), 'AGENTS.md')
    if (existsSync(target)) return target
    if (!existsSync(source)) {
      log.warn(`dsh-memory: shipped AGENTS.md template missing: ${source}`)
      return target
    }
    const body = readFileSync(source, 'utf8')
      .replaceAll('{{MEMORY_ROOT}}', memoryRoot())
      .replaceAll('{{DIGEST_ROOT}}', digestRoot())
    writeFileSync(target, body, 'utf8')
    log.warn(`dsh-memory: installed dream workspace AGENTS.md at ${target} (edit freely; never overwritten)`)
    return target
  } catch (error) {
    log.warn(`dsh-memory: cannot install dream AGENTS.md: ${error?.message ?? String(error)}`)
    return null
  }
}

/**
 * The agents.create() setup callback, run inside the fresh agent's scoped
 * context BEFORE its first model request:
 *   - mount the `dream` agent preset → file tools + instructions loader
 *     (falls back to the shipped `standard` preset when the dream preset
 *     fails to mount, so the session still gets file tools);
 *   - switch the permission preset to `danger-full-access` (approval never)
 *     so the session can write digest files — the digest root is a SIBLING of
 *     the dream workspace, so `workspace-write` would block every write.
 * @param {object} agentCtx - the prepared agent's scoped Cordis context.
 * @returns {Promise<void>}
 */
export async function setupDreamAgent(agentCtx) {
  const presets = agentCtx.get('agentPresets')
  if (presets !== undefined) {
    try {
      await presets.mount(agentCtx, DREAM_PRESET_ID)
    } catch (error) {
      console.warn(
        `dsh-memory: dream preset "${DREAM_PRESET_ID}" failed to mount (${error?.message ?? String(error)}); falling back to "standard"`,
      )
      await presets.mount(agentCtx, 'standard')
    }
  } else {
    console.warn('dsh-memory: agentPresets service absent; dream session resolves against the empty global tool layer')
  }
  const permission = agentCtx.get('permissionPresets')
  const session = agentCtx.agent?.session
  if (permission !== undefined && session !== undefined) {
    try {
      permission.set(session, 'danger-full-access')
    } catch (error) {
      console.warn(`dsh-memory: cannot set dream session permission: ${error?.message ?? String(error)}`)
    }
  }
}
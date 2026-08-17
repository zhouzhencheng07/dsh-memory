// dsh-memory — configuration HTTP endpoint for the browser card.
//
// The official plugin-configuration surface serves namespaces only through an
// api-proxy whitelist hardcoded in the upstream dsh-host-apiproxy package,
// which a plugin cannot extend. Instead the card talks to this plugin's own
// webServer endpoint — the same seam dsh-client-modules uses for /plugins:
//
//   GET  /dsh-memory/config -> { value, user, defaults, writable }
//   POST /dsh-memory/config -> body { ops: [{op:'set'|'unset', field, value?}] }
//
// `defaults` mirrors what clearing a user value resolves to (the schema
// defaults): the card displays it when a field is reset/cleared but not yet
// saved, so the unsaved UI is consistent with what the deployment will
// actually use.
//
// Writes go through the settings service (schema validation, settings.yaml
// persistence, hot-reload), so no upstream package is touched.

import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** @param {string} ns - settings namespace of this plugin. */
export const NS = settingsNamespace('dsh-memory')

/** Collect and JSON-parse the request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Serve the dsh-memory configuration to the browser card.
 *
 * The webServer service may mount AFTER this plugin's apply() (Cordis
 * activates independent rows without a guaranteed order), so the endpoint is
 * registered inside a dynamic injection that waits for it — the same
 * dynamic-injection pattern index.js uses for optional services. Without
 * this, `ctx.get('webServer')` at apply time is undefined and the endpoint
 * silently never registers.
 * @param {object} ctx - Cordis context
 * @param {() => object} getConfig - resolves the live runtime config
 * @param {() => object} [getDefaults] - resolves the schema defaults shown by
 *   the card for reset/cleared fields
 */
export function installConfigEndpoint(ctx, getConfig, getDefaults = () => ({})) {
  ctx.inject(['webServer'], (childCtx) => {
    childCtx.effect(() => {
      let disposer
      try {
        disposer = childCtx.webServer.register({
          kind: 'prefix',
          path: '/dsh-memory',
          handler: async (req, res) => {
            try {
              const pathname = new URL(req.url ?? '/', 'http://dsh-memory.local').pathname
              const settings = ctx.get('settings')

              if (req.method === 'GET' && pathname === '/dsh-memory/config') {
                let user = null
                if (settings !== undefined) {
                  try {
                    const descriptor = settings.describe().find((d) => d.ns === NS)
                    user = descriptor?.user ?? null
                  } catch {
                    // the user layer is best-effort
                  }
                }
                respond(res, 200, {
                  value: getConfig(),
                  user,
                  defaults: getDefaults(),
                  writable: settings !== undefined,
                })
                return
              }

              if (req.method === 'POST' && pathname === '/dsh-memory/config') {
                if (settings === undefined) {
                  respond(res, 503, { error: 'the settings service is not mounted' })
                  return
                }
                const body = await readBody(req)
                const ops = Array.isArray(body?.ops) ? body.ops : null
                if (ops === null) {
                  respond(res, 400, { error: 'expected a JSON body of { ops: [{op, field, value?}] }' })
                  return
                }
                const pathOps = []
                for (const op of ops) {
                  if (op !== null && typeof op === 'object' && typeof op.field === 'string' && op.field.length > 0) {
                    if (op.op === 'set') {
                      pathOps.push({ op: 'set', path: [op.field], value: op.value })
                      continue
                    }
                    if (op.op === 'unset') {
                      pathOps.push({ op: 'unset', path: [op.field] })
                      continue
                    }
                  }
                  respond(res, 400, { error: `unsupported op: ${JSON.stringify(op)}` })
                  return
                }
                if (pathOps.length === 0) {
                  respond(res, 400, { error: 'empty ops' })
                  return
                }
                await settings.mutate(NS, pathOps)
                respond(res, 200, { ok: true })
                return
              }

              respond(res, 404, { error: 'not found' })
            } catch (error) {
              respond(res, 400, { error: error?.message ?? String(error) })
            }
          },
        })
        console.log('dsh-memory: config endpoint registered at /dsh-memory/config')
      } catch (error) {
        console.error(`dsh-memory: config endpoint registration failed: ${error?.message ?? String(error)}`)
      }
      return () => {
        try {
          if (disposer !== undefined) disposer()
        } catch {
          // best-effort
        }
      }
    })
  })
}

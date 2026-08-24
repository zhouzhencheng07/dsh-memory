// Universal stub for the @deepseek-ai/* host-side packages that dsh-memory's
// src imports at module load. Only what index.js / store.js touch:
//   - schemastery default export `z` (chainable, values ignored)
//   - dsh-settings: settingsNamespace / installSettingsSection — the section
//     install mirrors the real hot-reload source: a test sets
//     globalThis.__MEM_SETTINGS__ before boot to drive the field values
//   - dsh-tools: defineTool (identity)
//   - dsh-llm: CallId (identity)
//   - dsh-home-paths: dshHomePath() -> $MEM_TEST_HOME (test sandbox root)

const chain = () => {
  const node = {}
  for (const method of ['natural', 'string', 'boolean', 'object', 'min', 'max', 'default', 'required']) {
    node[method] = () => node
  }
  return node
}

export default {
  natural: () => chain(),
  string: () => chain(),
  boolean: () => chain(),
  object: () => chain(),
}

export const settingsNamespace = (name) => name
export const installSettingsSection = (_ctx, _ns, _schema, _opts, handlers) => {
  const get = () => (globalThis.__MEM_SETTINGS__ ?? {})
  handlers?.setSource?.(get)
}
export const defineTool = (tool) => tool
export const dshHomePath = () => process.env.MEM_TEST_HOME
export const CallId = (value) => value
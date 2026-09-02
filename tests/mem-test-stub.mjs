// Universal stub for the @deepseek-ai/* host-side packages that dsh-memory's
// src imports at module load. Only what index.js / store.js touch:
//   - schemastery default export `z` (chainable, values ignored)
//   - dsh-tools: defineTool (identity)
//   - dsh-llm: CallId (identity)
//   - dsh-home-paths: dshHomePath() -> $MEM_TEST_HOME (test sandbox root)
// Settings namespace: no longer imported from @deepseek-ai/dsh-settings
// (v0.1.2-alpha.5 removed installSettingsSection/settingsNamespace); the
// `settings` service is stubbed on the TEST ctx's inject() — see the boot()
// helpers in the test files.

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

export const defineTool = (tool) => tool
export const dshHomePath = () => process.env.MEM_TEST_HOME
export const CallId = (value) => value
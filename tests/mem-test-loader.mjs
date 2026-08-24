// Resolve hook: every @deepseek-ai/* import resolves to one universal stub
// module (query string keeps URLs distinct; content identical).
const STUB = new URL('./mem-test-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return { url: `${STUB}?pkg=${encodeURIComponent(specifier)}`, shortCircuit: true }
  }
  return next(specifier, context)
}

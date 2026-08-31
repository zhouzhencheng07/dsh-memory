// Preload entry: registers the @deepseek-ai/* stub loader.
import { register } from 'node:module'
register(new URL('./mem-test-loader.mjs', import.meta.url))

// 2026-09-01: the memory root is the `memoryRoot` SETTING now, defaulting to
// the DSH_HOME-stubbed plugin data root. The AGENT_MEMORY_HOME override is
// gone, so there is no environment variable left that could point a test at
// a real library — the delete below is kept as a belt-and-braces guard for
// anyone still carrying that variable from an older deployment.
delete process.env.AGENT_MEMORY_HOME

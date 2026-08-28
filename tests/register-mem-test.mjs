// Preload entry: registers the @deepseek-ai/* stub loader.
import { register } from 'node:module'
register(new URL('./mem-test-loader.mjs', import.meta.url))

// The memory root follows AGENT_MEMORY_HOME (cross-agent sharing). Tests must
// always exercise the DSH_HOME-stubbed fallback — delete the variable so a
// machine-wide setting (pointing at the REAL shared library) can never leak
// test writes into production data.
delete process.env.AGENT_MEMORY_HOME

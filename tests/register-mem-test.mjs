// Preload entry: registers the @deepseek-ai/* stub loader.
import { register } from 'node:module'
register(new URL('./mem-test-loader.mjs', import.meta.url))

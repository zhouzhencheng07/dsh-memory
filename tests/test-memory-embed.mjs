// Vector cache persistence (embed.js v4) verification: the signature→vector
// map survives dsh restarts via <memory root>/.vector-cache.json, so the
// first search after a restart no longer rebuilds the whole corpus.
// Covered: persist on change, zero-embed reuse across instances, per-file
// re-embed on text change, pruning of removed/aged-out files, wholesale
// invalidation on model change, corrupt-cache cold start, atomic write.
// A deterministic fake client stands in for the Ollama endpoint (no network).
// Usage: node tests/test-memory-embed.mjs
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VEC_CACHE_VERSION, VectorIndex } from '../src/embed.js'

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    console.error(`FAIL ${label}\n    ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}

/** Deterministic fake embedder: text → 8-dim char-histogram vector. */
class FakeClient {
  constructor(model = 'fake-embed') {
    this.model = model
    this.embedded = []
  }

  async embed(texts) {
    this.embedded.push(...texts)
    return texts.map(fakeVec)
  }
}

function fakeVec(text) {
  const v = new Array(8).fill(0)
  for (const ch of String(text)) v[ch.charCodeAt(0) % 8] += 1
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

/** Fully controlled vectors: table lookup, so threshold behavior is exact. */
class TableClient {
  constructor(table) {
    this.model = 'fake-embed'
    this.table = table
    this.embedded = []
  }

  async embed(texts) {
    this.embedded.push(...texts)
    return texts.map((t) => {
      const v = this.table[t]
      if (!v) throw new Error(`no preset vector for ${JSON.stringify(t)}`)
      return v
    })
  }
}

const entry = (rel, text, date = 'topics') => ({ rel, date, kind: 'note', text })
const FILE_A = entry('topics/a.md', '# alpha\n\nalpha body with distinctive words alpha.', 'topics')
const FILE_B = entry('topics/b.md', '# beta\n\nbeta body with other words beta.', 'topics')
const seed = [FILE_A, FILE_B]

const home = mkdtempSync(join(tmpdir(), 'mem-embed-'))
const cachePath = join(home, '.vector-cache.json')

await check('refresh embeds, persists the cache, leaves no tmp litter', async () => {
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  await idx.refresh(seed)
  assert.ok(client.embedded.length > 0, 'cold start embeds')
  assert.ok(existsSync(cachePath), 'cache file written')
  const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.equal(raw.version, VEC_CACHE_VERSION)
  assert.equal(raw.model, 'fake-embed')
  assert.ok(raw.files['topics/a.md'].sig.length === 40)
  assert.ok(raw.files['topics/a.md'].blocks[0].v.length === 8)
  assert.ok(!readdirSync(home).some((f) => f.includes('.tmp-')), 'no tmp litter')
  assert.equal(idx.cacheDirty, false, 'clean after save')
})

await check('a fresh instance reuses the cache: zero embeddings for unchanged files', async () => {
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  assert.equal(idx.files.size, 2, 'cache loaded at construction')
  await idx.refresh(seed)
  assert.equal(client.embedded.length, 0, 'nothing re-embedded')
  assert.ok(idx.files.get('topics/a.md').blocks.length > 0)
})

await check('query works from the cache with only the query text embedded', async () => {
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  const hits = await idx.query(seed, 'alpha body with distinctive words alpha', 5)
  assert.deepEqual(client.embedded, ['alpha body with distinctive words alpha'], 'only the query is embedded')
  assert.ok(hits.some((h) => h.rel.includes('topics/a.md#alpha')), `self-query must hit, got:\n${hits.map((h) => h.rel)}`)
})

await check('threshold: only blocks above the 0.45 cosine join the results', async () => {
  // exact vectors: the alpha block is identical to the query (cos 1), the
  // beta block is orthogonal (cos 0) and must never surface
  const close = [1, 0, 0, 0, 0, 0, 0, 0]
  const far = [0, 1, 0, 0, 0, 0, 0, 0]
  const client = new TableClient({
    '# alpha\n\nalpha body': close,
    '# beta\n\nbeta body': far,
    'alpha body': close,
  })
  const idx = new VectorIndex(client, { threshold: 0.45 })
  const entries = [entry('topics/a.md', '# alpha\n\nalpha body', 'topics'), entry('topics/b.md', '# beta\n\nbeta body', 'topics')]
  const hits = await idx.query(entries, 'alpha body', 5)
  assert.equal(hits.length, 1)
  assert.ok(hits[0].rel.includes('topics/a.md#alpha'))
})

await check('a changed file re-embeds only that file', async () => {
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  const changed = [entry('topics/a.md', '# alpha\n\nalpha body rewritten with new words.', 'topics'), FILE_B]
  await idx.refresh(changed)
  assert.ok(client.embedded.length > 0 && client.embedded.every((t) => t.includes('rewritten')),
    `only the changed file's blocks embedded, got: ${JSON.stringify(client.embedded)}`)
})

await check('files gone from the walk (deleted or window-expired) are pruned', async () => {
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  await idx.refresh([FILE_B]) // FILE_A dropped from the walk → pruned
  assert.ok(!idx.files.has('topics/a.md'), 'dropped from the live index')
  const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.ok(!raw.files['topics/a.md'], 'pruned from the persisted cache too')
  assert.ok(raw.files['topics/b.md'], 'kept file stays cached')
})

await check('a model change invalidates the cache wholesale', async () => {
  const client = new FakeClient('another-model')
  const idx = new VectorIndex(client, { cachePath })
  assert.equal(idx.files.size, 0, 'foreign-model cache is not adopted')
  await idx.refresh(seed)
  assert.ok(client.embedded.length > 0, 'full re-embed after model change')
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).model, 'another-model')
})

await check('a corrupt cache file degrades to a cold start, never throws', async () => {
  writeFileSync(cachePath, '{not json at all', 'utf8')
  const client = new FakeClient()
  const idx = new VectorIndex(client, { cachePath })
  assert.equal(idx.files.size, 0)
  await idx.refresh(seed)
  assert.equal(idx.files.size, 2)
})

await check('cacheless mode (no cachePath) keeps the legacy in-memory behavior', async () => {
  const before = readFileSync(cachePath, 'utf8') // the file exists from earlier checks
  const client = new FakeClient()
  const idx = new VectorIndex(client)
  await idx.refresh(seed)
  assert.equal(idx.files.size, 2)
  assert.equal(readFileSync(cachePath, 'utf8'), before, 'cacheless mode writes nothing')
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`)

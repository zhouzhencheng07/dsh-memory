// dsh-memory — optional vector retrieval (v4: persisted signature cache).
//
// Zero-dependency by default: nothing here runs until `embeddingBaseUrl` is
// configured (settings.yaml, hot-reloaded). When configured, memory recall
// embeds memory files and the query through an Ollama-compatible
// /api/embed endpoint and fuses vector hits with substring hits (RRF).
//
// Design notes:
//   - granularity: memory files are split into `#`-level blocks (see
//     splitSections in search.js — the single shared definition, so the
//     vector path and the substring path use the SAME block granularity and
//     produce matching `rel#title` hits for dedup), and each block gets its
//     own vector — a whole-file vector dilutes the semantics of a long file.
//   - cache: a sha1 signature of the file text keys the index; files whose
//     text changed are re-embedded lazily on the next search (first search
//     after a change pays the cost of the changed file only). Since v4 the
//     cache PERSISTS to `<memory root>/.vector-cache.json` (atomic tmp+
//     rename, written only when something changed), so the first search
//     after a dsh restart no longer rebuilds the whole corpus — the dominant
//     latency in vector mode. The cache file sits at the memory ROOT where
//     walkMemory never looks (it only scans subdirectories for .md), so it
//     is invisible to the search corpus and to other agents sharing the
//     library. It is a regenerable derived artifact, not bookkeeping state.
//   - window & mutation handling: the cache mirrors the LAST refresh's walk
//     — the live index is always the intersection of cache and the current
//     walk, because query() refreshes against walkMemory() BEFORE scoring:
//     diaries aging out of the 45-day window and deleted/renamed files are
//     pruned at refresh time, and pruned entries leave the persisted cache
//     on the next save. Aged files re-embed once if the window is widened.
//   - model binding: the cache records the embedding model; a model change
//     invalidates it wholesale (vectors from different models are not
//     comparable). The cache format carries a version for invalidation when
//     the block-splitting algorithm changes.
//   - resilience: every network error propagates to the caller, which falls
//     back to pure substring results; a broken embedding service never
//     breaks recall. Cache READ and WRITE failures degrade to the
//     in-memory behavior (warn, never throw).

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { blockSnippet, splitBlocks } from './search.js'

/**
 * Minimum cosine similarity for a vector hit to join the fusion.
 * Tuned for bge-m3's similarity distribution (measured on this library):
 * genuine semantic hits land ~0.5+, unrelated text sits ~0.35-0.45, so 0.3
 * let noise through and 0.45 keeps the signal.
 */
export const VEC_THRESHOLD = 0.45
/** Texts per /api/embed request. */
export const VEC_BATCH = 32
/** Per-request timeout (ms). */
export const EMBED_TIMEOUT_MS = 15_000
/** Persisted-cache format version: bump to invalidate every cached vector
 * when the block-splitting or normalization semantics change. */
export const VEC_CACHE_VERSION = 1
/** Vector components are rounded to this many decimals on save — cosine
 * differences at 1e-5 are meaningless against the 0.45 threshold, and full
 * float precision would triple the cache file size. */
const VEC_DECIMALS = 5

/** L2-normalize a vector so cosine similarity is a dot product. */
export function normalizeVec(vec) {
  let norm = 0
  for (const x of vec) norm += x * x
  norm = Math.sqrt(norm) || 1
  return vec.map((x) => x / norm)
}

/** Cosine similarity of two L2-normalized vectors (dot product). */
export function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** Ollama-compatible /api/embed client (batched, bounded timeout). */
export class EmbeddingClient {
  /**
   * @param {string} baseUrl - e.g. http://localhost:11434
   * @param {string} model - embedding model name, e.g. bge-m3
   * @param {{batchSize?: number, timeoutMs?: number}} [opts]
   */
  constructor(baseUrl, model, opts = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.model = model || 'bge-m3'
    this.batchSize = opts.batchSize ?? VEC_BATCH
    this.timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS
  }

  /** Embed many texts, batching under the client's batch size. */
  async embed(texts) {
    const out = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      out.push(...(await this.embedOne(batch)))
    }
    return out
  }

  async embedOne(batch) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
      const data = await res.json()
      const list = data?.embeddings
      if (!Array.isArray(list) || list.length !== batch.length) {
        throw new Error('embedding response is missing the embeddings array (expected Ollama /api/embed)')
      }
      return list.map((v) => {
        if (!Array.isArray(v) || v.length === 0) throw new Error('embedding response contains an empty vector')
        return normalizeVec(v)
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Vector index over the memory library, keyed by a sha1 signature of each
 * file's text: unchanged files are never re-embedded (first search after a
 * change pays the cost of the changed file only). With `cachePath` set the
 * signature→vector map persists across dsh restarts (see the module header).
 */
export class VectorIndex {
  /**
   * @param {EmbeddingClient} client
   * @param {{threshold?: number, cachePath?: string|null}} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client
    this.threshold = opts.threshold ?? VEC_THRESHOLD
    this.cachePath = opts.cachePath ?? null
    /** @type {Map<string, {sig: string, date: string, kind: string, blocks: Array<{title: string, text: string, vec: number[]}>}>} */
    this.files = new Map()
    this.refreshing = null
    this.cacheDirty = false
    this.loadCache()
  }

  sig(text) {
    return createHash('sha1').update(String(text)).digest('hex')
  }

  /** Best-effort cache load: absent, corrupt, version-mismatched, or
   * built by another model all degrade to a cold in-memory start. */
  loadCache() {
    if (!this.cachePath) return
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8'))
      if (raw?.version !== VEC_CACHE_VERSION || raw?.model !== this.client.model || typeof raw?.files !== 'object') return
      for (const [rel, entry] of Object.entries(raw.files)) {
        if (typeof entry?.sig !== 'string' || !Array.isArray(entry?.blocks)) continue
        this.files.set(rel, {
          sig: entry.sig,
          date: String(entry.date ?? ''),
          kind: String(entry.kind ?? 'note'),
          blocks: entry.blocks
            .filter((b) => typeof b?.t === 'string' && Array.isArray(b?.v) && b.v.every((x) => Number.isFinite(x)))
            .map((b) => ({ title: b.t, text: String(b.x ?? ''), vec: b.v })),
        })
      }
    } catch {
      // no cache file yet, or an unreadable one — start cold, never throw
    }
  }

  /** Persist the index (atomic tmp+rename) when anything changed; failures
   * only cost the next restart a rebuild, so they warn instead of throwing. */
  saveCache() {
    if (!this.cachePath || !this.cacheDirty) return
    try {
      const payload = { version: VEC_CACHE_VERSION, model: this.client.model, files: {} }
      for (const [rel, entry] of this.files.entries()) {
        payload.files[rel] = {
          sig: entry.sig,
          date: entry.date,
          kind: entry.kind,
          blocks: entry.blocks.map((b) => ({ t: b.title, x: b.text, v: b.vec.map((x) => Number(x.toFixed(VEC_DECIMALS))) })),
        }
      }
      mkdirSync(dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.tmp-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(payload))
      renameSync(tmp, this.cachePath)
      this.cacheDirty = false
    } catch (error) {
      console.warn(`dsh-memory: vector cache write failed (${error?.message ?? String(error)})`)
    }
  }

  /**
   * Re-embed every entry whose text signature changed; drop files that
   * disappeared (window expiry, deletion, rename — query() always refreshes
   * against the current walk before scoring, so the live index is the
   * cache∩walk intersection). Concurrent calls share one refresh (a burst of
   * searches embeds once). Throws when the embedding service is unreachable;
   * persistence happens only after a fully successful pass.
   * @param {Array<{rel: string, date: string, kind: string, text: string}>} entries
   */
  async refresh(entries) {
    const stale = new Set(this.files.keys())
    for (const entry of entries) {
      stale.delete(entry.rel)
      const sig = this.sig(entry.text)
      const cached = this.files.get(entry.rel)
      if (cached !== undefined && cached.sig === sig) continue
      // title-only blocks (headings with no body) carry no signal and
      // only produce noise vectors — skip them here; the file text still
      // participates in substring search
      const sections = splitBlocks(entry.text).filter(
        (s) => s.text.replace(/^(?:#{1,6}\s[^\n]*\n?)+/, '').trim() !== '',
      )
      const vectors = await this.client.embed(sections.map((s) => s.text))
      const blocks = sections.map((s, i) => ({ title: s.title, text: s.text, vec: vectors[i] }))
      this.files.set(entry.rel, { sig, date: entry.date, kind: entry.kind, blocks })
      this.cacheDirty = true
    }
    for (const rel of stale) {
      this.files.delete(rel)
      this.cacheDirty = true
    }
    this.saveCache()
  }

  /**
   * Refresh (if needed), embed the query, and return the top vector hits as
   * section-level results (rel carries a `#title` suffix).
   * @param {Array<object>} entries - walkMemory() output
   * @param {string} query
   * @param {number} [topK=20]
   * @returns {Promise<Array<{rel: string, date: string, kind: string, score: number, snippet: string}>>}
   */
  async query(entries, query, topK = 20) {
    if (this.refreshing === null) {
      this.refreshing = this.refresh(entries).finally(() => {
        this.refreshing = null
      })
    }
    // embed([query]) resolves to [vec]; destructure twice (once for the
    // Promise.all value, once for the single-element embed result)
    const [[qv]] = await Promise.all([this.client.embed([query]), this.refreshing])
    const scored = []
    for (const [rel, file] of this.files.entries()) {
      for (const block of file.blocks) {
        const sim = cosine(qv, block.vec)
        if (sim < this.threshold) continue
        scored.push({
          rel: block.title ? `${rel}#${block.title}` : rel,
          date: file.date,
          kind: file.kind,
          score: sim,
          snippet: blockSnippet(block.text, ''),
        })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

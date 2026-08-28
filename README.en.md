English | [中文](README.md)

# dsh-memory

A cross-session memory plugin for DeepSeek Harness (dsh).

The main agent decides whether this turn produced anything worth keeping
across sessions: a **per-turn system-prompt reminder** ("when this turn has
something worth keeping, you MUST use the memory tool" — off via
`autoMemory: false`) points the timing at the **`memory` file tool**
(read/write/edit modes, mirroring the native file-tool contract, with its
read/write surface locked to this plugin's data root `$DSH_HOME/dsh-memory`;
its description carries the usage mechanics and organization rules), and the
**`memory_search` tool** retrieves the notes with **block-level search**
(optional vector fusion, per-day recency decay). Writes into the long-term
layer FOLLOW the composition of the search results — only memory that gets
searched proves worth remembering; it is never pre-judged at capture time.
Bundle plugin form (`dsh.bundle`) — 0 patches, **zero npm dependencies, zero
build step**; `@deepseek-ai/*` resolves through dsh's flat module fallback,
so the runtime shares one package instance.

> ⚠️ **Use with caution.** A memory system designed around personal ideas
> (after studying several agents) — works well for me but may not suit
> everyone. The storage layout, tool interface, and config options may change
> frequently and WITHOUT compatibility guarantees (breaking changes are the
> norm). Check the commit history before upgrading, and back up your memory
> files under `$DSH_HOME/dsh-memory/` if they matter to you.

## Features

| Feature | Description |
|---|---|
| **Per-turn reminder (optional)** | A short system-prompt reminder assembled on every request, TIMING ONLY: "when this turn has something worth keeping across sessions, you MUST use the memory tool". Turn it off with `autoMemory: false` for a "record only when asked" style; the `memory` tool stays usable. Usage mechanics and organization rules live entirely in the `memory` tool description |
| **memory tool (three-mode file tool, 2026-08-28)** | **No arguments = read today's note**: returns the full text of this workspace's note for today (ABSENT — listing existing long-term topics — when there is none, zero disk writes); `mode:"write"` + `content` creates or fully replaces; `mode:"edit"` + `old_string`/`new_string` (+`replace_all`) does a unique literal replace; the optional `topic` parameter targets a long-term library file `topics/<topic>.md`. **Observation guard mirrors the native tools**: per-session present/absent + version records — write refused when the file exists but was not read this session (createIfAbsent), write/edit refused when the file changed since that read (CAS "read it again"), edit refused when unread (FS_NOT_OBSERVED), old_string refused on multiple matches (FS_AMBIGUOUS_EDIT); atomic tmp+rename writes. **The plugin writes its own data root directly** (trusted node:fs writes; paths are tool-derived or whitelist-validated, the model only supplies content) — bypassing the sandbox fence built into the fs backend (its per-write manual escalation is unusable for automatic capture), so **capture works under every permission mode, workspace-write included**. **Organization rules live in the description**: record experience, not play-by-play; `#` headings; merge related topics; correct outdated statements in place — sent with the tool schema on every request |
| **memory_search tool** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), **single-field positional keyword scoring** (2026-08-25): ONE `keywords` parameter holding up to 5 space-separated terms — the **first 3 at high weight** (×3 each hit), the next 2 at low weight (×1 each) — partial credit per matched keyword, no hard AND gate; a **coverage floor `MIN_COVERAGE=0.3`** (2026-08-29): a block must account for at least 30% of the query's realized evidence — matching 1 of many terms is cut, and wrong/generic keywords never inflate the bar; **IDF term weighting** (2026-08-29): normalized by corpus document frequency — a corpus-unique term keeps its full weight while a term present in EVERY block scales toward 0 (generic words alone can no longer clear `MIN_SCORE=0.5`, the fix for irrelevant hits pulled in by frequent words); absent/everywhere keywords are reported back in the notices; **ASCII word boundaries** (2026-08-29): pure-alphabetic terms match on word boundaries (`log` no longer hits `catalog`), digit/dot-bearing version strings and CJK keep substring semantics; a **minimum-score floor `MIN_SCORE=0.5`**; formatting-tolerant matching, occurrence counts normalized by block length, **per-day decay** (30-day half-life, floor 0.4); snippets return whole blocks (≤1000 chars); **every hit carries its ABSOLUTE path**. The promotion/correction hint is COMPOSITION-DRIVEN and appended to the output (2026-08-29): a long-term block among the hits ⇒ treat as authoritative, fix stale statements in place, merge overlapping topic files; daily-only hits ⇒ file proved-lasting facts into `topics/<topic>.md` via the memory tool; empty results report keyword health only |
| **Two-layer library** | Diary layer `YYYY-MM-DD/` (ephemeral, **hard window** `dailyWindowDays` default 45 days — agent work iterates fast, so aged notes leave the searchable corpus but stay on disk; 0 = unlimited) + long-term layer `topics/<topic>.md` (**free topic files**, 2026-08-28: one topic per file, never decays, never windowed; the search layer supports this with zero changes). Division of labor: **experience that still holds in another project goes to the long-term layer** (environment/tooling lessons, collaboration preferences, general patterns); play-by-play events go to the diary; **must-follow rules belong in AGENTS.md, not memory**; durable project-specific facts graduate into AGENTS.md or age out with the diary window (an accepted trade-off that forces curation). **The long-term layer is consolidated at reuse time only** — writes follow the search-result composition, never pre-judged at capture. No hit counters, zero state files |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to keyword + vector RRF fusion (k=60); the vector index **persists to `<memory root>/.vector-cache.json`** (sha1 signature-keyed — zero rebuild after a dsh restart; window-expired/deleted/renamed files are pruned at refresh; a model change invalidates it wholesale); falls back to pure keyword matching when the service is down — `memory_search` never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — the per-turn reminder tells the model when the `memory` tool
must be used; retrieval goes through the `memory_search` tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched. Root resolution: **`AGENT_MEMORY_HOME` wins** (one library shared
with other agents, see the sharing section below), otherwise the plugin data
root `$DSH_HOME/dsh-memory` — a missing variable keeps the old path, so the
library can never fork:

```
<memory root>/
├── topics/
│   ├── <topic>.md          # long-term memory: one topic per file (short kebab-case names), never decays, never windowed
│   └── ...
└── YYYY-MM-DD/
    └── <workspace-slug>.md # one file per workspace per day (diary layer, subject to the search window)
```

- **Two-layer semantics**: play-by-play events go to the diary; the long-term
  topic files are consolidated AT REUSE TIME ONLY — whether to write follows
  the search-result composition (a hit long-term block is authoritative,
  stale statements corrected in place, overlaps merged; daily-only hits with
  proved-lasting facts → write into `topics/<topic>.md`), never pre-judged at
  capture
- **Rename transition** (2026-08-29, `memory/` → `topics/`): the search index
  covers ANY non-date directory, so existing files under the old `memory/`
  stay searchable and readable; new writes always land in `topics/`
- **No capture bookkeeping**: no watermarks, turn counters, or hit counters; dates and
  the window are resolved at query time and roll over to the new day's file
  automatically at midnight. The only derived file on disk is the vector
  cache `.vector-cache.json` (only when vectors are configured; regenerable,
  invisible to the search corpus and to other agents)
- rel paths carry the date, so every hit's age is visible at a glance

## Install

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

The package declares `dsh.bundle.patch`, so it is activated as a profile bundle
layer (not just an inert dependency). **Restart `dsh web`** after installing;
toggle it any time from the Plugins panel in settings. To update: push to
GitHub, then `dsh plugin --profile web update dsh-memory` + restart (git
dependencies are cached per commit, so an update is required to pick up new
commits).

> Zero npm dependencies: `@deepseek-ai/*` resolves at runtime through dsh's
> flat module fallback (`$DSH_HOME/profiles/node_modules`), sharing the same
> package instances as the running dsh.

## How it works

- `src/index.js`: the per-turn reminder is a `systemPrompt.context`
  contribution (`dsh-memory:auto`, order 200) gated on `autoMemory` and on
  subagents (delegationDepth > 0) — its text carries timing only; the
  three-mode `memory` file tool — no args (or `mode:"read"`) returns the full
  text of today's note / a topic file and records the observation;
  `mode:"write"` goes through the createIfAbsent/CAS guard and then publishes
  atomically (tmp + rename); `mode:"edit"` validates the observation and
  unique match before a read-modify-write. The observation guard is keyed per
  session (mirroring `@deepseek-ai/dsh-fs-observation-policy`), and all file
  work is done by the **plugin itself** via node:fs (the sandbox fence lives
  inside the fs backend — `dsh-fs-sandbox`'s `checkedTarget`; both the native
  pipeline and direct `ctx.fs` calls refuse `$DSH_HOME` writes under
  workspace-write, and the tool layer's only widening path needs per-write
  manual approval; a plugin writing its own data root is trusted host
  behavior, with path derivation/whitelisting keeping the write surface
  bounded). `memory_search` ends its output with a composition-branched
  consolidation hint
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  **single-field positional keyword scoring** — one `keywords` string split on
  whitespace, the **first 3 terms are essential (×3 per hit)** and the **next
  4 refining (×1)**, first-occurrence dedupe, over-cap drops reported back;
  **IDF term weighting** (BM25-style idf normalized over the corpus: df=1 weighs exactly 1, df=N weighs ~0 — generic words cannot carry a hit) and **word-boundary counting for pure-alphabetic ASCII keywords** (`log` ≠ `catalog`); partial credit per matched keyword; the weighted count is normalized by
  block length; each block's score is multiplied by `max(0.4, 0.5^(days/30))`
  (per-day decay); blocks under `MIN_SCORE=0.5` never return; exact dedup via
  `rel#breadcrumb`
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: pure-function vocabulary — path/slug/date derivation (both
  slash spellings of a cwd normalize to one slug), memory-root resolution
  (`AGENT_MEMORY_HOME` first, falling back to `$DSH_HOME/dsh-memory` — a
  missing variable can never fork the library), `walkMemory(windowDays)`
  (the hard window applies ONLY to subdirectories whose name parses as a
  date — aged diaries leave the index but stay on disk; non-date dirs like
  `topics/` are always indexed)
- `client/bundle.js`: hand-written client bundle registering into the
  `settings.plugin.item` keyed slot (`key: 'dsh-memory'`); reads and writes go
  through the official client settings scope (`ctx.settingsScope.bind`) —
  revision-fenced mutations, mirror refreshes on document commits/reconnects
- New-vs-old conflicts resolve at query time: decay favors newer notes, and
  the tool description instructs merging multiple hits on the same topic
  instead of trusting only the newest one

## Usage

```sh
# model-side tool: search the memory library (ONE keywords parameter, up to 7
# terms, most essential FIRST)
memory_search keywords="vector search threshold embedding"

# model-side tool: read today's memory note (no args = read) — returns the
# full text; ABSENT means there is none yet
memory

# create (mode:"write") / modify in place (mode:"edit")
memory mode="write" content="# Topic ..."
memory mode="edit" old_string="old sentence" new_string="new sentence"

# cross-project evergreen experience goes into long-term topic files
# (usually following the consolidation hint in the search results)
memory topic="windows-env" mode="write" content="# Windows environment lessons ..."
memory topic="windows-env" mode="edit" old_string="pnpm dual instance" new_string="pnpm dual instance (avoid via --allow-scripts since 2026-08)"
```

With `autoMemory: true` (default) every turn carries a short reminder — when
this turn produced something worth keeping across sessions, the `memory` tool
**must** be used. With `autoMemory: false` there is no reminder — record only
when asked.

## Sharing with other agents (skill half)

`skill/agent-memory/` is the library's **portable half**: a zero-dependency CLI
(`mem.mjs`) plus an Agent Skill definition (`SKILL.md`) that lets agents other
than dsh (anything with a shell + node, e.g. ZCode) read and write **the same**
memory library.

- **One library, one variable**: the dsh plugin and this CLI resolve **the
  same** `AGENT_MEMORY_HOME` (recommended value: the plugin data root
  `D:\agent\.dsh\dsh-memory` — zero migration for existing notes; restart dsh
  after changing it). The CLI side accepts **only this variable** — no
  default, no flag override, a hard refusal when unset, so it can never
  silently create a second, divergent library; `search.js` is
  **byte-identical** to the plugin's `src/search.js` (enforced by a test), so
  ranking behaves identically
- **Stateless write guard**: reads print `[hash: ...]`; `write` on an existing
  file and every `edit` require `--expect-hash` (content-hash CAS); every
  mutation prints the NEW hash so edits can chain. Everything else (two-layer
  layout, positional scoring, long-term seat, composition-driven hints) matches
  the plugin; only the optional vector fusion is dropped (keeps it
  dependency-free)
- **Install**: copy the whole `skill/agent-memory/` folder into the target
  agent's skill directory (e.g. ZCode's `~/.zcode/skills/` or a project's
  `.agents/skills/`); dsh needs no action — the `package.json` `files`
  whitelist excludes `skill/`, so **plugin installs/updates never carry it**
- **Boundary**: the per-turn reminder (capture timing) is a dsh-plugin
  capability; other agents are naturally read-mostly, write-on-demand. If you
  want timing guidance there, add one line to the agent's instructions file

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  searchLimit: 2            # number of results returned by memory_search (1-10); a hard cap the agent cannot override; a long-term block is still surfaced by the longtermAppend seat
  dailyWindowDays: 45       # diary hard window in days: aged diaries stop participating in search (0 = unlimited); topics/ is exempt
  embeddingBaseUrl: ''      # Ollama-compatible /api/embed base URL (e.g. http://localhost:11434); empty disables vector search
  embeddingModel: 'bge-m3'  # embedding model name
  autoMemory: true          # per-turn reminder ("worth keeping -> must use the memory tool"); false = record only when asked
  longtermAppend: true      # when no long-term block made the list, append the best-ranking one (no eviction); false = pure top-N
```

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero dependencies, zero build step; with no embedding service
  configured there are no network calls at all

## License

MIT

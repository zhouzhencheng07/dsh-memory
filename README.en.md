English | [中文](README.md)

# dsh-memory

A cross-session global memory plugin for DeepSeek Harness (dsh).

The main agent decides whether this turn produced anything worth keeping
across sessions: a **per-turn system-prompt reminder** ("when this turn has
something worth keeping, you MUST use the memory tool" — off via
`autoMemory: false`) nudges it to capture through the path-locating **`memory`
tool**, which returns today's memory note path (creating it automatically and
maintaining the session-source comment); the note is then maintained with the
plain **native read/write/edit tools**, and all timing/content rules live in
the `memory` tool description (sent with the tool schema on every request).
The `memory_search` tool retrieves those notes with **block-level search**
(optional vector fusion, per-day recency decay). Ships as a bundle plugin
(`dsh.bundle`) — 0 patches, **zero npm dependencies, zero build step**;
`@deepseek-ai/*` resolves through dsh's flat module fallback, so the runtime
shares one package instance.

## Features

| Feature | Description |
|---|---|
| **Per-turn reminder (optional)** | A short system-prompt reminder assembled on every request: "when this turn has something worth keeping across sessions, you MUST use the memory tool". Deliberately terse — the timing, content rules, and usage live in the `memory` tool description. Turn it off with `autoMemory: false` for a "record only when asked" style; the neutral `memory` tool stays usable |
| **memory tool** | A path locator with **no arguments**: returns today's memory note for this workspace (one file per workspace per day). When the file is absent it is **created** (content = the `<!-- 会话来源: ... -->` session-source comment); when present the calling session is merged into that comment (exactly idempotent). The description carries the capture timing (decisions and reasons, user corrections/conventions, pitfalls and fixes, reusable commands/processes, state changes) and the quality rules (read before modify; edit local changes, write to create/replace the whole file; # headings per topic, merge related topics, fix outdated items in a sentence or two, no play-by-play). All file work dispatches the host's **native read/write pipeline** — same sandbox fence and read-before-modify observation as the model's own file tools (`$DSH_HOME` writes need danger-full-access) |
| **memory_search tool** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), **two-group keyword scoring** (2026-08-24): `primary` ≤2 keywords at high weight (×3 each hit) + `secondary` ≤3 at low weight (×1 each) — partial credit per matched keyword, no hard AND gate (a block missing some words no longer vanishes); formatting-tolerant matching, occurrence counts normalized by block length, **per-day decay** (30-day half-life, floor 0.4); snippets return whole blocks (≤1000 chars, usually no need to open the file) |
| **Two-layer library (2026-08-24)** | Diary layer `YYYY-MM-DD/` (ephemeral, **hard window** `dailyWindowDays` default 90 days — aged notes leave the searchable corpus but stay on disk; 0 = unlimited) + long-term layer `memory/memory.md` (ONE file organized by topic headings, **never decays, never windowed**). Composition-based hints at query time: long-term blocks in the results → they win conflicts, stale statements get fixed and missing lasting facts supplemented in place; diary-only results with aged hits → suggest supplementing memory.md (**old diaries get no maintenance** — they decay and age out on their own; same-day corrections belong to the `memory` tool). When no long-term block makes the list, the LAST slot is reserved for it (with limit ≥ 2). No hit counters, zero state files |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to keyword + vector RRF fusion (k=60); falls back to pure keyword matching when the service is down — `memory_search` never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — the per-turn reminder (when enabled) tells the model when the
`memory` tool must be used; retrieval goes through the `memory_search` tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched:

```
$DSH_HOME/dsh-memory/
├── memory/
│   └── memory.md           # long-term memory: ONE file organized by topic headings, never decays, never windowed
└── YYYY-MM-DD/
    └── <workspace-slug>.md # one file per workspace per day (diary layer, subject to the search window)
```

- **Two-layer semantics**: today's work goes to the diary; lasting facts
  (user preferences, environment facts, standing conventions) are promoted by
  the agent into `memory/memory.md` topic blocks AT REUSE TIME — when a search
  surfaces them (read-before-edit; outdated statements are corrected in place,
  so the single source of truth converges in that one file). Diary originals
  are never rewritten back; they simply age out of the window.
- **No state files**: no watermarks, turn counters, or hit counters; dates and
  the window are resolved at query time and roll over to the new day's file
  automatically at midnight
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

- `src/index.js`: the path-locating `memory` tool (no arguments) — computes
  today's note path from the session cwd, probes it with a dispatched native
  `read` (records the observation, so the merge below passes the version
  guard), then dispatches a native `write` when the file is absent (creating
  it with the source comment) or when the calling session id is missing from
  the comment (idempotent, no write otherwise); plus the per-turn reminder, a
  `systemPrompt.context` contribution (`dsh-memory:auto`, order 200) gated on
  `autoMemory` and on subagents — its text is deliberately short, all rules
  live in the tool description. **No host hooks** (no `tools/result` /
  turn-stopping listeners): a session that knows the note path has already
  called the `memory` tool, so its source is already maintained
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  **two-group keyword scoring** — `primary` (≤2, essential terms) scores ×3
  per hit, `secondary` (≤3, refining terms) ×1, partial credit per matched
  keyword (2026-08-24, replacing the old tier scheme whose tier-3 hard AND
  zeroed blocks matching only some words — the measured root cause of
  misses); both sides go through `looseNormalize` (formatting marks stripped,
  identifiers `-` `_` `.` kept); the weighted count is normalized by block
  length; each block's score is multiplied by `max(0.4, 0.5^(days/30))`
  (per-day decay); exact dedup via `rel#breadcrumb`
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: pure-function vocabulary — path/slug/date derivation,
  provenance-comment parsing and merging (`mergeProvenance`, exactly
  idempotent), `walkMemory(windowDays)` (the hard window applies ONLY to
  subdirectories whose name parses as a date — aged diaries leave the index
  but stay on disk; non-date dirs like `memory/` are always indexed. The
  plugin never writes to disk directly; file work goes through the dispatched
  native read/write tools)
- `client/bundle.js`: hand-written client bundle registering into the
  `settings.plugin.item` keyed slot (`key: 'dsh-memory'`); reads and writes go
  through the official client settings scope (`ctx.settingsScope.bind`) —
  revision-fenced mutations, mirror refreshes on document commits/reconnects.
  (The pre-rc.7 hand-rolled `/dsh-memory/config` HTTP endpoint was removed:
  dsh rc.7 dropped the api-proxy namespace whitelist that had forced it.)
- New-vs-old conflicts resolve at query time: decay favors newer notes, and the
  tool description instructs merging multiple hits on the same topic instead of
  trusting only the newest one

## Usage

```sh
# model-side tool: search the memory library (two keyword groups: primary ≤2
# high-weight, secondary ≤3 low-weight; partial credit per matched keyword —
# older notes rank lower but stay reachable, newer notes win)
memory_search primary="vector search threshold" secondary="embedding"

# model-side tool: locate today's memory note — returns the path, creates the
# file (with the source comment) when absent, merges this session into the
# source comment when present
memory

# then maintain the note with the NATIVE file tools (read before modify):
read file_path="<path from memory>"
edit file_path="<path>" old_string="..." new_string="..."
# or write file_path="<path>" content="# Topic ..." to create/replace the whole file
```

With `autoMemory: true` (default) every turn carries a short reminder — when
this turn produced something worth keeping across sessions, the `memory` tool
**must** be used; the file's leading `<!-- 会话来源: ... -->` comment is
maintained automatically by the tool. With `autoMemory: false` there is no
reminder — record only when asked (the tool description stays neutral, no
"must" wording).

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  searchLimit: 5            # number of results returned by memory_search (1-10); a hard cap the agent cannot override
  dailyWindowDays: 90       # diary hard window in days: aged diaries stop participating in search (0 = unlimited); memory/ is exempt
  embeddingBaseUrl: ''      # Ollama-compatible /api/embed base URL (e.g. http://localhost:11434); empty disables vector search
  embeddingModel: 'bge-m3'  # embedding model name
  autoMemory: true          # per-turn reminder ("worth keeping -> must use the memory tool"); false = record only when asked
```

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero dependencies, zero build step; with no embedding service
  configured there are no network calls at all

## License

MIT

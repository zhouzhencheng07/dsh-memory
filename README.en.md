English | [中文](README.md)

# dsh-memory

A cross-session global memory plugin for DeepSeek Harness (dsh).

The main agent decides on its own whether this turn produced anything worth
keeping across sessions and reads/writes it through the path-fixed **`memory`
tool** (mode=read | write | edit) — the capture timing and the quality rules
live entirely in the tool description (sent with the tool schema on every
request, **no per-turn system-prompt reminder**); the `memory_search` tool
retrieves those notes with **block-level search** (optional vector fusion,
per-day recency decay). Ships as a bundle plugin (`dsh.bundle`) — 0 patches,
**zero npm dependencies, zero build step**; `@deepseek-ai/*` resolves through
dsh's flat module fallback, so the runtime shares one package instance.

## Features

| Feature | Description |
|---|---|
| **Tool-driven capture** | The `memory` tool description carries both the timing (decisions, user corrections, pitfalls, reusable commands, state changes) and the quality rules (merge-first, deprecated alternatives in a sentence or two, split long sections, no diary-style logs); the main agent decides when to use it — no per-turn system-prompt reminder |
| **memory_search tool** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), tiered keyword matching (exact ×1.0 → formatting-tolerant ×0.95 → multi-keyword AND ×0.7 — fuzziness allowed but scored down, exact always wins), **per-day decay** (30-day half-life, floor 0.4 — older notes rank lower but never vanish), snippets return whole blocks (≤1000 chars, usually no need to open the file) |
| **memory tool** | One tool, three modes (`read`/`write`/`edit`): it computes today's workspace memory note internally (the model never supplies the path — but every result echoes it, so one call teaches the path for native tools), and dispatches the host's **native read/write/edit pipeline** — the same sandbox fence and read-before-modify observation as the model's own file tools (mode=edit on an unread note is denied; mode=write over an existing unread note is denied; `$DSH_HOME` writes need danger-full-access); the leading `<!-- 会话来源: ... -->` provenance comment is maintained automatically (merged on write, one follow-up write after edit) |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to keyword + vector RRF fusion (k=60); falls back to pure keyword matching when the service is down — `memory_search` never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — writing happens on the model's own judgment guided by the tool
descriptions, retrieval via the `memory_search` tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched:

```
$DSH_HOME/dsh-memory/
└── YYYY-MM-DD/
    └── <workspace-slug>.md   # one file per workspace per day, normal markdown headings
```

- **No state files**: no watermarks or turn counters; the date is resolved when
  `memory_write` executes and rolls over to the new day's file automatically at
  midnight
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

- `src/index.js`: the single path-fixed `memory` tool (modes `read`/`write`/
  `edit`) — each mode dispatches the host's native read/write/edit through
  `ctx.tools.execute()` (same sandbox fence, same read-before-modify
  observation; mode=write merges the provenance comment into the content
  before writing, mode=edit runs one provenance follow-up write after a
  successful edit); every result echoes the file path
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  tiered keyword matching — whole-query literal ×1.0 → formatting-tolerant
  literal (backticks/quotes/bold marks stripped, identifiers kept) ×0.95 →
  multi-keyword AND fallback ×0.7, occurrence counts normalized by block
  length; each block's score is multiplied by `max(0.4, 0.5^(days/30))`
  (per-day decay); exact dedup via `rel#breadcrumb`
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: pure-function vocabulary — path/slug/date derivation,
  provenance-comment parsing and merging, `walkMemory` (the plugin never
  writes to disk itself; all mutations go through the dispatched native
  tools)
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
# model-side tool: search the memory library (older notes rank lower but stay reachable)
memory_search query="vector search threshold"

# model-side tool: read today's memory (returns path + line-numbered content;
# also satisfies the read-before-modify rule)
memory mode="read"

# model-side tool: fully replace today's memory (timing and rules live in the
# tool description; requires danger-full-access for $DSH_HOME; created when
# absent, existing notes need a prior read)
memory mode="write" content="# Topic

- point ……"

# model-side tool: edit a portion (denied on an unread note — mode=read first)
memory mode="edit" old_string="old sentence" new_string="new sentence"
```

Memory needs no action: the tool description carries both timing and
discipline — the main agent decides on its own. Every result echoes the file
path, so one call teaches the path and native tools can be used afterwards.

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  searchLimit: 5            # number of results returned by memory_search (1-10); a hard cap the agent cannot override
  embeddingBaseUrl: ''      # Ollama-compatible /api/embed base URL (e.g. http://localhost:11434); empty disables vector search
  embeddingModel: 'bge-m3'  # embedding model name
```

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero dependencies, zero build step; with no embedding service
  configured there are no network calls at all

## License

MIT

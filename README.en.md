English | [中文](README.md)

# dsh-memory

A cross-session global memory plugin for DeepSeek Harness (dsh).

On every model request the main agent receives an auto-memory reminder in the
system prompt, decides whether this turn produced anything worth keeping across
sessions, and **incrementally writes** a daily memory note; the `memory_search`
tool retrieves those notes with **block-level search** (optional vector fusion,
per-day recency decay). Ships as a bundle plugin (`dsh.bundle`) — 0 patches,
**zero npm dependencies, zero build step**; `@deepseek-ai/*` resolves through
dsh's flat module fallback, so the runtime shares one package instance.

## Features

| Feature | Description |
|---|---|
| **Auto-Memory** | Injects a memory reminder into the system prompt every turn (`dsh-memory:auto`, order 200); the main agent curates notes with dsh's built-in read/edit/write; sub-agents are not reminded; `autoMemory: false` turns it off instantly |
| **memory_search tool** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), length-normalized substring matching (CJK-friendly), **per-day decay** (30-day half-life, floor 0.4 — older notes rank lower but never vanish), snippets return whole blocks (≤1000 chars, usually no need to open the file) |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to substring + vector RRF fusion (k=60); falls back to pure substring when the service is down — `memory_search` never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — writing happens via the per-turn reminder, retrieval via the
`memory_search` tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched:

```
$DSH_HOME/dsh-memory/
└── YYYY-MM-DD/
    └── <workspace-slug>.md   # one file per workspace per day, normal markdown headings
```

- **No state files**: no watermarks or turn counters; the date is taken at
  assembly time and rolls over to the new day's file automatically at midnight
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

### Local development

```bash
# local development: replace the path with your local checkout directory
dsh plugin --profile web add "file:/path/to/dsh-memory"
```

## How it works

- `src/auto.js`: Auto-Memory — registers a system prompt context (order 200)
  re-evaluated on every request assembly; the reminder's file path uses today's
  date; the main agent writes or skips on its own — no background LLM calls, no
  watermark, no retries
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  case-insensitive substring hits normalized by block length; each block's
  score is multiplied by `max(0.4, 0.5^(days/30))` (per-day decay); exact dedup
  via `rel#breadcrumb`
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: reads/writes the daily notes under `$DSH_HOME/dsh-memory/`
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
```

Auto-Memory needs no action: once enabled, every turn gets the reminder and the
main agent decides what to write.

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  searchLimit: 5            # default number of results returned by memory_search (1-10)
  embeddingBaseUrl: ''      # Ollama-compatible /api/embed base URL (e.g. http://localhost:11434); empty disables vector search
  embeddingModel: 'bge-m3'  # embedding model name
  autoMemory: true          # auto-memory switch: false = no more reminders
```

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero dependencies, zero build step; with no embedding service
  configured there are no network calls at all

## License

MIT

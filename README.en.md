English | [中文](README.md)

# dsh-memory

A cross-session memory plugin for DeepSeek Harness (dsh).

Two model-side tools make up the whole mechanism: the **`memory` file tool**
(read/write/edit modes, mirroring the native file-tool contract, with its
read/write surface locked to this plugin's data root `$DSH_HOME/dsh-memory`)
maintains the notes, and the **`memory_search` tool** retrieves them with
**block-level search** (optional vector fusion, per-day recency decay).
Capture timing and writing etiquette are NOT in the plugin — they live in the
user's global AGENTS.md (see the suggested rules block at the end); the plugin
ships pure mechanism. Bundle plugin form (`dsh.bundle`) — 0 patches, **zero
npm dependencies, zero build step**; `@deepseek-ai/*` resolves through dsh's
flat module fallback, so the runtime shares one package instance.

## Features

| Feature | Description |
|---|---|
| **memory tool (three-mode file tool, 2026-08-28)** | **No arguments = read today's note**: returns the full text of this workspace's note for today (ABSENT — listing existing long-term topics — when there is none, zero disk writes); `mode:"write"` + `content` creates or fully replaces; `mode:"edit"` + `old_string`/`new_string` (+`replace_all`) does a unique literal replace; the optional `topic` parameter targets a long-term library file `memory/<topic>.md`. **Observation guard mirrors the native tools**: per-session present/absent + version records — write refused when the file exists but was not read this session (createIfAbsent), write/edit refused when the file changed since that read (CAS "read it again"), edit refused when unread (FS_NOT_OBSERVED), old_string refused on multiple matches (FS_AMBIGUOUS_EDIT); atomic tmp+rename writes. **The plugin writes its own data root directly** (trusted node:fs writes; paths are tool-derived or whitelist-validated, the model only supplies content) — bypassing the sandbox fence built into the fs backend (its per-write manual escalation is unusable for automatic capture), so **capture works under every permission mode, workspace-write included** |
| **memory_search tool** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), **single-field positional keyword scoring** (2026-08-25): ONE `keywords` parameter holding up to 7 space-separated terms — the **first 3 at high weight** (×3 each hit), the next 4 at low weight (×1 each) — partial credit per matched keyword, no hard AND gate; a **minimum-score floor `MIN_SCORE=0.5`**; formatting-tolerant matching, occurrence counts normalized by block length, **per-day decay** (30-day half-life, floor 0.4); snippets return whole blocks (≤1000 chars); **every hit carries its ABSOLUTE path**. Pure retrieval (2026-08-28): no promotion hint is appended anymore |
| **Two-layer library** | Diary layer `YYYY-MM-DD/` (ephemeral, **hard window** `dailyWindowDays` default 90 days — aged notes leave the searchable corpus but stay on disk; 0 = unlimited) + long-term layer `memory/<topic>.md` (**free topic files**, 2026-08-28: one topic per file, never decays, never windowed; the search layer supports this with zero changes). Division of labor: **experience that still holds in another project goes to the long-term layer** (environment/tooling lessons, collaboration preferences, general patterns); play-by-play events go to the diary; **must-follow rules belong in AGENTS.md, not memory**; durable project-specific facts graduate into AGENTS.md or age out with the diary window (an accepted trade-off that forces curation). No hit counters, zero state files |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to keyword + vector RRF fusion (k=60); falls back to pure keyword matching when the service is down — `memory_search` never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — capture timing and etiquette live in the user's global AGENTS.md;
retrieval goes through the `memory_search` tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched:

```
$DSH_HOME/dsh-memory/
├── memory/
│   ├── <topic>.md          # long-term memory: one topic per file (short kebab-case names), never decays, never windowed
│   └── ...
└── YYYY-MM-DD/
    └── <workspace-slug>.md # one file per workspace per day (diary layer, subject to the search window)
```

- **Two-layer semantics**: play-by-play events go to the diary; cross-project
  evergreen experience goes to long-term topic files (via the `topic`
  parameter — routed at capture time by the user's AGENTS.md rules, or
  promoted at reuse time: a hit long-term block is authoritative, outdated
  statements are corrected in place, near-duplicates merged)
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

- `src/index.js`: the three-mode `memory` file tool — no args (or
  `mode:"read"`) returns the full text of today's note / a topic file and
  records the observation; `mode:"write"` goes through the createIfAbsent/CAS
  guard and then publishes atomically (tmp + rename); `mode:"edit"` validates
  the observation and unique match before a read-modify-write. The
  observation guard is keyed per session (mirroring
  `@deepseek-ai/dsh-fs-observation-policy`), and all file work is done by the
  **plugin itself** via node:fs (the sandbox fence lives inside the fs
  backend — `dsh-fs-sandbox`'s `checkedTarget`; both the native pipeline and
  direct `ctx.fs` calls refuse `$DSH_HOME` writes under workspace-write, and
  the tool layer's only widening path needs per-write manual approval; a
  plugin writing its own data root is trusted host behavior, with
  path derivation/whitelisting keeping the write surface bounded). **No host
  hooks, no per-turn reminder** (etiquette externalized to AGENTS.md since
  2026-08-28)
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  **single-field positional keyword scoring** — one `keywords` string split on
  whitespace, the **first 3 terms are essential (×3 per hit)** and the **next
  4 refining (×1)**, first-occurrence dedupe, over-cap drops reported back;
  partial credit per matched keyword; the weighted count is normalized by
  block length; each block's score is multiplied by `max(0.4, 0.5^(days/30))`
  (per-day decay); blocks under `MIN_SCORE=0.5` never return; exact dedup via
  `rel#breadcrumb`
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: pure-function vocabulary — path/slug/date derivation (both
  slash spellings of a cwd normalize to one slug), `walkMemory(windowDays)`
  (the hard window applies ONLY to subdirectories whose name parses as a
  date — aged diaries leave the index but stay on disk; non-date dirs like
  `memory/` are always indexed)
- `client/bundle.js`: hand-written client bundle registering into the
  `settings.plugin.item` keyed slot (`key: 'dsh-memory'`); reads and writes go
  through the official client settings scope (`ctx.settingsScope.bind`) —
  revision-fenced mutations, mirror refreshes on document commits/reconnects
- New-vs-old conflicts resolve at query time: decay favors newer notes, and
  the etiquette (AGENTS.md side) instructs merging multiple hits on the same
  topic instead of trusting only the newest one

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
memory topic="windows-env" mode="write" content="# Windows environment lessons ..."
memory topic="windows-env" mode="edit" old_string="pnpm dual instance" new_string="pnpm dual instance (avoid via --allow-scripts since 2026-08)"
```

## Suggested rules (paste into your global AGENTS.md)

The plugin ships no capture reminder; put rules like this into your **global
AGENTS.md** (user scope, effective across projects):

```markdown
## Cross-session memory (dsh-memory plugin)

- At the end of a turn that produced something worth keeping across sessions,
  use the `memory` tool — read first: no args reads today's note; create with
  mode:"write" when absent; modify in place with mode:"edit" when present.
- Record experience, not play-by-play: decisions and reasons, pitfalls and
  fixes, reusable commands/processes, state changes. Organize under # headings,
  merge related topics, correct outdated statements in place.
- Experience that still holds in another project (environment/tooling lessons,
  my collaboration preferences, general patterns) goes into long-term topic
  files: the memory tool with a topic parameter (short English kebab-case
  names, e.g. windows-env).
- Do not put must-follow rules into memory — tell me to add them to this
  AGENTS.md instead.
- Search with memory_search (up to 7 terms, most essential first); when a
  long-term topic block is among the hits treat it as authoritative, fix stale
  statements in place, merge obvious duplicates.
```

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  searchLimit: 5            # number of results returned by memory_search (1-10); a hard cap the agent cannot override
  dailyWindowDays: 90       # diary hard window in days: aged diaries stop participating in search (0 = unlimited); memory/ is exempt
  embeddingBaseUrl: ''      # Ollama-compatible /api/embed base URL (e.g. http://localhost:11434); empty disables vector search
  embeddingModel: 'bge-m3'  # embedding model name
  longtermAppend: true      # when no long-term block made the list, append the best-ranking one (no eviction); false = pure top-N
```

## Requirements

- Node.js ≥ 22 (dsh requirement)
- Plain ESM, zero dependencies, zero build step; with no embedding service
  configured there are no network calls at all

## License

MIT

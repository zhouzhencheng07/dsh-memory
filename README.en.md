English | [中文](README.md)

# dsh-memory

A cross-session memory plugin for DeepSeek Harness (dsh).

The main agent decides whether this turn produced anything worth keeping across
sessions: a **per-turn system-prompt reminder** ("when this turn has something
worth keeping, you MUST use the memory tool" — off via `autoMemory: false`)
points the timing at the **single `memory` tool** (`recall` = search + read,
`remember` = create / replace / edit in place; its read/write surface is locked
to the memory root, and its description carries the usage mechanics and
organization rules). Retrieval (`recall` + `keywords`) is **block-level search**
(optional vector fusion, per-day recency decay). The long-term layer is
promoted at RECURRENCE only — the promotion hint fires when a hit shows the
fact was needed again (a later day or another workspace); nothing is pre-judged
at capture time. Bundle plugin
form (`dsh.bundle`) — 0 patches, **zero npm dependencies, zero build step**;
`@deepseek-ai/*` resolves through dsh's flat module fallback, so the runtime
shares one package instance.

> ⚠️ **Use with caution.** A memory system designed around personal ideas
> (after studying several agents) — works well for me but may not suit
> everyone. The storage layout, tool interface, and config options may change
> frequently and WITHOUT compatibility guarantees (breaking changes are the
> norm). Check the commit history before upgrading, and back up your memory
> files under the memory root if they matter to you.

## Features

| Feature | Description |
|---|---|
| **Per-turn reminder (optional)** | A short system-prompt reminder assembled on every request, TIMING ONLY: "when this turn has something worth keeping across sessions, you MUST use the memory tool". Turn it off with `autoMemory: false` for a "record only when asked" style; the `memory` tool stays usable. Usage mechanics and organization rules live entirely in the `memory` tool description |
| **One tool, two modes (2026-09-01; remember surface simplified 2026-09-04)** | Search and read/write are a single `memory` tool: `mode:"recall"` GETS (`keywords` searches the whole library; `date`/`topic` opens one note; `block` narrows it to one block) and `mode:"remember"` PUTS (`new_string` is the text to put in: **without `old_string`** it is the full note text and lands only on an absent or empty file; **with `old_string`** it replaces that exact text in place — recall first). **The presence of `old_string` picks the shape, the FILE STATE keeps guard**: a note that already has content rejects a bare `new_string` (no wholesale overwrites) and must be edited with `old_string`. The names follow the semantics: `recall` covers search + read, `remember` covers create + edit and deliberately does not distinguish creating from revising; **`remember` takes no `date`** — with `topic` it writes `topics/`, without it today's note; older diary notes are read-only |
| **No file paths in any output (2026-09-01)** | Hit rows and receipts identify notes by ADDRESS: `2026-08-20 · D-Project-x` (diary), `topics/windows-env` (long-term), `today (2026-09-01)`. The model is NEVER told where the library lives on disk, so it cannot bypass this tool with its native read/write/edit — the whole writable surface stays inside the observation guard, and aged diary notes (which retire by decay) cannot be dredged up and hand-edited. **A hit row is also the READ KEY**: feed `date` + `workspace` + `block` back into `recall` to reopen that exact block (the only way in when a long block was truncated) |
| **Observation guard (mirrors native)** | Per-session present/absent + version records — `remember` refused when the file exists but was not read this session (createIfAbsent), write/edit refused when the file changed since that read (CAS "recall it again"), edit refused when unread (FS_NOT_OBSERVED), old_string refused on multiple matches (FS_AMBIGUOUS_EDIT); atomic tmp+rename writes. **The plugin writes its own data root directly** (trusted node:fs writes; paths are tool-derived or whitelist-validated, the model only supplies content) — bypassing the sandbox fence built into the fs backend (its per-write manual escalation is unusable for automatic capture), so **capture works under every permission mode, workspace-write included** |
| **Retrieval (`recall` + `keywords`)** | Heading-aware block-level retrieval (any heading splits a block, breadcrumbs included), **single-field positional keyword scoring** (2026-08-25): ONE `keywords` parameter holding up to 5 space-separated terms — the **first 3 at high weight** (×3 each hit), the next 2 at low weight (×1 each) — partial credit per matched keyword, no hard AND gate; a **coverage floor `MIN_COVERAGE=0.3`** (2026-08-29): a block must account for at least 30% of the query's realized evidence — matching 1 of many terms is cut, and wrong/generic keywords never inflate the bar; **IDF term weighting** (2026-08-29): normalized by corpus document frequency — a corpus-unique term keeps its full weight while a term present in EVERY block scales toward 0 (generic words alone can no longer clear `MIN_SCORE=0.5`, the fix for irrelevant hits pulled in by frequent words); absent/everywhere keywords are reported back in the notices; **ASCII word boundaries** (2026-08-29): pure-alphabetic terms match on word boundaries (`log` no longer hits `catalog`), digit/dot-bearing version strings and CJK keep substring semantics; a **minimum-score floor `MIN_SCORE=0.5`**; formatting-tolerant matching, occurrence counts normalized by block length, **per-day decay** (30-day half-life, floor 0.4); snippets return whole blocks (≤1000 chars). The promotion/correction hint is COMPOSITION-DRIVEN and appended to the output (2026-08-29): a long-term block among the hits ⇒ treat as authoritative, fix stale statements in place, merge overlapping topic files; diary hits WITH recurrence evidence (a past date or another workspace) ⇒ the promotion hint fires; all-today same-workspace hits ⇒ no nudge (the promotion gate, A); empty results report keyword health only. A **single-line maintenance notice** is also appended when one topic file has outgrown 16 KB (see the three-constraints row, C) |
| **Two-layer library** | Diary layer `YYYY-MM-DD/` (ephemeral, **hard window** `dailyWindowDays` default 45 days — agent work iterates fast, so aged notes leave the searchable corpus but stay on disk; 0 = unlimited) + long-term layer `topics/<topic>.md` (**free topic files**: one topic per file, never decays, never windowed). Division of labor: **experience that still holds in another project goes to the long-term layer** (environment/tooling lessons, collaboration preferences, general patterns); play-by-play events go to the diary; **standing conventions belong in AGENTS.md (kept thin), not memory**; occasionally-needed project knowledge → stage in the diary, promote on recurrence; **anything derivable from code, docs, or the workspace's own instructions is not memory material** (skip rule). **The long-term layer is consolidated at recurrence time only** — see the constraints row (A), never pre-judged at capture. **Old diary notes are read-only** (`remember` with a `date` is refused). No hit counters, zero state files |
| **Long-term layer: three evidence-timed constraints (2026-09-04)** | Constraints fire at the MOMENT EVIDENCE EXISTS, never when a counter crosses a number: **promotion gate (A)** — new long-term material starts in today's note and moves into `topics/` only when needed AGAIN (a hit row from a later day or another workspace is exactly when the recall hint fires); derivable content is skipped, while narrow always-true facts (user preferences, environment constants) may go straight to a topic file; **write-time dedup (B)** — creating a NEW topic file first queries the long-term corpus with the note's own heading terms; a strong overlap (`DEDUP_SCORE=2`) is REFUSED with the existing address — recall it and merge into it (editing and diary writes are never deduped; weak overlaps pass); **single-signal maintenance (C)** — one low-pressure recall line when a topic file outgrows 16 KB (`TOPIC_NOTICE_BYTES`), naming that file (a notice only; nothing is automatic). Count/total thresholds were deliberately rejected: topic count tracks workload (busy ≠ messy) and block-level retrieval is indifferent to it — a count threshold has no evidence moment |
| **No topic listings (2026-09-01)** | The tool output lists ALL long-term topics NOWHERE: such a list grows into noise and invites browsing by file name instead of retrieving. The only way to learn that a topic exists is to have it surface in a `recall` result; the hit row then gives you `topics/<name>` to read or revise via the `topic` parameter. **Single exception**: C's maintenance notice names the one over-limit file at trigger time (scoped to the trigger, not a listing) |
| **Vector fusion (optional)** | With an Ollama-compatible embedding service configured, upgrades automatically to keyword + vector RRF fusion (k=60); the vector index **persists to `<memory root>/.vector-cache.json`** (sha1 signature-keyed — zero rebuild after a dsh restart; window-expired/deleted/renamed files are pruned at refresh; a model change invalidates it wholesale); falls back to pure keyword matching when the service is down — retrieval never fails because of vectors |
| **Config card** | Settings → Plugins → Plugin config → Memory; hot-reloads on save (persisted to settings.yaml, no restart) |

No commands — the per-turn reminder tells the model when the `memory` tool must
be used; retrieval is the `recall` mode of that same tool.

## Storage layout

A single global memory root shared by all workspaces; project directories stay
untouched. The root comes from the **`memoryRoot` setting** (empty falls back to
the plugin data root `$DSH_HOME/dsh-memory`):

```
<memory root>/
├── topics/
│   ├── <topic>.md          # long-term memory: one topic per file (short kebab-case names), never decays, never windowed
│   └── ...
└── YYYY-MM-DD/
    └── <workspace-slug>.md # one file per workspace per day (diary layer, subject to the search window)
```

- **Two-layer semantics**: play-by-play events go to the diary; the long-term
  topic files are promoted AT RECURRENCE ONLY — the recall hint fires when a
  hit carries recurrence evidence (a later date or another workspace) (A),
  and creating a new topic file is checked against the long-term corpus
  first, refused on a strong overlap with the existing address (B); never
  pre-judged at capture
- **Rename transition** (`memory/` → `topics/`): the search index covers ANY
  non-date directory, so existing files under the old `memory/` stay searchable
  and readable (their hit rows give `memory/<name>`, which addresses them
  directly); new writes always land in `topics/`
- **No capture bookkeeping**: no watermarks, turn counters, or hit counters; dates and
  the window are resolved at query time and roll over to the new day's file
  automatically at midnight. The only derived file on disk is the vector
  cache `.vector-cache.json` (only when vectors are configured; regenerable,
  invisible to the search corpus)
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
  subagents (delegationDepth > 0) — its text carries timing only. The single
  two-mode `memory` tool: `recall` runs the search on `keywords` or reads one
  note/block addressed by `date`/`topic` (+`block`) and records the
  observation; `remember` publishes a bare `new_string` (no `old_string`;
  absent/empty files only, `date` refused) through the createIfAbsent/CAS
  guard atomically (tmp + rename), or validates the observation and unique
  match with `old_string` before a read-modify-write.
  The observation guard is keyed per session (mirroring
  `@deepseek-ai/dsh-fs-observation-policy`), and all file work is done by the
  **plugin itself** via node:fs (the sandbox fence lives inside the fs backend
  — `dsh-fs-sandbox`'s `checkedTarget`; both the native pipeline and direct
  `ctx.fs` calls refuse `$DSH_HOME` writes under workspace-write, and the tool
  layer's only widening path needs per-write manual approval; a plugin writing
  its own data root is trusted host behavior, with path
  derivation/whitelisting keeping the write surface bounded). Retrieval ends
  its output with a composition-branched consolidation hint (the daily-only
  promotion branch now gated on `hasRecurrenceEvidence` — past day or another
  workspace); `remember` checks a NEW topic file's heading terms against the
  long-term corpus and refuses on a strong overlap (`topicClash`,
  `DEDUP_SCORE=2`); recall appends a single-line maintenance notice
  (`maintenanceNotice`, one topic ≥ `TOPIC_NOTICE_BYTES` 16 KB, stat-walked
  directly from the long-term directories, notice-only)
- `src/search.js`: any heading (`#`–`######`) is a chunk boundary and
  subsections become standalone blocks with ancestor breadcrumbs;
  **single-field positional keyword scoring** — one `keywords` string split on
  whitespace, the **first 3 terms are essential (×3 per hit)** and the **next
  2 refining (×1)**, first-occurrence dedupe, over-cap drops reported back;
  **IDF term weighting** (BM25-style idf normalized over the corpus: df=1 weighs exactly 1, df=N weighs ~0 — generic words cannot carry a hit) and **word-boundary counting for pure-alphabetic ASCII keywords** (`log` ≠ `catalog`); partial credit per matched keyword; the weighted count is normalized by
  block length; each block's score is multiplied by `max(0.4, 0.5^(days/30))`
  (per-day decay); blocks under `MIN_SCORE=0.5` never return; exact dedup via
  `rel#breadcrumb`. `hitAddress()` renders a rel as its path-free address and
  `findBlock()` turns the printed breadcrumb into a stable cross-call read key
- `src/embed.js`: optional vector path — in-memory index with sha1 signature
  caching (unchanged files are never re-embedded), cosine ≥ 0.45 joins the
  fusion, RRF k=60; embedding model defaults to `bge-m3`
- `src/store.js`: pure-function vocabulary — path/slug/date derivation (both
  slash spellings of a cwd normalize to one slug), memory-root resolution
  (the `memoryRoot` setting first, falling back to `$DSH_HOME/dsh-memory`),
  `walkMemory(windowDays, root)` (the hard window applies ONLY to
  subdirectories whose name parses as a date — aged diaries leave the index
  but stay on disk; non-date dirs like `topics/` are always indexed), and
  `resolveDiary()` (diary addressing: date-stamp validation plus exact or
  substring workspace-label matching, with an ERROR on several matches rather
  than a silent resolve to the wrong workspace)
- `client/bundle.js`: hand-written client bundle registering into the
  `settings.plugin.item` keyed slot (`key: 'dsh-memory'`); reads and writes go
  through the official client settings scope (`ctx.settingsScope.bind`) —
  revision-fenced mutations, mirror refreshes on document commits/reconnects
- New-vs-old conflicts resolve at query time: decay favors newer notes, and
  the tool description instructs merging multiple hits on the same topic
  instead of trusting only the newest one

## Usage

```sh
# model-side tool: search the memory library (ONE keywords parameter, up to 5
# terms, most essential FIRST)
memory mode="recall" keywords="vector search threshold embedding"

# model-side tool: read today's memory note (recall with no address) — returns
# the full text; ABSENT means there is none yet
memory mode="recall"

# a hit row IS the read key: copy its address back to read the whole block
#   a row looks like:  - [2026-08-20 · D-Project-dsh-plugin-dsh-memory] 工具链 > pnpm (score 1.2)
memory mode="recall" date="2026-08-20" workspace="dsh-memory" block="工具链 > pnpm"

# read and write a long-term topic file
memory mode="recall" topic="windows-env"
memory mode="remember" topic="windows-env" new_string="# Windows environment lessons ..."
memory mode="remember" topic="windows-env" old_string="pnpm dual instance" new_string="pnpm dual instance (avoid via --allow-scripts since 2026-08)"

# today's note: absent -> create with a bare new_string; just recalled -> revise with old_string
# (remember takes no date: with topic it writes topics/, without it today's note)
memory mode="remember" new_string="# Topic ..."
memory mode="remember" old_string="old sentence" new_string="new sentence"
```

With `autoMemory: true` (default) every turn carries a short reminder — when
this turn produced something worth keeping across sessions, the `memory` tool
**must** be used. With `autoMemory: false` there is no reminder — record only
when asked.

## Configuration

`$DSH_HOME/settings.yaml` (hot-reloaded, no restart needed; also editable via
the settings card):

```yaml
dsh-memory:
  memoryRoot: ''            # memory library root; empty = $DSH_HOME/dsh-memory. Changing it switches libraries — existing notes stay where they are
  searchLimit: 2            # number of results returned by recall (1-10); a hard cap the agent cannot override; a long-term block is still surfaced by the longtermAppend seat
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

---
name: agent-memory
description: Cross-session, cross-agent memory library — one global library shared by every agent and conversation. Use when recalling decisions/pitfalls/experience from previous sessions, recording something worth keeping across sessions, or maintaining long-term topic notes. Supports block-level keyword search over daily notes and long-term memory files.
---

# Agent memory

One global library, two layers:

- `YYYY-MM-DD/<workspace-slug>.md` — diary: per-workspace daily notes.
- `topics/<topic>.md` — long-term: one topic per file (short kebab-case names like `windows-env`).

Setup (one-time): point the `AGENT_MEMORY_HOME` environment variable at the library root, e.g. `setx AGENT_MEMORY_HOME "D:\agent\.dsh\dsh-memory"` (takes effect in NEW shells/processes).

## Commands

Run `node <this-skill-dir>/mem.mjs <command>`:

```
mem.mjs search --keywords "term1 term2 term3"
mem.mjs read   [--topic NAME]
mem.mjs write  [--topic NAME] [--expect-hash H]    # full note text on stdin
mem.mjs edit   --expect-hash H [--topic NAME]      # {"old":"...","new":"...","replace_all":false} on stdin
```

- `search` keywords: up to 5 space-separated terms, **most essential FIRST** — the first 3 weigh ×3, the next 2 ×1. Pick words the notes actually contain, not synonyms; distinctive (rare) terms beat generic ones. Hits are whole markdown blocks with absolute file paths; open a hit's file when the block alone is not enough.
- `read` prints the file plus a `[hash: ...]` footer. ABSENT output lists existing long-term topics.
- `write` on an existing file and every `edit` require `--expect-hash` from the latest read; every mutation prints the NEW hash, so consecutive edits can chain with it. On refusal, read again and retry with the fresh hash.

## When to do what

1. **Recall** — when a task touches earlier sessions' decisions, pitfalls, environment quirks or preferences: `search` first; say so plainly when nothing is found.
2. **Record** — after a turn produced something worth keeping across sessions (decision and its reason, pitfall and fix, reusable command/process, state change): read today's note, then append with `edit` (or create with `write`). Reusable experience only, never play-by-play.
3. **Consolidate** — when a search hit proves a fact worth keeping long term, file it into `topics/<topic>.md`: update the matching topic file in place, or start a new one when none matches. When a long-term block is among the hits, it is authoritative: correct outdated statements in place and merge topic files that clearly overlap.

## Rules

- Organize under `#` headings; one block per subject; keep blocks concise; correct outdated statements in place instead of appending corrections.
- Merge near-duplicate topic files instead of spawning parallel ones.
- Must-follow rules belong in the user's instructions file (AGENTS.md), never in memory.
- Example: `node mem.mjs search --keywords "pnpm profile dsh"`; `node mem.mjs write --topic windows-env < note.md` (pipe the text on stdin).

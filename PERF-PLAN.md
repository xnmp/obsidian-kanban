# Performance Improvement Plan (fork)

This fork exists to fix UI lag in obsidian-kanban. Upstream is effectively unmaintained (last release 2.0.51 in May 2024; last commit Mar 2026 was trivial; 592 open issues; recent PRs closed unmerged), so improvements land here. License: GPL-3.0 (LICENSE.md governs; package.json's "MIT" is an upstream inconsistency).

Findings below come from a full source analysis (Jul 2026), each verified against the code. Architecture recap: Preact via `preact/compat`; per-file `StateManager` holds an immutable `Board` (immutability-helper structural sharing) and pushes to subscribed components; micromark/mdast parsing; per-card render via Obsidian `MarkdownRenderer.render` cached in `KanbanView.previewCache`; custom DnD in `src/dnd/` with cached hitboxes and rAF-throttled moves.

Already-good paths (don't "fix"): typing in a card commits on blur/Enter and re-parses only that item (`ItemContent.tsx:195-204`, `formats/list.ts:335-353`); drag-move uses cached rects, no per-frame `getBoundingClientRect` (`EntityManager.tsx:165-174`); off-screen cards are excluded from hitbox scans via IntersectionObserver (`EntityManager.ts:74-103`); `memo` on Item/Lane/Lanes components.

## Quick wins (low risk, isolated)

- **Q1** `Kanban.tsx:170-177` — `kanbanContext` `useMemo` lists `dateColors`/`tagColors` in deps but never uses them in the value → context identity churns on color-setting changes, forcing full-tree re-render. Remove the unused deps.
- **Q2** `DndManager.ts:35-64` — the shared debounced ResizeObserver calls `recalcInitial()` (= `getBoundingClientRect`) on **every** registered hitbox/scroll entity when **any** element resizes. Use the callback's `entries` to recalc only the entities whose elements actually changed. (Every card is observed, so edits/renders trigger batch layout reads today.)
- **Q3** `MarkdownRenderer.tsx:300, 320-329` — `colorizeDates` re-runs `querySelectorAll` + `moment(dateStr)` per date element on every re-render. Reuse the already-parsed `item.data.metadata.date` instead of re-parsing DOM strings.
- **Q4** `DragManager.ts:168-218` + `hitbox.ts:277-297` — per-frame allocation during drag: `entity.getData()` does an object spread + `getParentWindow` per entity per frame and is called again inside `getBestIntersect`. Cache `getData()` per entity for the duration of a drag; precompute the accepts-filtered entity list at dragStart.

## Structural fixes (the real lag on large boards)

- **S1 — Scope the vault-modify reparse.** `main.ts:529-559`: `vault.on('modify')` + `metadataCache.on('changed')` + `dataview:metadata-change` → (2s debounce) → every other open board runs `reparseBoardFromMd()` (`StateManager.ts:352-363`) = full synchronous micromark parse + whole-board diff. Fix: index card→linked-file dependencies (the parser already resolves wikilink targets during hydration) and skip boards with no card referencing the changed file; reparse only affected items otherwise. Consider a Web Worker for the parse as a follow-up.
- **S2 — Lazy card rendering.** `KanbanView.tsx:79-99` (`prerender`) eagerly queues an Obsidian `MarkdownRenderer.render` for every card at load (previewQueue, 5 at a time — `util.ts:53-79`); the IntersectionObserver in `MarkdownRenderer.tsx:176-190, 251-264` only attaches/detaches already-rendered DOM and every card keeps a live renderer + its own ResizeObserver (`MarkdownRenderer.tsx:107`) forever. Fix: render on *first* intersection instead of up front; evict far-off-screen renderers; consider per-lane windowing to cap live DOM at the viewport.
- **S3 — Stop whole-board reparse on settings changes.** `StateManager.ts:120-136, 144-153`: `forceRefresh`/`shouldRefreshBoard` (fires on tag-color, date-color, date-format, metadata-key changes — `common.ts:244-258`; also `dataview:api-ready` for all boards, `main.ts:562-566`) → `reparseBoard()` (`formats/list.ts:382-401`) re-runs a fresh micromark parse for **every item**. Fix: memoize per-item parse keyed by `titleRaw` + the relevant compiled settings so untouched cards skip parsing.
- **S4 — Search re-scan.** `helpers.ts:357-402`: while a search query is active, any board change rebuilds match Sets by scanning every item. Lower priority; consider a normalized search index if it shows up after S1-S3.

## Workflow

- Branch per fix; keep upstream remote (`upstream`) for potential cherry-picks either direction. Q1-Q4 are PR-able upstream in principle, but don't block on it.
- Build: `yarn && yarn build` (esbuild → `main.js`). Dev install = copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsidian-kanban/` (the user's live vault is `~/Vaults/Technical Vault/` — test in a scratch vault first, and bump nothing in `manifest.json` so Obsidian treats it as the same plugin).
- Measure before/after: Obsidian Ctrl+Shift+I → Performance profile while opening the big board (`!Productivity Kanban.md`; note its Done lane was bulk-archived Jul 2026 — recreate a large fixture board for benchmarking, e.g. 300 cards, since the live board is now small).
- Verify behavior, not just build: open board, drag cards across lanes, edit a card, toggle a tag color, run search — all on the fixture board.

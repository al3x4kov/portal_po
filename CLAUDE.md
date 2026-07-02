# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Local "Requirements Management for Product Owner" app. **No database** — the source of truth is `.md` files on disk under `Projects/`. A browser SPA talks REST/JSON to a local Node server that owns all filesystem operations (create dirs, read/write `.md`, pack/unpack archives). The server also serves the built SPA, so one `node` process runs the whole app. Designed to be wrappable in Electron later without rewriting logic.

Primary spec/architecture docs live in `docs/overview/project.md` (ТЗ / requirements, with FR/NFR IDs) and `docs/overview/arch.md` (architecture). Task breakdown is in `docs/tasks/` (E1–E12 epics); architecture decisions/plans in `docs/architecture/` (ADRs). UI mockups and design tokens are in `docs/design/`. Docs are in Russian; code and identifiers are English. (Claude working artifacts — todo, build notes, demo — live under `.dev/`.)

## Commands

Run from the repo root (npm workspaces; Node ≥ 20, CI uses 22).

- **Build everything:** `npm run build` (`tsc -b` for core+server, then Vite build for web → `apps/web/dist`)
- **Typecheck:** `npm run typecheck`
- **Lint / format:** `npm run lint` · `npm run format:check` · `npm run format` (Prettier writes)
- **Unit + component tests (Vitest):** `npm test` (runs with coverage gate) · `npm run test:watch`
- **Run one test file:** `npx vitest run packages/core/src/graph/integrity.test.ts` (add `-t "name"` to filter by test name)
- **E2E (Playwright):** `npm run e2e` — see note below
- **Run one E2E file:** `npx playwright test e2e/tests/happy-path.spec.ts`
- **Dev frontend:** `npm run dev -w @po/web` (Vite dev server, proxies `/api` → local server; start the server separately)
- **Run the built app:** `node apps/server/dist/main.js` — env: `PORT` (default 3000), `HOST` (127.0.0.1), `PROJECTS_ROOT` (default `<repo>/Projects`), `LOG_LEVEL`. Serves SPA on `/` and API on `/api` when `apps/web/dist` exists.

**Playwright runs the REAL app**: its `webServer` does `npm run build && node apps/server/dist/main.js` against a throwaway `PROJECTS_ROOT` in the OS temp dir. It is serial (`workers: 1`) because all tests share one server + one `Projects/` root; isolation comes from unique project/requirement names per test. Health check is `/healthz`.

## Architecture

Three workspaces, dependency direction is one-way: `web` → (HTTP) → `server` → `core`.

### `packages/core` (`@po/core`) — pure domain, no fs/http
The heart of correctness; unit-tested to ≥90% (CI gate; actual ~98%). Imported by both server and web so validation rules are shared.
- `domain/` — `types.ts` (`RequirementType`, `Criticality`, `LinkType`, `Requirement`, `Link`), `ids.ts` (ULID), `errors.ts`
- `validation/` — `schema.ts` (Zod schemas, reused on server AND in web forms) + `rules.ts` (e.g. conditional quarter/year fields when `implemented=false`)
- `md/markdown.ts` — `.md` ⇄ requirement (de)serialization; round-trip must be lossless (gray-matter frontmatter + body)
- `graph/` — integrity rules over the link graph: `uniqueness.ts` (name uniqueness), `integrity.ts` (cycles, single parent, no self-link, valid types), `cascade.ts` (delete cleanup)

### `apps/server` (`@po/server`) — Fastify, strict layering
`routes → services → repositories → fs`. Keep responsibilities separated:
- `routes/` — HTTP parsing + error→status mapping only, no business logic (`projects`, `requirements`, `links`, `archive`, `deps`)
- `services/` — use-cases, orchestrate repos + core rules, own transactionality (e.g. delete file **and** clean up dangling links atomically)
- `repositories/` — the ONLY place doing I/O: `FsProjectRepo`, `FsRequirementRepo`, `ArchiveRepo` (zip/tar.gz via adm-zip/tar)
- `lib/` — `pathSafe.ts` (resolves paths strictly inside `PROJECTS_ROOT`; path-traversal defense, NFR-5), `atomicWrite.ts`, `ensureDir.ts`, `projectName.ts`, `parseInput.ts`
- `app.ts` builds the Fastify instance (testable); `main.ts` is the bootstrap/entrypoint that wires env + static serving

### `apps/web` (`@po/web`) — React + Vite + TS + Tailwind
- **Server state:** React Query (`api/hooks.ts`) — mutations invalidate queries so auto-save is visible immediately
- **UI state:** Zustand (`store/ui.ts`) — open modals, selected project, expanded tree nodes
- **Forms:** React Hook Form + Zod resolver, reusing `@po/core` schemas; real-time name-uniqueness check debounces a call to `GET /api/projects/:id/requirements/check-name`
- **API client:** `api/client.ts` + `endpoints.ts` + `types.ts` (typed against the same domain)
- `pages/` — Start, NewProject, Import, OpenExisting, Main · `components/` — `TreeTable` (recursive tree+columns), `RequirementModal`, `LinkModal`, `ConfirmDialog`, `PathHeader`, `Modal`, `ThemeToggle` (light/dark tokens)

### API surface (all validated by Zod; see `docs/overview/arch.md` §5 for the full table)
`GET/POST /api/projects`, project import/export (`?format=zip|targz`), `GET/POST/PUT/DELETE /api/projects/:id/requirements[/:rid]`, `.../requirements/check-name`, `POST/DELETE /api/projects/:id/links`.

## Conventions

- ESM everywhere (`"type": "module"`); TS uses project references (`tsc -b`). Import built core as `@po/core`.
- Cross-workspace type safety: define/validate once in `@po/core`, consume in server and web — don't duplicate a validation rule.
- Server integration tests run against a temp dir (`os.tmpdir()`), never the real `Projects/`.
- CI (`.github/workflows/ci.yml`) gates in order: format:check → lint → typecheck → unit (with core coverage ≥90%) → e2e. Keep all green.
- After changing code, if `graphify-out/` exists, run `graphify update .` to refresh the knowledge graph (AST-only, no API cost).

## Known gaps (from `.dev/build-complete.md`, MVP scope)

Not implemented: full WCAG keyboard nav (NFR-7), ~1000-requirement perf tuning (NFR-3), description popover (FR-7.4). Deleting a node with children is currently **forbidden** (rather than reparent/cascade-choose). The web bundle pulls gray-matter via the core barrel (~475 KB) — could be trimmed with a subpath export.

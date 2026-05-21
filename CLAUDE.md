# Project Rules

Rules that apply to all work in this repository. Claude reads this file automatically; humans should too.

For code-level conventions (file layout, naming, DRY/KISS calls, testing patterns, extension recipes), see [`docs/codebase-conventions.md`](docs/codebase-conventions.md).

## Dependencies

- **Pin every dependency to an exact version.** No `^`, no `~`, no ranges. In every `package.json` (root, apps, packages), write versions like `"zod": "3.23.8"`, never `"zod": "^3.23.8"`. This applies to `dependencies`, `devDependencies`, and `peerDependencies`. Reason: reproducible builds across local dev, Vercel, and LangGraph Platform — and no silent upstream breakage.
- When adding a new package, use `pnpm add --save-exact <pkg>` (or `pnpm add -E <pkg>`). Set `save-exact=true` in `.npmrc` at the repo root so it's the default.
- pnpm `workspace:*` is fine for internal workspace deps — they're not external versions.

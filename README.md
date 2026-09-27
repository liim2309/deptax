# DepTax — Dependency Weight Auditor

> A VSCode extension that measures the exact tax your dependencies impose on your project — and flags the parasitic ones.

## What it does

DepTax scans your workspace and answers two questions for every dependency: **how much code does it bring in, and how much of that code do your imports actually need?** It also tells you what removing the package would free, including the dependencies that only it needs.

**Supports:** Node.js / TypeScript (npm, pnpm, yarn) · Flutter / Dart (pub) · Python (pip, Poetry, PDM, uv, Pipenv)

## How it measures

```
R(P) = bytes of code reachable from P's public entry points
       (P plus the packages only P needs)                  ← code carried
K(P) = bytes of that code your imports need
       (tree-shaking style analysis of your import statements) ← code used
u(P) = K / R                                                ← utilization
```

What removing P frees comes from the dominator tree of the dependency graph: exactly the packages that no other path reaches.

| Status | Rule | Action |
|---|---|---|
| 🔴 Parasitic | u ≤ 10 % and ≥ 100 KiB dead | Replace or evict |
| 🟡 Bloated | u ≤ 30 % and ≥ 25 KiB dead | Watchlist |
| 🟢 Healthy | otherwise | Keep |
| ⚪ Unused | never imported | Remove |
| 🔧 Tooling | dev dependency, types, CLI | Not shipped; not scored |
| ❔ Unmeasured | not installed / not found | Install dependencies and rescan |

See [`DEPTAX_FULL_SPEC.md`](./DEPTAX_FULL_SPEC.md) §2 for the full model and its precision limits.

## Features

- **Inline diagnostics** — on the exact import statements of parasitic and bloated packages, and on the manifest line of unused ones
- **Sidebar panel** — packages by severity with "u % of R used", symbols and import sites
- **WebView report** — full audit table (`DepTax: Open Report`)
- **Status bar badge** — `$(bug) 2 parasitic · 1 unused` at a glance

## Getting Started

```bash
npm install
npm run compile
npm test          # model, recipe and end-to-end tests

# Launch against your project:
code --extensionDevelopmentPath=/path/to/deptax /path/to/your-project
```

Or press `F5` in VSCode with this folder open.

## Commands

| Command | Description |
|---|---|
| `DepTax: Scan Workspace` | Trigger a manual re-scan |
| `DepTax: Open Report` | Open the full WebView audit table |

## Project Layout

```
src/
├── model/           ← dominators, liveness analysis, classifier (pure math)
├── analysis/        ← JS/TS, Python and Dart analysers, Node resolver
├── adapters/        ← npm, pub, pip ecosystem adapters
├── stages/          ← evaluation engine, file discovery, Tree-sitter setup
├── recipes/         ← Tier 1 native replacement recipes
├── orchestrator/    ← wires all stages together
├── ui/              ← diagnostics, tree view, webview, status bar
├── cache/           ← report cache (written to .deptax/)
└── types/           ← shared TypeScript interfaces
```

See [`DEPTAX_FULL_SPEC.md`](./DEPTAX_FULL_SPEC.md) for the complete technical specification.

## License

MIT

# DepTax — Dependency Weight Auditor

> A VSCode extension that measures the exact tax your dependencies impose on your project — and flags the parasitic ones.

## What it does

DepTax scans your workspace on every file save, computes a **DepTax Score** for each installed package, and surfaces the results directly in your editor.

**Supports:** Node.js / TypeScript (npm, pnpm, yarn) · Flutter / Dart (pub) · Python (pip, poetry)

## The DepTax Score

```
Φ(P) = diskSizeKb × (1 + 0.25 × transitiveCount)   ← footprint
U(P) = Σ ln(1 + callCount(s))                        ← utilization
DepTaxScore = Φ(P) / (U(P) + 0.1)
```

| Score     | Classification       | Action           |
|-----------|----------------------|------------------|
| < 25      | 🟢 Healthy           | Keep             |
| 25 – 150  | 🟡 Bloated           | Watchlist        |
| > 150     | 🔴 Parasitic         | Consider eviction|

## Features

- **Inline diagnostics** — red/yellow squiggles on import lines with score and symbol count
- **Sidebar panel** — all packages ranked by DepTax score with expandable call-site tree
- **WebView report** — full audit table (`DepTax: Open Report`)
- **Status bar badge** — `$(bug) N Parasitic` at a glance

## Getting Started

```bash
npm install
npm run compile
npm test

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
├── adapters/        ← npm, pub, pip ecosystem adapters
├── stages/          ← manifest parser, cache inspector, AST scanner, tax engine
├── recipes/         ← Tier 1 native replacement recipes
├── orchestrator/    ← wires all stages together
├── ui/              ← diagnostics, tree view, webview, status bar
├── cache/           ← report cache (written to .deptax/)
└── types/           ← shared TypeScript interfaces
```

See [`DEPTAX_FULL_SPEC.md`](./DEPTAX_FULL_SPEC.md) for the complete technical specification.

## License

MIT

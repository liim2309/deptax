# DepTax — Full Project Specification & Implementation Reference

> **Format:** Authoritative project document. Contains everything needed to understand, continue, or re-implement DepTax from scratch — problem statement, model, architecture, implementation decisions and known limitations.
>
> **Model version 2.** Section 2 replaces the original `DepTaxScore = Φ / (U + 0.1)` model. Section 15 records why.

---

## 1. Project Vision & Problem Statement

Modern software development has normalised an unsustainable habit: developers routinely pull in multi-megabyte external packages to solve trivial problems.

### Canonical Examples of Dependency Debt

- A developer imports a 1.3 MB package (`lodash`) to call a single function (`isEqual`).
- A Flutter developer imports an entire 40-widget package just to use a dotted border container.
- A Python developer installs a utility package containing 50 transitive sub-dependencies just to convert a snake_case string to camelCase.

### The Three Consequences

1. **Bundle & Binary Bloat** — Unnecessary bytes shipped to client devices or container images, degrading startup time and memory footprint.
2. **Supply Chain Attack Surface** — Every transitive dependency introduces third-party code running with full application privileges.
3. **Maintenance & Version Churn** — Outdated, abandoned packages block compiler upgrades, trigger endless dependabot noise, and introduce breaking build changes.

### What DepTax Does

1. It measures, for every declared dependency, **how much code it brings into the project and how much of that code the project's imports actually need**, plus what removing it would free.
2. It flags dependencies that carry a lot and are barely used, and dependencies that are not used at all.
3. (Future) With a single command (`deptax evict <package>`), it replaces the used functions with in-repo native code and removes the package.

**Core tenet:** deterministic static analysis, no network calls, runs entirely locally.

---

## 2. The DepTax Model (v2)

### 2.1 The question

For a declared dependency *P*: **if I remove P, how much do I save, and how much of it do I actually use?** Both parts are measured in bytes, from the installed packages and the project's source, with no estimates or magic constants.

### 2.2 Inputs

- **Package graph G.** Nodes are installed packages; the project root has an edge to every declared dependency (runtime and development); every package has an edge to each installed package it depends on. Built from `node_modules` with Node's resolution algorithm (npm, pnpm, yarn), from `.dist-info` metadata (pip), or from `.dart_tool/package_config.json` plus each package's `pubspec.yaml` (pub).
- **Module graph.** Every loadable source file of the packages, analysed into top-level *items* (declarations and statements) with the names they declare and reference, plus their imports and re-exports.
- **Project imports.** Every import in project source, with the export names it needs (Section 2.6).

### 2.3 What removing P frees — dominators

A package *d* **dominates** *v* when every path from the project root to *v* passes through *d*. Removing *P* from the manifest removes exactly the packages *P* dominates; everything else stays reachable through another path. (This is the "retained size" idea heap profilers use.)

```
Dom(P)              = { v : P dominates v }            (P's exclusive subtree)
RetainedDisk(P)     = Σ_{v ∈ Dom(P)} disk(v)
ExclusiveDeps(P)    = Dom(P) \ {P}
SharedDeps(P)       = Reach(P) \ Dom(P)                (needed by others too; not freed)
```

The dominator tree is computed with the Cooper–Harvey–Kennedy iterative algorithm, which handles the cycles found in real npm graphs. Subtrees of different direct dependencies are disjoint, so savings never double-count. Packages dominated only by the root are *shared* and reported separately.

### 2.4 Code carried (R) and code used (K)

```
R(P) = bytes of the files reachable from the public entry points of the packages in Dom(P)
K(P) = bytes of the items in those files that the project's imports need
u(P) = K / R            (utilization, 0..1, unit-free; 1 when R = 0)
W(P) = R − K            (dead code carried, in bytes)
```

**R — the view.** A package's public entry points are its `exports` map subpaths (patterns expanded) or `main`/`module` (npm), every module except shipped test suites (pip), and every library outside `lib/src/` (pub). Entry points are resolved under one condition set (`import`, then `require`), so a package that ships the same code as ESM, CommonJS and UMD builds is measured through one build, not three. R counts whole files: it is what you carry.

**K — the liveness analysis.** A tree-shaking style fixed point over the module graph (`src/model/Liveness.ts`):

- a request "module *M* needs export names *N*" marks the items declaring *N* live, or forwards the request along the matching re-export (`export { x } from`, `export * from`, Dart `export … show/hide`);
- a live item makes the items and import bindings it references live; `ns.member` on a namespace binding requests only `member`;
- including a module makes its side-effecting items (roots) live and, unless the imported package is side-effect free (`"sideEffects": false`, Dart), includes every module it imports;
- requests only add names, so the analysis terminates.

An item is **pure** — live only when referenced — when evaluating it has no observable effect: function and class declarations, and variables initialised with literals, functions, `/*#__PURE__*/` calls or known pure built-ins. Anything else runs on load and is a root. K counts, per included file, the live items plus the bytes that belong to no item (comments, import lines), scaled from source characters to file bytes.

Invariant (tested): the files K includes are a subset of the files R reaches, and K ≤ R.

### 2.5 Classification

| Status | Rule | Meaning |
|---|---|---|
| 🔴 Parasitic | u ≤ 10 % **and** W ≥ 100 KiB | Uses a tenth or less of a material amount of code. |
| 🟡 Bloated | u ≤ 30 % **and** W ≥ 25 KiB | Most of what it brings in is dead. |
| 🟢 Healthy | otherwise, when imported at runtime | The package is doing its job. |
| ⚪ Unused | runtime dependency, not imported, no CLI | Remove it; saves RetainedDisk. |
| 🔧 Tooling | dev dependency, `@types/*`/stub package, type-only imports, or a CLI package not imported | Not part of shipped code; not scored. |
| ❔ Unmeasured | not installed, not locatable, or an SDK package | Never reported as healthy by default. |

Named constants in `src/model/Classifier.ts`: `UTILIZATION_PARASITIC = 0.10`, `DEAD_BYTES_PARASITIC = 100 KiB`, `UTILIZATION_BLOATED = 0.30`, `DEAD_BYTES_BLOATED = 25 KiB`.

Both conditions are required: a 3 KB helper used at 5 % is not worth anyone's time, and a 5 MB framework used at 60 % is doing its job. The rules are **monotone**: for a fixed R, a larger K never produces a worse status (tested on 5 000 random cases).

Reports are sorted by status severity, then by W (or RetainedDisk for unused packages).

### 2.6 Project usage

For each import in project code, DepTax records the export names needed at runtime by following the **local binding**:

| Source | Names needed |
|---|---|
| `import { v4 as uuidv4 } from 'uuid'` | `v4` — references of `uuidv4` are counted |
| `import _ from 'lodash'` + `_.isEqual()` | `default` (the module object); symbols shown as `isEqual` |
| `import * as ns from 'x'` + `ns.a` | `a`; every name once `ns` escapes as a value |
| `const { a } = require('x')` / `require('x').a` | `a` |
| `import 'x'` / `require('x');` | none — the module runs for its side effects |
| `import type …`, or TS bindings used only in type positions | nothing at runtime (erased by the compiler) |
| JSX in a React project | `react/jsx-runtime` (the automatic runtime's implicit import) |
| Python `from m import a` / `import m` + `m.a` | `a`; submodules are resolved (`from dateutil import parser`) |
| Python imports under `if TYPE_CHECKING:` | nothing at runtime |
| Dart `import … as p` + `p.X` / `show X` / unprefixed | `X`; unprefixed identifiers matched against the library's export table; extension methods matched by member name |

Import statements' line ranges are carried into the report, so diagnostics point at the exact statement (including multi-line imports).

### 2.7 Precision limits (what K does and does not see)

K is measured at **top-level declaration granularity**. It over-approximates the code you need, which keeps flags trustworthy, with these known limits:

- **Indivisible modules.** A module whose top level is one big side-effecting statement (UMD/IIFE bundles such as lodash's `lodash.js`) cannot be split. If the package ships standalone per-function modules next to it (`lodash/isEqual.js`), K is measured through them and the report says so. Otherwise the whole file counts as used, with a note when export coverage shows only a few exports are used.
- **Classes and extensions are single items.** Using one member keeps the whole class (Dart member-level shaking is future work).
- **Dynamic loads.** `require('./locale/' + name)` and `import_module("." + name)` are resolved to every file their static prefix can reach (as bundlers do with context modules). Loads with no static prefix cannot be attributed; the report notes them and their modules are not counted.
- **Unresolvable project imports** make the package count as fully used (K = R), with a note.
- **Runtime branches** such as `process.env.NODE_ENV` checks are not evaluated; both branches count.
- **Python modules** are analysed at declaration level too, but top-level `try`/`if` blocks run on import and are roots, as Python executes them.

### 2.8 Worked example

From a real npm project (`date-fns 3.6.0`, one call to `format`):

```
R  = 1.8 MB  (ESM build reachable from date-fns's exports map)
K  = 96 KB   (format + its helpers + the en-US locale)
u  = 5.3 %,  W = 1.7 MB           → 🔴 parasitic
RetainedDisk = 21.1 MB            (both builds, locales, fp/, …)
Export coverage: 1 of 250
```

---

## 3. System Architecture — The Pipeline

```
Stage 1: Manifests         package.json · pubspec.yaml · requirements.txt (+ -r) · pyproject.toml
                           (PEP 621, PEP 735, Poetry, PDM, uv) · Pipfile   → DeclaredDependency[]

Stage 2: Package graph     node_modules (Node resolution, real paths) · .dist-info (METADATA,
                           RECORD, top_level.txt, entry_points.txt, Requires-Dist with extras) ·
                           .dart_tool/package_config.json + package pubspecs  → nodes, edges, sizes

Stage 3: Source analysis   Project files → imports with needed names (Tree-sitter for TS/JS/Python,
                           a Dart lexer). Package files → module items, bindings, re-exports.

Stage 4: Evaluation        Dominator tree → RetainedDisk · reachability → R · liveness → K ·
                           classification · recipe lookup → ScoredPackage[]

Stage 5: Eviction          [OUT OF SCOPE — future]
```

The orchestrator (`ScanOrchestrator`) runs stages 1–4 per detected ecosystem and merges the results. Project source discovery skips hidden directories, `node_modules`, virtual environments (any directory with `pyvenv.cfg`), Flutter's `build/`, nested projects with their own manifest, and directories ignored by simple `.gitignore` patterns.

---

## 4. Ecosystem Adapters

| Operation | npm / pnpm / yarn | Dart / Flutter (pub) | Python (pip) |
|---|---|---|---|
| Manifest | `package.json` | `pubspec.yaml` | `requirements.txt`, `pyproject.toml`, `Pipfile` |
| Package locations | Node resolution from each package's real directory | `.dart_tool/package_config.json` (fallback: `$PUB_CACHE` + `pubspec.lock`) | `.venv`, `venv`, `env`, `$VIRTUAL_ENV`, `$CONDA_PREFIX` (POSIX and Windows layouts) |
| Dependency edges | `dependencies`, `optionalDependencies`, `peerDependencies` | each package's `pubspec.yaml` | `Requires-Dist`, honouring requested extras |
| Size | package directory without nested `node_modules` | package directory; code = `lib/**/*.dart` | files listed in `RECORD` |
| Parser | Tree-sitter TypeScript / TSX | lexer (`src/analysis/DartAnalyzer.ts`) | Tree-sitter Python |
| Name mapping | specifier → package | `package:name/…` | import name → distribution via `RECORD` (`bs4` → `beautifulsoup4`) |

The bundled Dart Tree-sitter grammar predates Dart 3 (`sealed`/`base`/`interface`/`final` classes, extension types) and its error recovery corrupted top-level structure, so Dart uses a small lexer that tracks bracket depth.

### EcosystemAdapter contract

```typescript
interface EcosystemAdapter {
  readonly ecosystem: 'npm' | 'pub' | 'pip';
  readonly manifestFiles: readonly string[];   // marks nested projects to skip
  detect(workspaceRoot: string): Promise<boolean>;
  isSourceFile(file: string): boolean;
  load(workspaceRoot: string, sourceFiles: string[]): Promise<EcosystemModel>;
}

interface EcosystemModel {
  declared: DeclaredDependency[];
  declaredNodes: Map<string, string>;           // name → graph node
  missingReasons: Map<string, string>;
  nodes: Map<string, PackageNode>;              // sizes, code files, entry points, CLI/types/SDK flags
  edges: Map<string, string[]>;                 // includes ROOT_NODE
  imports: ResolvedImport[];                    // project imports with targets and names
  ownerOf(file): string | null;
  moduleBytes(file): number;
  analyzeModule(file): Promise<ModuleInfo | null>;
  sideEffectFree(file): boolean;
  warnings: string[];
}
```

The evaluation stage (`src/stages/TaxEngine.ts`) is ecosystem-neutral: it only sees graphs, module descriptions and imports.

---

## 5. VSCode Extension Design

### UI Surfaces

| Surface | Description |
|---|---|
| **Inline diagnostics** | On the exact import statements of parasitic (error) and bloated (warning) packages; on the manifest line of unused dependencies. |
| **TreeView panel** | Packages in severity order with "u % of R used"; tooltip with metrics and notes; symbols → import sites. |
| **WebView report** | Summary by status, installed size, unused code; per package: status and reason, used vs carried code, what removal frees, used symbols, notes. Theme-aware. |
| **Status bar** | `$(bug) 2 parasitic · 1 unused` / `$(check) DepTax: Clean`. |

### Scan triggers

A scan runs on activation, on `DepTax: Scan Workspace`, from the report's Rescan button, and on save of source files (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .dart .py`) and manifests/lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `pubspec.yaml`, `pubspec.lock`, `requirements.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`).

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Eviction engine | Out of scope | File-modifying operations need diff preview and undo. |
| WebView report | Opened explicitly | Diagnostics and status bar give ambient awareness. |
| Report cache | `.deptax/deptax_report.json`, gitignored | Local and deterministic. |
| Multi-ecosystem workspaces | Every detected adapter runs | Mixed repositories are supported. |

### Commands

| Command | ID |
|---|---|
| DepTax: Scan Workspace | `deptax.scan` |
| DepTax: Open Report | `deptax.openReport` |

---

## 6. Implementation Architecture

```
src/
├── extension.ts                 activate() / deactivate()
├── orchestrator/ScanOrchestrator.ts
├── model/                       pure, ecosystem-neutral math
│   ├── Dominators.ts            dominator tree, dominated and reachable sets
│   ├── ModuleModel.ts           ModuleInfo: items, bindings, re-exports, loads
│   ├── Liveness.ts              K (liveness fixed point) and R (reachability)
│   └── Classifier.ts            thresholds, classify(), monotone by construction
├── analysis/                    language analysers
│   ├── JsModuleAnalyzer.ts      ESM + CommonJS (TS, Babel, esbuild output) items and exports
│   ├── JsProjectAnalyzer.ts     project imports, bindings, references
│   ├── NodeResolver.ts          exports/imports maps, conditions, patterns, main/module
│   ├── PyAnalyzer.ts            Python modules and project imports
│   ├── DartAnalyzer.ts          Dart lexer, directives, declarations, extensions
│   ├── MiniYaml.ts              pubspec.yaml / pubspec.lock reader
│   └── ProjectModel.ts          ProjectImport types
├── adapters/                    EcosystemAdapter + npm / pub / pip
├── stages/
│   ├── TaxEngine.ts             stage 4: evaluateEcosystem()
│   ├── ProjectFiles.ts          project source discovery
│   ├── CacheInspector.ts        file listing with sizes
│   └── TreeSitterHelper.ts      grammar loading, parsing
├── recipes/RecipeRegistry.ts    Tier 1 recipes and eviction lookup
├── cache/ReportCache.ts
├── types/index.ts               report types (schema version 2)
└── ui/                          diagnostics, tree view, webview, status bar, formatting
```

### Build and tests

- `npm run compile` — `tsc --noEmit` + esbuild → `dist/extension.js`.
- `npm test` — three suites:
  - `test/model.test.ts` — dominators, classifier (including monotonicity), liveness.
  - `test/recipes.test.ts` — differential test of the `isEqual` recipe against lodash.
  - `test/smoke.test.ts` — end-to-end scan of a generated npm project.
- WASM grammars in `resources/`: `tree-sitter.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-python.wasm`. Grammars must match the runtime's ABI: `web-tree-sitter` 0.22 accepts ABI 13–14, so `tree-sitter-python` is pinned to 0.23.6 (0.25 is ABI 15 and fails to load).

---

## 7. Tier 1 Eviction Recipes

A package is evictable by recipe only when **every** symbol it is used for at runtime has a recipe whose preconditions hold at every use, and no import uses the whole module.

| Package | Symbol (import forms) | Replacement | Preconditions |
|---|---|---|---|
| `lodash`, `lodash-es`, `lodash.isequal` | `isEqual` (`lodash`, `lodash/isEqual`, …) | `is_equal.ts` | — |
| `uuid` | `v4` | `globalThis.crypto.randomUUID()` | called with no arguments, never passed as a value; Node 19+ or a browser page on HTTPS |
| `quiver` | `isBlank` | `is_blank.dart` | — |

The `isEqual` recipe implements lodash's semantics: SameValueZero for primitives (NaN equals NaN); value comparison for Date, RegExp, Error and boxed primitives; element-wise arrays and typed arrays; unordered Map and Set; own enumerable string and symbol keys; lodash's constructor check; cycles. `test/recipes.test.ts` compares it with lodash on 45 edge cases and 5 000 random pairs.

---

## 8. Eviction Mechanics (Stage 5 — Future)

**Tier 1 — recipes.** Pre-flight (recipe coverage and preconditions, as above), write the helper, rewrite imports, remove the manifest entry, run the package manager, report the freed bytes (RetainedDisk).

**Tier 2 — extraction.** The liveness analysis already computes the exact items a symbol needs (K). Extraction can copy those items, provided they reach no other package and no side-effecting root, preserving license headers.

---

## 9. Known Limitations

See Section 2.7 for precision limits of K. Other limits:

- Yarn Plug'n'Play (no `node_modules`) is not supported; packages report as unmeasured.
- Monorepo workspaces: nested projects are skipped, not analysed as workspace members.
- TypeScript `paths` aliases are treated as local imports.
- On pnpm, disk sizes count hard-linked store files per project.
- For pub, RetainedDisk is the size of the package in the shared pub cache, which removal does not delete.
- Scans run in full on every save, in the extension host (see the roadmap).

---

## 10. JSON Output Contract (schema version 2)

From the validation project in Section 14 (one package shown):

```json
{
  "schemaVersion": 2,
  "projectName": "npmproj",
  "ecosystems": ["npm"],
  "scannedFiles": 8,
  "generatedAt": "2026-09-27T12:00:00.000Z",
  "summary": {
    "byStatus": { "parasitic": 2, "bloated": 1, "unused": 1, "healthy": 6, "tooling": 2, "unmeasured": 0 },
    "installedDiskBytes": 56756703,
    "sharedDiskBytes": 20883,
    "unusedCodeBytes": 4360157
  },
  "packages": [
    {
      "packageName": "date-fns",
      "ecosystem": "npm",
      "installedVersion": "3.6.0",
      "declaredVersion": "3.6.0",
      "isDev": false,
      "status": "parasitic",
      "statusReason": "uses 5% of the code it brings in",
      "metrics": {
        "diskBytes": 22153202,
        "retainedDiskBytes": 22153202,
        "exclusiveDependencies": [],
        "sharedDependencyCount": 0,
        "codeBytes": 1842083,
        "usedCodeBytes": 97906,
        "utilization": 0.0531,
        "exportCoverage": { "used": 1, "total": 250 }
      },
      "usedSymbols": [
        { "name": "format", "module": "date-fns", "references": 1, "typeReferences": 0, "callArities": [2], "files": ["src/d.ts"] }
      ],
      "importSites": [{ "file": "src/d.ts", "line": 0, "endLine": 0 }],
      "eviction": { "available": false, "strategy": null, "covered": [], "uncovered": ["format"] },
      "notes": []
    }
  ],
  "warnings": []
}
```

File paths are relative to the workspace root; line numbers are 0-based. `codeBytes`, `usedCodeBytes` and `utilization` are `null` for packages that are not scored.

---

## 11. How to Run (Development)

Prerequisites: Node.js 18+, VSCode 1.85+, and the target project's dependencies installed (`npm install`, `dart pub get` / `flutter pub get`, or a Python virtual environment).

```bash
npm install
npm run compile
npm test
code --extensionDevelopmentPath=/path/to/deptax /path/to/your-project   # or F5
```

---

## 12. Tier 1 Recipe Expansion Targets (Future)

| Target | Package | Native replacement |
|---|---|---|
| `capitalize(str)` | `lodash` | `str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()` |
| `clamp(val, min, max)` | `lodash` | `Math.min(Math.max(val, min), max)` (lodash also handles `NaN` and a missing lower bound) |
| `format(date, …)` | `date-fns`, `dayjs` | `Intl.DateTimeFormat` for fixed patterns |
| `red(str)` | `chalk` | ANSI escape codes |
| `isNullOrBlank` | `quiver` | `s == null \|\| s.trim().isEmpty` |

Every new recipe needs a differential test like `test/recipes.test.ts`.

---

## 13. Roadmap

1. Scan performance: debounce and single-flight scans, cache package analyses by (name, version) and project files by modification time, move analysis off the extension host thread.
2. Test projects per ecosystem (pip and pub fixtures alongside the npm smoke test).
3. Member-level liveness for classes and Dart extensions.
4. Threshold configuration (`.deptaxrc.json`) and calibration of the thresholds on real projects.
5. Eviction engine (Stage 5), then Tier 2 extraction from the liveness results.
6. CLI (`deptax scan --fail-on parasitic`) around the same pipeline.

---

## 14. Validation Results

Measured with model v2 on real installed packages:

| Project | Package | Status | Used / carried code | Removal frees |
|---|---|---|---|---|
| npm | `date-fns` (`format`) | 🔴 parasitic | 96 KB / 1.8 MB (5 %) | 21.1 MB |
| npm | `lodash-es` (`debounce`) | 🔴 parasitic | 15 KB / 613 KB (2 %) | 621 KB |
| npm | `lodash` (`isEqual`) | 🟡 bloated | 61 KB / 593 KB (10 %), via `lodash/isEqual.js` | 1.3 MB |
| npm | `react-dom`, `react`, `zod`, `axios`, `dayjs` | 🟢 healthy | 47–100 % | — |
| npm | `chalk` (never imported) | ⚪ unused | — | 43 KB |
| pip | `PyYAML` (`safe_dump`) | 🟢 healthy | 440 KB / 587 KB (75 %) | 590 KB |
| pip | `rich` (never imported) | ⚪ unused | — | 1.4 MB |
| pip | `attrs` (under `TYPE_CHECKING` only) | 🔧 tooling | — | — |
| pub | `quiver` (`isBlank`) | 🔴 parasitic | 4 KB / 191 KB (2 %) | 460 KB |
| pub | `intl` (`DateFormat`) | 🔴 parasitic | 121 KB / 1.2 MB (10 %) | 2.2 MB |
| DepTax itself | `web-tree-sitter` | 🟢 healthy | 72 KB / 72 KB (100 %) | 272 KB |

---

## 15. Why the v1 Model Was Replaced

v1 was `Φ = S·(1 + 0.25·T)`, `U = Σ ln(1 + C(s))`, `Score = Φ / (U + 0.1)`, with thresholds 25 and 150. Problems found:

- **It ranked by size.** Doubling size doubled the score; doubling usage added at most ln 2 to the denominator. A 1 MB package called 10 000 times scored 107 (parasitic); a 10 MB package needed about 171 distinct symbols to be healthy. On its own repository, v1 flagged 9 of 9 packages as parasitic, including `web-tree-sitter`, which the extension cannot run without.
- **It never compared used with available**, the project's stated goal: exported symbol counts were displayed but not used.
- **The transitive term had the wrong shape.** It multiplied P's own size by its count of *direct* dependencies, and never measured those dependencies.
- **The utilization floor was not monotone.** One extra call could make a score nine times worse.
- **The units were arbitrary** (KB per log-call), and the thresholds uncalibrated.
- **Unused and unmeasured packages were mislabelled.** Unused ones were placed on the same scale; not-installed ones scored 0 and showed as healthy.

Measurement defects fixed at the same time:

- Python parsing always failed (grammar ABI mismatch).
- Aliased, default and namespace imports registered zero calls.
- Python distribution names were confused with import names.
- The Dart export regex captured method names such as `build` from every line.
- Call counting included comments and strings.
- Diagnostics missed multi-line imports.
- The `isEqual` recipe disagreed with lodash on NaN, Date, Map, Set, RegExp, class instances and cycles.
- Eviction was offered when any single symbol had a recipe.

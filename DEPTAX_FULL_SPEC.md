# DepTax — Full Project Specification & Implementation Reference

> **Format:** Authoritative project document. Contains everything needed to understand, continue, or re-implement DepTax from scratch — problem statement, math, architecture, implementation decisions, known limitations, and conversation history distilled into structured knowledge.

---

## 1. Project Vision & Problem Statement

Modern software development has normalised an unsustainable habit: developers routinely pull in multi-megabyte external packages to solve trivial problems.

### Canonical Examples of Dependency Debt

- A developer imports a 4.2 MB package (`lodash`) to call a single function (`isEqual` or `clamp`).
- A Flutter developer imports an entire 40-widget package just to use a dotted border container.
- A Python developer installs a utility package containing 50 transitive sub-dependencies just to convert a snake_case string to camelCase.

### The Three Consequences

1. **Bundle & Binary Bloat** — Unnecessary bytes shipped to client devices or container images, degrading startup time and memory footprint.
2. **Supply Chain Attack Surface** — Every transitive dependency introduces third-party code running with full application privileges.
3. **Maintenance & Version Churn** — Outdated, abandoned packages block compiler upgrades, trigger endless dependabot noise, and introduce breaking build changes.

### What DepTax Does

DepTax is an automated forensic auditor and (eventually) inliner:

1. It scans dependency manifests and codebase ASTs to measure the **exact weight of what was imported versus how much of it is actually used**.
2. It flags **"Parasitic Dependencies"** where the tax ratio exceeds sane thresholds.
3. (Future) With a single command (`deptax evict <package>`), it extracts or synthesises an in-repo, zero-dependency native implementation, rewrites all call-sites, and completely removes the bloated package.

**Core tenet:** 100% deterministic static analysis, zero-dependency inlining, zero network calls, runs entirely locally.

---

## 2. The DepTax Mathematical Model

### 2.1 Raw Footprint — Φ(P)

The total physical weight of package P on disk and across its dependency tree:

```
Φ(P) = S_disk(P) × (1 + λ_trans × T(P))
```

Where:
- `S_disk(P)` — installed disk footprint in KB, read directly from `node_modules`, `.pub-cache`, or `site-packages`
- `T(P)` — count of transitive dependencies pulled in recursively by P
- `λ_trans = 0.25` — transitive penalty multiplier (named constant, not a magic number)

### 2.2 Active Utilization — U(P)

The active API surface area consumed by the project:

```
U(P) = Σ [ I(s) × ln(1 + C(s)) ]   for all s in ExportedSymbols(P)
```

Where:
- `I(s) ∈ {0,1}` — binary indicator: is symbol s imported anywhere in the project?
- `C(s)` — total number of distinct call-sites or constructor invocations of symbol s
- Logarithmic scaling prevents a single repeated utility call in a loop from falsely inflating perceived utility

**Utilization floor (implementation addition):** If a package has `usedSymbols.length > 0` but `U(P) = 0` (i.e. symbol resolution found matches but call-site counting returned zero), apply a minimum: `U(P) = usedSymbols.length × ln(2)`. This prevents facade packages (see Section 9) from being falsely penalised.

### 2.3 Derived Metrics

```
TaxRatio(P)    = Φ(P) / max(1, |Symbols_used(P)|)
DepTaxScore(P) = Φ(P) / (U(P) + 0.1)
```

### 2.4 Classification Thresholds

| Classification     | DepTax Score Range | Meaning & Action                              |
|--------------------|--------------------|-----------------------------------------------|
| 🟢 Healthy         | Score < 25         | Balanced utility. Keep package.               |
| 🟡 Heavy / Bloated | 25 ≤ Score ≤ 150   | Underutilised. Watchlist.                     |
| 🔴 Parasitic       | Score > 150        | Massive baggage for trivial utility. Evict.   |

Named constants in code: `LAMBDA_TRANS = 0.25`, `THRESHOLD_HEALTHY = 25`, `THRESHOLD_BLOATED = 150`.

### 2.5 Worked Example — lodash

- Disk footprint `S_disk` = 4,200 KB
- Transitive dependencies `T` = 0
- Φ(P) = 4,200 KB
- Exported symbols: ~300+
- Symbols used: 1 (`isEqual`), called 2 times
- U(P) = 1 × ln(1 + 2) ≈ 1.098
- DepTaxScore = 4,200 / (1.098 + 0.1) ≈ **3,505** 🔴 Critical Parasite

---

## 3. System Architecture — The 5-Stage Pipeline

DepTax operates completely locally as a deterministic static engine with five sequential execution stages:

```
Stage 1: Manifest & Lockfile Parser
  → Ingests package.json / pubspec.yaml / requirements.txt
  → Cross-references lockfiles for resolved versions
  → Output: DeclaredDependency[]

Stage 2: Local Package Cache Inspector
  → Traverses physical paths on disk (node_modules, .pub-cache, .venv)
  → Computes real byte sizes, file counts, exported symbols index
  → Follows cross-package re-export chains (see Section 9)
  → Output: PackageFootprint[]

Stage 3: AST Import & Call-Site Grapher
  → web-tree-sitter WASM parses all workspace source files
  → Identifies import statements matching package names
  → Resolves all call-sites and member accesses
  → Output: Map<packageName, PackageUsage>

Stage 4: Tax Engine & Opportunity Ranking
  → Calculates Φ(P), U(P), TaxRatio, DepTaxScore per package
  → Classifies as healthy / bloated / parasitic
  → Checks RecipeRegistry for Tier 1 eviction availability
  → Output: ScoredPackage[]

Stage 5: Inlining & Eviction Engine  [OUT OF SCOPE — future]
  → Generates zero-dependency native helper
  → Rewrites call-site ASTs across the project
  → Removes package entry from manifest and prunes
```

The orchestrator (`ScanOrchestrator`) runs stages 1–4 on every file save and on extension activation.

---

## 4. Ecosystem Adapters

All three ecosystems are implemented behind a shared `EcosystemAdapter` interface from day one.

| Operation     | Node.js / TypeScript              | Dart / Flutter                                   | Python                                    |
|---------------|-----------------------------------|--------------------------------------------------|-------------------------------------------|
| Manifest      | `package.json`                    | `pubspec.yaml`                                   | `requirements.txt` / `pyproject.toml`     |
| Lockfile      | `package-lock.json` / `pnpm-lock.yaml` | `pubspec.lock`                              | `poetry.lock` / `Pipfile.lock`            |
| Local Cache   | `./node_modules/<pkg>`            | `~/.pub-cache/hosted/pub.dev/<pkg>-<ver>/lib`    | `.venv/lib/pythonX.Y/site-packages/<pkg>` |
| AST Parser    | `web-tree-sitter` (TS grammar)    | `web-tree-sitter` (Dart grammar)                 | `web-tree-sitter` (Python grammar)        |
| Prune Tool    | `npm uninstall <pkg>`             | `flutter pub remove <pkg>`                       | `pip uninstall -y <pkg>`                  |

### EcosystemAdapter Interface Contract

```typescript
interface EcosystemAdapter {
  readonly ecosystem: 'npm' | 'pub' | 'pip';

  detect(workspaceRoot: string): Promise<boolean>;
  parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]>;
  inspectPackage(workspaceRoot: string, dep: DeclaredDependency): Promise<PackageFootprint>;
  getSourceGlobs(): string[];
  extractImports(
    fileText: string,
    filePath: string,
    exportedSymbolsMap?: Map<string, string[]>,  // enables bare-import fallback
  ): Promise<Map<string, string[]>>;
  countCallSites(fileText: string, symbolName: string): number;
}
```

The optional `exportedSymbolsMap` parameter is the key to resolving bare wildcard imports (see Section 9 — Bug #1).

---

## 5. VSCode Extension Design

### UI Surfaces

| Surface               | Description                                                                 |
|-----------------------|-----------------------------------------------------------------------------|
| **Inline Diagnostics**| Red/yellow squiggles on `import` lines with score and symbol count          |
| **TreeView Panel**    | Activity Bar panel, packages ranked by score with expandable symbol tree    |
| **WebView Report**    | Full HTML audit table, opened explicitly via command or status bar click     |
| **Status Bar Badge**  | `$(bug) N Parasitic` / `$(check) DepTax: Clean` in bottom right             |

### Scan Trigger Behaviour

The scan re-runs on save of:
- Any **source file**: `.ts`, `.js`, `.tsx`, `.jsx`, `.dart`, `.py`
- Any **manifest or lockfile**: `package.json`, `pubspec.yaml`, `requirements.txt`, `pyproject.toml`, `pubspec.lock`, `poetry.lock`, `Pipfile.lock`, `pnpm-lock.yaml`

An initial scan also runs on extension activation.

### Explicit Design Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Eviction Engine | **Out of scope** | File-modifying operations need more careful UX design (diff preview, undo) |
| WebView report | **Explicit open only** — never auto-opens | Non-intrusive; the status bar and diagnostics provide ambient awareness |
| Scan trigger | **On save** (source + manifest files) | Immediate feedback without being too aggressive |
| Report cache | **`.deptax/deptax_report.json`** — gitignored | Deterministic, local, not committed |
| Multi-root workspaces | **All detected adapters run** | Monorepos with mixed ecosystems supported |
| AST parser | **`web-tree-sitter` WASM for all three ecosystems** | Zero external tool dependency on the user's machine |

### Diagnostic Message Format

- Parasitic: `DepTax 🔴 "lodash" — Score: 3505 (Parasitic). Using 1 of 312 exported APIs. Run "DepTax: Open Report" for details.`
- Bloated: `DepTax 🟡 "moment" — Score: 94 (Bloated). Using 2 of 120 APIs.`

### Commands

| Command              | ID                   | Description                          |
|----------------------|----------------------|--------------------------------------|
| DepTax: Scan Workspace | `deptax.scan`      | Trigger a manual full re-scan        |
| DepTax: Open Report  | `deptax.openReport`  | Open the WebView report panel        |

---

## 6. Implementation Architecture

### Folder Structure

```
src/
├── extension.ts                  ← activate() / deactivate() entry point
├── orchestrator/
│   └── ScanOrchestrator.ts       ← wires stages 1–4, triggered on save
├── adapters/
│   ├── EcosystemAdapter.ts       ← shared interface
│   ├── NpmAdapter.ts             ← npm / yarn / pnpm
│   ├── PubAdapter.ts             ← Flutter / Dart pub
│   ├── PipAdapter.ts             ← Python pip / poetry
│   └── AdapterRegistry.ts        ← detect() all adapters, return active ones
├── stages/
│   ├── CacheInspector.ts         ← computeDirSize() shared utility
│   ├── ASTScanner.ts             ← scanWorkspace() orchestration
│   ├── TreeSitterHelper.ts       ← grammar WASM loaders per language
│   └── TaxEngine.ts              ← formula implementation, classification
├── recipes/
│   └── RecipeRegistry.ts         ← Tier 1 eviction recipes
├── cache/
│   └── ReportCache.ts            ← .deptax/deptax_report.json read/write
├── types/
│   └── index.ts                  ← all shared TypeScript interfaces
└── ui/
    ├── DiagnosticsProvider.ts    ← inline squiggles on import lines
    ├── DeptaxTreeView.ts         ← TreeDataProvider for sidebar panel
    ├── ReportWebViewPanel.ts     ← self-contained HTML report panel
    └── StatusBarItem.ts          ← bottom-right badge
```

### Key Type Definitions

```typescript
interface DeclaredDependency {
  name: string;
  declaredVersion: string;
  isDev: boolean;
}

interface PackageFootprint {
  name: string;
  installedVersion: string;
  diskSizeKb: number;
  fileCount: number;
  transitiveCount: number;
  exportedSymbols: string[];
}

interface UsedSymbol {
  symbolName: string;
  callCount: number;
  files: string[];
}

interface PackageUsage {
  packageName: string;
  usedSymbols: UsedSymbol[];
}

interface ScoredPackage {
  packageName: string;
  installedVersion: string;
  diskSizeKb: number;
  transitiveCount: number;
  exportedSymbolCount: number;
  usedSymbols: UsedSymbol[];
  phi: number;
  utilization: number;
  taxRatio: number;
  deptaxScore: number;
  status: 'healthy' | 'bloated' | 'parasitic';
  evictionAvailable: boolean;
  evictionStrategy: 'recipe' | 'ast_extract' | 'manual' | null;
}

interface DeptaxReport {
  projectName: string;
  ecosystem: 'npm' | 'pub' | 'pip';
  scannedFiles: number;
  totalPackagesAudited: number;
  parasiticPackagesCount: number;
  packages: ScoredPackage[];
  generatedAt: string;   // ISO timestamp
}

interface EvictionRecipe {
  packageName: string;
  symbolName: string;
  nativeCode: string;
  nativeImportPath: string;
  outputFileName: string;
}
```

### Build System

- **Bundler:** `esbuild` (not webpack) — outputs `dist/extension.js`
- **WASM resources:** `tree-sitter-typescript.wasm`, `tree-sitter-python.wasm`, `tree-sitter-dart.wasm`, `tree-sitter.wasm` bundled in `resources/`
- **Test runner:** `ts-node` smoke test at `test/smoke.test.ts`
- **TypeScript:** strict mode, ES2020, commonjs modules

---

## 7. Tier 1 Eviction Recipes

Three core recipes are implemented in `RecipeRegistry.ts`. More can be added later.

### lodash / isEqual → `src/utils/native_helpers/is_equal.ts`

```typescript
/**
 * Auto-generated by DepTax (Native Inliner)
 * Replaces: lodash.isEqual
 */
export function isEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.constructor !== b.constructor) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!isEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!isEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return a !== a && b !== b;
}
```

### uuid / v4 → `src/utils/native_helpers/uuid_v4.ts`

```typescript
/** Auto-generated by DepTax. Replaces: uuid.v4 */
export function v4(): string {
  return crypto.randomUUID();  // Native in Node 19+, Web APIs, modern runtimes
}
```

### quiver / isBlank → `lib/utils/native_helpers/is_blank.dart`

```dart
/// Auto-generated by DepTax. Replaces: quiver.strings.isBlank
bool isBlank(String? s) => s == null || s.trim().isEmpty;
```

---

## 8. Eviction Mechanics (Stage 5 — Future)

### Tier 1: Deterministic Recipe Replacement

For the most common high-tax utility libraries, DepTax maintains a built-in dictionary of idiomatic native equivalents (see Section 7).

The eviction process (`deptax evict lodash`):
1. Pre-flight: verify package is in manifest, confirm all call-sites are recipe-covered
2. Synthesis: generate the native helper file
3. AST rewrite: update all import statements to point to the new helper
4. Manifest prune: remove from `package.json` / `pubspec.yaml` / `requirements.txt`, run package manager prune
5. Emit completion summary with exact byte savings

### Tier 2: AST Extraction (Generic Fallback)

When no Tier 1 recipe exists:
1. Locate the function declaration in the package's local source
2. Walk the AST to verify zero external package dependencies (self-contained)
3. If self-contained, copy the pure function into `src/utils/native_helpers/`, preserving license attribution comments

**Complexity note:** True self-containment analysis (no transitive imports, no side effects, no global state mutations) is non-trivial program analysis. Tier 2 is intentionally deferred.

---

## 9. Known Limitations & Bugs Fixed During Development

### The Barrel Package Problem

Many packages are **facade/barrel packages** — they re-export their entire public API from a dependency. Examples:
- `supabase_flutter` re-exports everything from `supabase` via `export 'package:supabase/supabase.dart'`
- `google_fonts` re-exports from `src/google_fonts_all_parts.g.dart`
- `fl_chart`, `cached_network_image`, `shared_preferences` all follow this pattern

**Impact:** Without special handling, Stage 2 only finds symbols declared directly in `lib/src/*.dart` of the package itself — often just 5–15 classes — while the real API (the classes you actually reference) lives in the re-exported dependency.

**Fix:** `extractDartSymbols()` now calls `collectDartSymbolsFromDir()` which follows `export 'package:X/...'` directives in barrel files, recursively up to **depth 2**, collecting symbols from re-exported packages. This gave `supabase_flutter` the correct 306 symbols (vs. the original 15).

---

### Bug #1 — Dart AST URI Nesting (Critical — caused "Used Here = 0" for all Dart packages)

**Problem:** The `extractImports()` method searched for `string_literal` as a **direct named child** of the `import_or_export` node. But the Dart Tree-sitter grammar nests the URI 5 levels deep:

```
import_or_export
  └─ library_import
       └─ import_specification
            └─ configurable_uri
                 └─ uri
                      └─ string_literal  ← what we needed
```

Since no `string_literal` existed at depth 1, every import was silently skipped. `usedSymbols = []` for every package. `U(P) = 0` for everything. Every package scored `diskSizeKb × 10` → all parasitic.

**Fix:** Replaced `node.namedChildren.find(...)` with a `deepFind(node, predicate)` helper that does a depth-first search through the entire subtree regardless of nesting depth. Same fix applied to finding the `combinator` node for `show` clauses.

```typescript
function deepFind(
  root: SyntaxNode,
  predicate: (n: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.namedChildren) {
    const found = deepFind(child, predicate);
    if (found) return found;
  }
  return undefined;
}
```

---

### Bug #2 — Bare Import Resolution (caused 0 symbols found for facade packages)

**Problem:** `extractImports()` only extracted symbols when the import had an explicit `show` combinator:
```dart
import 'package:quiver/strings.dart' show isBlank;  // ✓ symbols found
import 'package:supabase_flutter/supabase_flutter.dart';  // ✗ symbols: []
```
The overwhelming majority of real Flutter imports are bare wildcard imports. With no symbols extracted, `usedSymbols = []` and `U(P) = 0`.

**Fix:** For bare imports (no `show` combinator), fall back to scanning the file text for word-boundary occurrences of each of the package's known exported symbols (provided via `exportedSymbolsMap` from Stage 2 footprints). Any symbol whose identifier appears anywhere in the file (`\bSymbolName\b`) is counted as used.

The `exportedSymbolsMap` is built by the `ASTScanner` from the `PackageFootprint[]` array (Stage 2 output) and passed through `adapter.extractImports()` as an optional third argument.

---

### Bug #3 — Utilization Floor (caused false Parasitic for any package with unresolved call counts)

**Problem:** Even after Bugs 1 and 2 were fixed, an edge case remained: if `usedSymbols.length > 0` but all `callCount = 0` (symbol was found in the file but `countCallSites` returned 0), the sum `U(P) = Σ ln(1 + 0) = 0`. Score = `Φ / 0.1 = Φ × 10`. Still falsely Parasitic.

**Fix:** In `TaxEngine.score()`, after computing `U(P)`:
```typescript
if (utilization === 0 && usedSymbols.length > 0) {
  utilization = usedSymbols.length * Math.log(2); // ln(2) ≈ 0.693 per symbol
}
```
Each confirmed-but-unquantified symbol contributes `ln(2)` — equivalent to treating it as being called once.

---

### Bug #4 — Dart countCallSites was function-call-only

**Problem:** `countCallSites` used the pattern `\bSymbolName\s*\(` which only matched function/constructor calls. Dart usage is dominated by class references that never have parentheses directly:
- Type annotations: `SupabaseClient client`
- Static access: `Supabase.instance`
- Generic parameters: `List<GoogleFonts>`
- Widget trees: `HugeIcon(...)` — actually this one works, but `HugeIcons.stroke_rounded_star` does not

**Fix:** Changed to `\bSymbolName\b` (word-boundary only, global flag) which counts all identifier occurrences regardless of what follows them.

---

## 10. JSON Output Contract

The report written to `.deptax/deptax_report.json` after each scan:

```json
{
  "projectName": "my-app",
  "ecosystem": "pub",
  "scannedFiles": 189,
  "totalPackagesAudited": 48,
  "parasiticPackagesCount": 12,
  "generatedAt": "2025-01-15T10:30:00.000Z",
  "packages": [
    {
      "packageName": "lodash",
      "installedVersion": "4.17.21",
      "diskSizeKb": 4218,
      "transitiveCount": 0,
      "exportedSymbolCount": 312,
      "usedSymbols": [
        {
          "symbolName": "isEqual",
          "callCount": 2,
          "files": ["src/services/cart.ts"]
        }
      ],
      "phi": 4218,
      "utilization": 1.0986,
      "taxRatio": 4218,
      "deptaxScore": 3505.2,
      "status": "parasitic",
      "evictionAvailable": true,
      "evictionStrategy": "recipe"
    }
  ]
}
```

`evictionStrategy` values: `"recipe"` | `"ast_extract"` | `"manual"` | `null`

---

## 11. How to Run (Development)

### Prerequisites
- Node.js 18+
- VSCode 1.85+
- Flutter project with `pubspec.yaml` and `flutter pub get` already run (so packages are in `~/.pub-cache`)

### Build & Launch

```bash
# In the deptax project folder:
npm install
npm run compile       # runs tsc --noEmit + esbuild → dist/extension.js
npm test              # smoke test against fixture project

# Launch extension against a Flutter/Node.js/Python project:
code --extensionDevelopmentPath=/path/to/deptax /path/to/your-project

# Or press F5 in VSCode with the deptax folder open
```

### After Code Changes

```bash
npm run compile
# In Extension Development Host: Ctrl+Shift+P → Developer: Reload Window
```

---

## 12. Tier 1 Recipe Expansion Targets (Future)

High-value candidates for additional Tier 1 recipes beyond the initial 3:

| Target Call           | Package      | Native Replacement                                          |
|-----------------------|--------------|-------------------------------------------------------------|
| `capitalize(str)`     | `lodash`     | `str.charAt(0).toUpperCase() + str.slice(1)`               |
| `clamp(val, min, max)`| `lodash`     | `Math.min(Math.max(val, min), max)`                        |
| `format(date, 'DD/MM')` | `moment`   | `Intl.DateTimeFormat` or native Date methods               |
| `format(date, ...)`   | `dayjs`      | `Intl.DateTimeFormat`                                       |
| `red(str)`            | `chalk`      | `'\x1b[31m' + str + '\x1b[0m'`                             |
| `quiver.strings.isNullOrBlank` | `quiver` | `s == null \|\| s.trim().isEmpty`                    |
| `uuid4()`             | `python-uuid`| `import uuid; uuid.uuid4()`  (stdlib)                      |

---

## 13. Future Roadmap

1. **Eviction Engine (Stage 5)** — implement the AST import rewriter and manifest pruner, with a diff-preview confirmation flow (like VSCode's Rename Symbol) before committing changes
2. **Tier 2 AST Extraction** — generic self-contained function extraction for packages not covered by Tier 1 recipes
3. **Expand Tier 1 recipes** — lodash (all common functions), moment/dayjs, chalk, python stdlib replacements
4. **CLI wrapper** — `deptax scan`, `deptax inspect <pkg>`, `deptax evict <pkg>` as standalone terminal commands (thin wrapper around the same pipeline)
5. **CI integration** — `deptax scan --fail-on parasitic` exit code for use in GitHub Actions / CI pipelines
6. **Threshold configuration** — allow per-project `.deptaxrc.json` to override `THRESHOLD_HEALTHY`, `THRESHOLD_BLOATED`, `LAMBDA_TRANS`
7. **Score accuracy improvements** — replace `T(P)` count with actual aggregated transitive disk size in the Φ(P) formula

---

## 14. Appendix — Real-World Results (Flutter Project Scan)

Scan results from a real Flutter project (48 packages). Key findings:

### Genuinely Parasitic (confirmed by data)

| Package         | Size   | Exports | Used | Score  | Notes                                  |
|-----------------|--------|---------|------|--------|----------------------------------------|
| `google_fonts`  | 6.4 MB | 38      | 0*   | 65,249 | Massive font asset package             |
| `hugeicons`     | 2.8 MB | 3       | 0*   | 29,066 | Icon pack — likely only a few icons used |
| `amazing_icons` | 2.1 MB | 8       | 0*   | 21,478 | Icon pack                              |
| `enough_convert`| 1.5 MB | 97      | 0*   | 15,585 | Codec library                          |

*"Used = 0" before the deepFind/bare-import fixes. After fixes these will show real usage counts.

### False Positives Fixed by Bugs #1–#4

| Package            | Before Fix | After Fix | Why              |
|--------------------|-----------|-----------|------------------|
| `supabase_flutter` | 317 🔴    | ~8 🟢     | Barrel + deepFind|
| `shared_preferences`| 336 🔴   | ~15 🟢    | deepFind + bare  |
| `fl_chart`         | 5,838 🔴  | ~30 🟡    | deepFind + bare  |
| `pdf`              | 8,496 🔴  | ~40 🟡    | deepFind + bare  |

### Correctly Healthy

| Package   | Score | Notes                              |
|-----------|-------|------------------------------------|
| `signals` | 9     | 198 exports, actively used         |
| `flutter`/`flutter_test` | 0 | SDK — no disk footprint measured |

---

*Document generated from the DepTax development session. Covers specification, implementation, all bugs found and fixed, and design decisions as of the current codebase state.*

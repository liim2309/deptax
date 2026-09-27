# DepTax VSCode Extension — Implementation Plan

> **Superseded:** the scoring model (Φ, U, DepTax Score) and the pipeline details in this document were replaced by model v2. See `DEPTAX_FULL_SPEC.md` §2–§4 and §15.

## Top-Level Overview

**Goal:** Build DepTax as a fully functional VSCode extension that audits third-party dependencies across Node.js/TypeScript, Flutter/Dart, and Python projects. On every file save, the extension scans the workspace, computes DepTax scores, and surfaces findings via inline diagnostics, a TreeView panel, a WebView report panel, and a status bar badge. The Eviction Engine (automated inlining) is explicitly **out of scope** for this implementation.

**Approach:**
- All three ecosystems (npm, pub, pip) are implemented from the start behind a shared `EcosystemAdapter` interface.
- AST parsing uses `web-tree-sitter` (WASM bindings) uniformly — no external tool dependencies required on the user's machine.
- The pipeline is deterministic and local-only: no network calls, no compiler invocation.
- The scan result is cached as `deptax_report.json` (gitignored) and invalidated on file save.

**Out of scope:** Eviction Engine (Stage 5), Tier 2 AST extraction, CLI wrapper.

---

## Architecture Overview

```
Extension Host Process
├── Activation: triggered by presence of package.json / pubspec.yaml / requirements.txt
├── ScanOrchestrator          ← entry point, triggered on file save
│   ├── Stage 1: ManifestParser       (per ecosystem adapter)
│   ├── Stage 2: CacheInspector       (per ecosystem adapter)
│   ├── Stage 3: ASTScanner           (web-tree-sitter, per ecosystem adapter)
│   ├── Stage 4: TaxEngine            (pure math, ecosystem-agnostic)
│   └── ReportCache           → deptax_report.json
└── UI Layer
    ├── DiagnosticsProvider   ← inline squiggles on import lines
    ├── DeptaxTreeView        ← Explorer sidebar panel
    ├── ReportWebViewPanel    ← full table report
    └── StatusBarItem         ← parasitic count badge
```

---

## Sub-Tasks

---

### Sub-Task 1: Extension Scaffold & Project Structure

**Status:** `[ ] pending`

**Intent:**
Bootstrap the VSCode extension project with the correct TypeScript configuration, folder structure, dependency list, and `package.json` manifest. This is the foundation everything else builds on. Getting it right here prevents rework in every subsequent sub-task.

**Expected Outcomes:**
- Running `npm run compile` produces a working (empty) extension with no TypeScript errors.
- The extension activates in a VSCode Extension Development Host window without crashing.
- All required npm dependencies are installed (`web-tree-sitter`, `vscode` types, etc.).
- Folder structure matches the architecture defined above.
- `deptax_report.json` is added to `.gitignore`.

**Todo List:**
1. Run `yo code` scaffold or manually create the `package.json` extension manifest with:
   - `contributes.viewsContainers` for the sidebar panel
   - `contributes.views` for the TreeView
   - `contributes.commands` for `deptax.scan` and `deptax.openReport`
   - `activationEvents`: `onLanguage:typescript`, `onLanguage:javascript`, `onLanguage:dart`, `onLanguage:python`, `workspaceContains:package.json`, `workspaceContains:pubspec.yaml`, `workspaceContains:requirements.txt`
2. Configure `tsconfig.json` targeting `ES2020`, `module: commonjs`, `strict: true`.
3. Create the folder structure:
   ```
   src/
   ├── extension.ts                  ← activate() entry point
   ├── orchestrator/
   │   └── ScanOrchestrator.ts
   ├── adapters/
   │   ├── EcosystemAdapter.ts       ← shared interface
   │   ├── NpmAdapter.ts
   │   ├── PubAdapter.ts
   │   └── PipAdapter.ts
   ├── stages/
   │   ├── ManifestParser.ts
   │   ├── CacheInspector.ts
   │   ├── ASTScanner.ts
   │   └── TaxEngine.ts
   ├── ui/
   │   ├── DiagnosticsProvider.ts
   │   ├── DeptaxTreeView.ts
   │   ├── ReportWebViewPanel.ts
   │   └── StatusBarItem.ts
   ├── recipes/
   │   └── RecipeRegistry.ts
   ├── types/
   │   └── index.ts                  ← all shared TypeScript interfaces
   └── cache/
       └── ReportCache.ts
   ```
4. Install npm dependencies: `web-tree-sitter`, `@types/vscode`, `typescript`, `esbuild` (bundler).
5. Add `deptax_report.json` to `.gitignore`.
6. Set up `esbuild` bundle script so the extension ships as a single `dist/extension.js`.

**Relevant Context:**
- VSCode extension `package.json` manifest: https://code.visualstudio.com/api/references/extension-manifest
- Activation events best practice: use `workspaceContains` to avoid activating on unrelated projects.

---

### Sub-Task 2: Shared Types & EcosystemAdapter Interface

**Status:** `[ ] pending`

**Intent:**
Define all shared TypeScript interfaces and the `EcosystemAdapter` contract before any stage or adapter code is written. This ensures every subsequent sub-task compiles against a stable type contract and prevents interface drift between adapters.

**Expected Outcomes:**
- `src/types/index.ts` is complete and exported — all pipeline types are defined.
- `src/adapters/EcosystemAdapter.ts` defines the adapter interface.
- No implementation code yet — purely type definitions.

**Todo List:**
1. Define core types in `src/types/index.ts`:
   ```typescript
   // The parsed manifest for one package
   interface DeclaredDependency {
     name: string;
     declaredVersion: string;
     isDev: boolean;
   }

   // Result of Stage 2 cache inspection
   interface PackageFootprint {
     name: string;
     installedVersion: string;
     diskSizeKb: number;
     fileCount: number;
     transitiveCount: number;
     exportedSymbols: string[];   // list of exported API names
   }

   // One used symbol found by the AST scanner
   interface UsedSymbol {
     symbolName: string;
     callCount: number;
     files: string[];
   }

   // Full result per package after Stage 3
   interface PackageUsage {
     packageName: string;
     usedSymbols: UsedSymbol[];
   }

   // Final scored result per package (output of TaxEngine)
   interface ScoredPackage {
     packageName: string;
     installedVersion: string;
     diskSizeKb: number;
     transitiveCount: number;
     exportedSymbolCount: number;
     usedSymbols: UsedSymbol[];
     phi: number;             // Φ(P) raw footprint
     utilization: number;     // U(P)
     taxRatio: number;
     deptaxScore: number;
     status: 'healthy' | 'bloated' | 'parasitic';
     evictionAvailable: boolean;
     evictionStrategy: 'recipe' | 'ast_extract' | 'manual' | null;
   }

   // The full scan report (written to deptax_report.json)
   interface DeptaxReport {
     projectName: string;
     ecosystem: 'npm' | 'pub' | 'pip';
     scannedFiles: number;
     totalPackagesAudited: number;
     parasiticPackagesCount: number;
     packages: ScoredPackage[];
     generatedAt: string;   // ISO timestamp
   }
   ```
2. Define `EcosystemAdapter` interface in `src/adapters/EcosystemAdapter.ts`:
   ```typescript
   interface EcosystemAdapter {
     readonly ecosystem: 'npm' | 'pub' | 'pip';

     // Stage 1: does this workspace contain this ecosystem's manifest?
     detect(workspaceRoot: string): Promise<boolean>;

     // Stage 1: parse the manifest and lockfile
     parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]>;

     // Stage 2: inspect local package cache for disk footprint + exported symbols
     inspectPackage(workspaceRoot: string, dep: DeclaredDependency): Promise<PackageFootprint>;

     // Stage 3: return the source file glob patterns to scan
     getSourceGlobs(): string[];

     // Stage 3: given a source file's text and its AST, extract all import statements
     // Returns map of packageName → list of imported symbol names
     extractImports(fileText: string, filePath: string): Promise<Map<string, string[]>>;

     // Stage 3: given a source file's text, count call-sites for a given symbol name
     countCallSites(fileText: string, symbolName: string): number;
   }
   ```
3. Define the `EvictionRecipe` type (for the RecipeRegistry in Sub-Task 6):
   ```typescript
   interface EvictionRecipe {
     packageName: string;
     symbolName: string;
     nativeCode: string;         // the generated helper file content
     nativeImportPath: string;   // e.g. '../utils/native_helpers/is_equal'
     outputFileName: string;     // e.g. 'is_equal.ts'
   }
   ```

**Relevant Context:**
- The JSON output contract in spec Section 7 maps directly to `DeptaxReport` and `ScoredPackage`.
- The formulas in spec Section 2 map to the `phi`, `utilization`, `taxRatio`, `deptaxScore` fields.

---

### Sub-Task 3: Stage 1 — Manifest Parsers (All Three Adapters)

**Status:** `[ ] pending`

**Intent:**
Implement the `detect()` and `parseManifest()` methods for all three ecosystem adapters. This gives the pipeline its full list of declared dependencies before any disk or AST work begins.

**Expected Outcomes:**
- `NpmAdapter.parseManifest()` reads `package.json` and cross-references `package-lock.json` or `pnpm-lock.yaml` for resolved versions.
- `PubAdapter.parseManifest()` reads `pubspec.yaml` and cross-references `pubspec.lock`.
- `PipAdapter.parseManifest()` reads `requirements.txt` or `pyproject.toml` and cross-references `poetry.lock` or `Pipfile.lock`.
- All three return the normalized `DeclaredDependency[]` array.
- Dev dependencies are flagged with `isDev: true` but still included in the scan.

**Todo List:**
1. **NpmAdapter** (`src/adapters/NpmAdapter.ts`):
   - `detect()`: check if `package.json` exists at workspace root.
   - `parseManifest()`: `JSON.parse` `package.json`, combine `dependencies` and `devDependencies`. Read `package-lock.json` for resolved `version` fields. Fall back to declared version range if lockfile absent.
2. **PubAdapter** (`src/adapters/PubAdapter.ts`):
   - `detect()`: check if `pubspec.yaml` exists at workspace root.
   - `parseManifest()`: use a minimal YAML parser (or a regex-based line parser for `pubspec.yaml` since the format is simple) to extract `dependencies:` and `dev_dependencies:` blocks. Cross-reference `pubspec.lock` for resolved versions.
   - Note: `pubspec.yaml` uses indented key-value pairs; no full YAML library needed — a line-by-line state machine parser is sufficient.
3. **PipAdapter** (`src/adapters/PipAdapter.ts`):
   - `detect()`: check if `requirements.txt` OR `pyproject.toml` exists.
   - `parseManifest()`: parse `requirements.txt` line-by-line (strip comments, version specifiers). If `pyproject.toml` exists, parse `[tool.poetry.dependencies]` block. Cross-reference `poetry.lock` for resolved versions (parse `[[package]]` blocks).
4. Create `src/adapters/AdapterRegistry.ts` that returns the correct adapter for a workspace using `detect()` on each.

**Relevant Context:**
- Spec Section 4 — Ecosystem Adapters table.
- `package-lock.json` has a `packages` top-level key (v2/v3 format) with `"version"` per entry.
- `pubspec.lock` has a `packages:` YAML block with `version:` per package.
- `poetry.lock` has `[[package]]` TOML blocks with `name` and `version`.

---

### Sub-Task 4: Stage 2 — Cache Inspector (All Three Adapters)

**Status:** `[ ] pending`

**Intent:**
Implement `inspectPackage()` for all three adapters. This reads the actual installed package from disk, computes real byte sizes, counts files, and extracts the list of exported public symbols. This data feeds directly into the $\Phi(P)$ footprint formula.

**Expected Outcomes:**
- For each declared dependency, we have: `diskSizeKb`, `fileCount`, `transitiveCount`, and `exportedSymbols[]`.
- Exported symbol extraction is best-effort: for npm, read the package's `index.d.ts` or `package.json#exports`; for pub, list `.dart` file top-level declarations; for pip, list `__all__` or top-level `def`/`class` names.
- Transitive count is read from the lockfile's dependency graph (not re-crawled from disk).

**Todo List:**
1. Implement a shared `computeDirSize(dirPath: string): Promise<{sizeKb: number, fileCount: number}>` utility that recursively walks a directory using Node.js `fs.readdir` with `recursive: true`.
2. **NpmAdapter.inspectPackage()**:
   - Package path: `<workspaceRoot>/node_modules/<packageName>`.
   - Run `computeDirSize` on that path.
   - Parse `node_modules/<packageName>/package.json` for `"exports"` or `"main"` to locate entry point.
   - Parse `index.d.ts` (if present) with a regex scan to extract `export function`, `export const`, `export class`, `export interface` names. This gives `exportedSymbols`.
   - Transitive count: count the number of entries in `node_modules/<packageName>/node_modules/` (nested deps) plus count in lockfile's `dependencies` field for that package.
3. **PubAdapter.inspectPackage()**:
   - Package path: `~/.pub-cache/hosted/pub.dev/<packageName>-<version>/lib/`.
   - Run `computeDirSize`.
   - Scan `.dart` files for top-level `class`, `mixin`, `extension`, `typedef`, `void/String/int/bool/dynamic <functionName>(` declarations not prefixed with `_`.
4. **PipAdapter.inspectPackage()**:
   - Package path: `.venv/lib/python3.x/site-packages/<packageName>` OR the system site-packages (use `VIRTUAL_ENV` env var if set, fall back to sys.prefix logic via a subprocess call: `python -c "import site; print(site.getsitepackages()[0])"`).
   - Run `computeDirSize`.
   - Parse `__init__.py`: extract `__all__` list if present; otherwise scan for top-level `def` and `class` names not prefixed with `_`.
5. Handle the "package not installed" case gracefully (return a zero-footprint stub with a warning flag).

**Relevant Context:**
- Spec Section 3, Stage 2: "Traverses physical paths on disk… Computes real byte sizes, file counts, and exported symbols index."
- The transitive count `T(P)` in the $\Phi(P)$ formula is a count, not recursive size — keep it simple.
- `fs.promises.readdir` with `{ recursive: true }` is available in Node 18+.

---

### Sub-Task 5: Stage 3 — AST Scanner with web-tree-sitter

**Status:** `[ ] pending`

**Intent:**
Implement the AST-based import and call-site scanner using `web-tree-sitter` WASM bindings. This is the core analytical stage that determines which symbols from which packages are actually used, and how many times. It feeds the $U(P)$ utilization metric.

**Expected Outcomes:**
- For every source file in the workspace, the scanner identifies: which packages are imported, which specific symbols are imported from each package, and how many times each symbol is called/invoked in that file.
- All three languages (TypeScript/JS, Dart, Python) are handled by the same `ASTScanner` class using language-specific grammar WASMs.
- The output is a `Map<packageName, PackageUsage>` aggregated across the entire workspace.

**Todo List:**
1. Download and bundle the three Tree-sitter WASM grammar files into `resources/`:
   - `tree-sitter-typescript.wasm`
   - `tree-sitter-dart.wasm`
   - `tree-sitter-python.wasm`
   These are available as prebuilt artifacts from the `tree-sitter` language repos.
2. Create `src/stages/ASTScanner.ts`:
   - Initialize `web-tree-sitter` once (`Parser.init()`), then load each grammar WASM lazily on first use.
   - Expose `scanWorkspace(workspaceRoot, adapter): Promise<Map<string, PackageUsage>>`.
3. Implement TypeScript/JS query logic:
   - Use a Tree-sitter query to match `import_statement` nodes.
   - Extract the `source` string (e.g. `'lodash'`) and the named import bindings (e.g. `isEqual`, `clamp`).
   - For call-site counting: match `call_expression` nodes where the `function` is an `identifier` matching one of the imported symbol names. Count occurrences.
4. Implement Dart query logic:
   - Match `import_or_export` / `import_specification` nodes for `package:` URI imports.
   - Extract package name from `'package:quiver/strings.dart'` → `quiver`.
   - Match method invocations and top-level function calls for the imported identifiers.
5. Implement Python query logic:
   - Match `import_from_statement` nodes (`from uuid import uuid4`) and `import_statement` nodes.
   - Extract package name and aliases.
   - Count `call` nodes where the function name matches the imported symbol or its alias.
6. Aggregation: iterate all files matching the adapter's `getSourceGlobs()`, run the scanner per file, and merge results into the workspace-level `Map<packageName, PackageUsage>`.

**Relevant Context:**
- `web-tree-sitter` API: `Parser`, `Parser.Language`, `Language.query(queryString)`, `query.matches(tree.rootNode)`.
- Tree-sitter S-expression query syntax: `(import_statement source: (string) @import_source)`.
- Spec Section 3, Stage 3: "Tree-sitter / native AST parse of all workspace source files."
- Spec Section 4: AST Parser column — confirms Tree-sitter for all three.

---

### Sub-Task 6: Stage 4 — Tax Engine & Recipe Registry

**Status:** `[ ] pending`

**Intent:**
Implement the pure mathematical scoring engine and the Tier 1 recipe registry. The Tax Engine takes Stage 2 footprint data and Stage 3 usage data and produces the final `ScoredPackage[]`. The Recipe Registry marks which packages have an available native replacement.

**Expected Outcomes:**
- `TaxEngine.score()` correctly implements the $\Phi(P)$, $U(P)$, Tax Ratio, and DepTax Score formulas from spec Section 2.
- Status thresholds (Healthy < 25, Bloated 25–150, Parasitic > 150) are applied correctly.
- `RecipeRegistry` contains the 3 core recipes: `lodash.isEqual`, `uuid.v4`, `quiver.strings.isBlank`.
- `evictionAvailable` and `evictionStrategy` fields are populated on each `ScoredPackage`.

**Todo List:**
1. Implement `src/stages/TaxEngine.ts`:
   ```
   Φ(P) = diskSizeKb × (1 + 0.25 × transitiveCount)
   U(P) = Σ [ I(s) × ln(1 + C(s)) ]  for all used symbols s
   TaxRatio = Φ(P) / max(1, |usedSymbols|)
   DepTaxScore = Φ(P) / (U(P) + 0.1)
   ```
   - `λ_trans = 0.25` is a named constant, not a magic number.
   - Status thresholds are also named constants.
2. Implement `src/recipes/RecipeRegistry.ts` as a plain Map of `"packageName/symbolName" → EvictionRecipe`:
   - `lodash/isEqual`: the full TypeScript `isEqual` helper from spec Section 5.2, Step 2.
   - `uuid/v4`: replacement is `crypto.randomUUID()` — one-liner, output file is `uuid_v4.ts`.
   - `quiver/isBlank`: replacement is `(s: string | null): boolean => s == null || s.trim().isEmpty` — output as Dart file `is_blank.dart`.
3. In `TaxEngine.score()`, after computing the score, call `RecipeRegistry.lookup(packageName, usedSymbols)` to set `evictionAvailable` and `evictionStrategy`.
4. The `TaxEngine.score()` method signature:
   ```typescript
   score(
     footprint: PackageFootprint,
     usage: PackageUsage | undefined,
     dep: DeclaredDependency
   ): ScoredPackage
   ```

**Relevant Context:**
- Spec Section 2 — full formula definitions with the worked lodash example.
- Spec Section 5.1 — Tier 1 recipe table and the `isEqual` implementation code.
- Spec Section 2.4 — classification threshold table.

---

### Sub-Task 7: ScanOrchestrator & Report Cache

**Status:** `[ ] pending`

**Intent:**
Wire all four pipeline stages together into a single `ScanOrchestrator` that is triggered on file save. The orchestrator detects the ecosystem, runs stages 1–4 in sequence, and writes the result to `deptax_report.json`. The `ReportCache` manages reading/writing the cached report.

**Expected Outcomes:**
- `ScanOrchestrator.run(workspaceRoot)` returns a `DeptaxReport`.
- The report is written to `<workspaceRoot>/.deptax/deptax_report.json`.
- On file save of any source file OR manifest file, the orchestrator re-runs.
- The orchestrator handles multi-ecosystem workspaces (e.g. a monorepo with both a Node.js and Flutter project) by running all detected adapters.
- Errors in one stage are caught and reported without crashing the extension.

**Todo List:**
1. Implement `src/orchestrator/ScanOrchestrator.ts`:
   - `run(workspaceRoot: string): Promise<DeptaxReport>` method.
   - Call `AdapterRegistry.detect()` to find all active adapters.
   - For each adapter: run `parseManifest()` → `inspectPackage()` per dep → aggregate usage via `ASTScanner.scanWorkspace()` → score all packages via `TaxEngine.score()`.
   - Merge results into a single `DeptaxReport`.
2. Implement `src/cache/ReportCache.ts`:
   - `write(report: DeptaxReport, workspaceRoot: string): Promise<void>` — writes to `.deptax/deptax_report.json`.
   - `read(workspaceRoot: string): Promise<DeptaxReport | null>` — reads cached report if it exists.
   - Ensure `.deptax/` directory is created if absent.
3. In `src/extension.ts`, register the `vscode.workspace.onDidSaveTextDocument` listener:
   - On save of **any source file OR manifest file** (`package.json`, `pubspec.yaml`, `requirements.txt`, `pyproject.toml`, `pubspec.lock`, `poetry.lock`), call `ScanOrchestrator.run()`.
   - After completion, update all UI providers with the new report.
   - Show a progress notification during the scan using `vscode.window.withProgress`.
4. Register the `deptax.scan` command to trigger a manual re-scan.
5. Run the initial scan on extension activation (so the UI is populated immediately when VS Code opens).

**Relevant Context:**
- VSCode `workspace.onDidSaveTextDocument` fires for every saved file — filter by checking if the saved file's basename matches known manifest filenames or if it has a source extension for the detected ecosystem.
- `vscode.window.withProgress` with `ProgressLocation.Window` for non-intrusive background progress.
- The `.deptax/` directory should also be added to `.gitignore`.

---

### Sub-Task 8: UI — Diagnostics Provider

**Status:** `[ ] pending`

**Intent:**
Surface DepTax findings as inline diagnostics (squiggles) directly on the import lines in source files. This is the most immediately visible feature — developers see the score without opening any panel.

**Expected Outcomes:**
- Import lines for parasitic packages show a red squiggle with the message: `🔴 lodash — DepTax Score: 3,505 (Parasitic). Using 1 of 312 exported symbols.`
- Import lines for bloated packages show a yellow/warning squiggle.
- Healthy packages have no diagnostic.
- Diagnostics update within seconds of a file save.
- Diagnostics appear in the Problems panel with source `DepTax`.

**Todo List:**
1. Create `src/ui/DiagnosticsProvider.ts`:
   - Create a `vscode.DiagnosticCollection` named `'deptax'`.
   - Implement `update(report: DeptaxReport, workspaceRoot: string): Promise<void>`.
   - For each `ScoredPackage` with status `parasitic` or `bloated`:
     - Scan all source files for import statements matching the package name.
     - Find the exact line number of the import using a simple regex (not full re-parse).
     - Create a `vscode.Diagnostic` with the correct severity and message.
   - Use `DiagnosticSeverity.Error` for parasitic, `DiagnosticSeverity.Warning` for bloated.
2. Diagnostic message format:
   - Parasitic: `DepTax 🔴 [packageName] Score: [score] — Using [n] of [total] exported APIs. Run "deptax.openReport" for details.`
   - Bloated: `DepTax 🟡 [packageName] Score: [score] — Underutilized ([n] of [total] APIs used).`
3. Register `DiagnosticsProvider` in `extension.ts` and call `update()` after every scan.
4. Dispose the `DiagnosticCollection` in the extension `deactivate()` hook.

**Relevant Context:**
- VSCode API: `vscode.languages.createDiagnosticCollection()`, `vscode.Diagnostic`, `vscode.DiagnosticSeverity`.
- Import line detection: a simple `/import\s+.*from\s+['"]<packageName>['"]/` regex on the file text is sufficient — no need for a full AST re-parse here.

---

### Sub-Task 9: UI — TreeView Panel

**Status:** `[ ] pending`

**Intent:**
Implement the Explorer sidebar TreeView that lists all audited packages ranked by DepTax score, with emoji status indicators and key metrics visible at a glance.

**Expected Outcomes:**
- A "DepTax" panel appears in the VSCode Explorer sidebar.
- Packages are listed from most parasitic to healthiest (sorted by `deptaxScore` descending).
- Each package item shows: emoji status + package name + score + disk size.
- Expanding a package item reveals its used symbols with call counts and file locations.
- Clicking a symbol item navigates to the source file at the correct line.
- The tree refreshes after every scan.

**Todo List:**
1. Register the `deptaxView` view in `package.json` `contributes.views` under a new `deptaxContainer` viewsContainer in the Activity Bar.
2. Implement `src/ui/DeptaxTreeView.ts` as a `vscode.TreeDataProvider<DeptaxTreeItem>`.
3. Define tree item levels:
   - **Level 1 (Package):** Label = `🔴 lodash — 3,505 (4.2 MB)`. `collapsibleState = Collapsed`.
   - **Level 2 (Symbol):** Label = `isEqual() — 2 calls`. `collapsibleState = None`. `command` = open file.
   - **Level 3 (File):** Label = `src/services/cart.ts:14`. `command` = `vscode.open` at that line.
4. Implement `refresh(report: DeptaxReport)` method that triggers `_onDidChangeTreeData`.
5. Register a `deptax.openReport` command that opens the WebView panel (Sub-Task 10).

**Relevant Context:**
- VSCode `TreeDataProvider` API: `getTreeItem()`, `getChildren()`, `onDidChangeTreeData`.
- Use `vscode.TreeItem` with `iconPath: new vscode.ThemeIcon('warning')` for icon support.

---

### Sub-Task 10: UI — WebView Report Panel

**Status:** `[ ] pending`

**Intent:**
Implement the full-screen WebView report panel that renders the complete DepTax audit table matching the layout described in spec Section 6.1. This is the richest UI surface — a styled HTML table with color-coded rows, summary stats, and a project-level overview.

**Expected Outcomes:**
- Running the `deptax.openReport` command opens a WebView panel titled "DepTax Report".
- The panel renders the full audit table: Package | Footprint | Exports | Used Here | DepTax Rating.
- Rows are color-coded: red background for parasitic, yellow for bloated, green for healthy.
- A summary header shows: project name, ecosystem, total packages, parasitic count, total potential savings in MB.
- The WebView content updates when a new scan completes (via `panel.webview.postMessage`).
- The WebView panel opens **only when explicitly invoked** via the `deptax.openReport` command or by clicking the status bar item — it does not auto-open.
- The HTML/CSS is self-contained (no external CDN calls) to work in offline environments.

**Todo List:**
1. Implement `src/ui/ReportWebViewPanel.ts`:
   - Static `createOrShow(context, report)` method — creates the panel if it doesn't exist, otherwise reveals it.
   - Store a reference to the current panel as a static property to avoid duplicates.
   - Implement `_getHtmlContent(report: DeptaxReport): string` that generates the full HTML.
2. HTML structure:
   - `<head>`: inline `<style>` with CSS variables for VSCode theme colors (`var(--vscode-editor-background)` etc.).
   - Summary card at top: project name, ecosystem badge, totals.
   - `<table>` with columns: Package | Footprint | Exports | Used | Score | Status.
   - Row classes: `row-parasitic`, `row-bloated`, `row-healthy` with appropriate background tints.
   - Expandable rows for used symbols (use `<details>/<summary>` HTML elements — no JS framework needed).
3. Handle WebView panel disposal: set the static reference to `undefined` when the panel is closed.
4. Implement `update(report: DeptaxReport)`: if the panel is visible, call `webview.postMessage({ type: 'update', report })` and handle it in the WebView JS to re-render the table without a full reload.
5. Add a "Refresh" button in the WebView that posts a message back to the extension to trigger a manual re-scan.

**Relevant Context:**
- VSCode WebView API: `vscode.window.createWebviewPanel()`, `webview.html`, `webview.postMessage()`, `webview.onDidReceiveMessage()`.
- Use `webview.cspSource` in the Content Security Policy header.
- VSCode CSS variables reference: `--vscode-editor-foreground`, `--vscode-editor-background`, `--vscode-list-errorForeground`, `--vscode-list-warningForeground`.

---

### Sub-Task 11: UI — Status Bar Item

**Status:** `[ ] pending`

**Intent:**
Add a compact status bar item that shows the count of parasitic dependencies at a glance, and clicking it opens the report panel. This gives persistent ambient awareness without requiring the user to open any panel.

**Expected Outcomes:**
- A status bar item in the right section shows: `$(bug) 2 Parasitic` (using VSCode's built-in `bug` codicon).
- When there are 0 parasitic packages, it shows `$(check) DepTax: Clean` in green.
- Clicking the status bar item runs `deptax.openReport`.
- The item updates after every scan.

**Todo List:**
1. Create `src/ui/StatusBarItem.ts` that wraps `vscode.window.createStatusBarItem`.
2. Implement `update(report: DeptaxReport)`:
   - If `parasiticPackagesCount > 0`: text = `$(bug) ${count} Parasitic`, color = `new vscode.ThemeColor('statusBarItem.warningBackground')`.
   - If `parasiticPackagesCount === 0`: text = `$(check) DepTax: Clean`, color = undefined (default).
3. Set `statusBarItem.command = 'deptax.openReport'`.
4. Register the item in `extension.ts` and dispose it in `deactivate()`.

**Relevant Context:**
- VSCode `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)`.
- Codicons reference: `$(bug)`, `$(check)`, `$(warning)`.

---

### Sub-Task 12: Integration, Testing & Validation

**Status:** `[ ] pending`

**Intent:**
Wire all sub-tasks together in `extension.ts`, write integration smoke tests against a fixture project, validate the extension compiles and runs cleanly, and verify the output matches the spec's example calculations.

**Expected Outcomes:**
- The extension activates without errors on a test TypeScript workspace.
- The lodash example from spec Section 2.4 produces a score of approximately 3,505.
- All three UI surfaces (diagnostics, TreeView, WebView) update correctly after a save.
- No TypeScript errors (`tsc --noEmit` passes).
- The bundled `dist/extension.js` size is reasonable (< 5 MB including WASM grammars).

**Todo List:**
1. Create `test/fixtures/ts-project/` with:
   - A minimal `package.json` declaring `lodash` and `uuid`.
   - A `package-lock.json` with their resolved versions.
   - A `src/services/cart.ts` that imports `{ isEqual } from 'lodash'` and calls it twice.
   - A populated `node_modules/lodash/` directory (or a mock with the correct directory structure and size) for the Cache Inspector to measure.
2. Write a smoke test in `src/test/extension.test.ts` that:
   - Calls `ScanOrchestrator.run()` against the fixture project root.
   - Asserts `lodash` has `deptaxScore > 3000` and `status === 'parasitic'`.
   - Asserts `evictionAvailable === true` and `evictionStrategy === 'recipe'`.
3. Run `tsc --noEmit` and fix any type errors.
4. Run the extension in the Extension Development Host and manually verify all four UI surfaces work end-to-end.
5. Verify `.deptax/deptax_report.json` is written after scan.
6. Verify the Problems panel shows DepTax diagnostics on the import line.

**Relevant Context:**
- VSCode extension testing: `@vscode/test-electron` for running tests in the Extension Development Host.
- The fixture project's `node_modules/lodash` can be a stub directory tree with empty files to simulate the correct `diskSizeKb` — the Cache Inspector just does `fs.stat` recursively, so file content doesn't matter.

---

## Dependency Map Between Sub-Tasks

```
ST-1 (Scaffold)
  └─► ST-2 (Types)
        ├─► ST-3 (Manifest Parsers)
        │     └─► ST-4 (Cache Inspector)
        │           └─► ST-7 (Orchestrator)  ◄─── ST-5 (AST Scanner)
        │                                     ◄─── ST-6 (Tax Engine)
        │                                              │
        └─► ST-5 (AST Scanner)               ST-8 (Diagnostics)  ─┐
        └─► ST-6 (Tax Engine)                ST-9 (TreeView)      ─┤─► ST-12 (Integration)
                                             ST-10 (WebView)      ─┤
                                             ST-11 (StatusBar)    ─┘
```

Sub-tasks ST-3, ST-5, ST-6 can be developed in parallel once ST-2 is complete.
Sub-tasks ST-8, ST-9, ST-10, ST-11 can be developed in parallel once ST-7 is complete.

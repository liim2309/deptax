# Technical Specification: DepTax (Third-Party Dependency Weight Auditor & Native Inliner)

> **Superseded:** the scoring model (Φ, U, DepTax Score) and the pipeline details in this document were replaced by model v2. See `DEPTAX_FULL_SPEC.md` §2–§4 and §15.

## Document Metadata
* **Status:** Final System Architecture & Implementation Blueprint
* **Target Ecosystems:** Node.js / TypeScript (npm, pnpm, yarn), Dart / Flutter (pub), Python (pip, poetry)
* **Core Metric:** $\text{Tax Ratio}$ & $\text{DepTax Score}$
* **Core Tenet:** 100% Deterministic static analysis, zero-dependency inlining, and automated package eviction.

---

## 1. System Vision & The Problem

Modern software development has normalized an unsustainable habit: **developers routinely pull in multi-megabyte external packages to solve trivial problems**.

### The Anatomy of Dependency Debt
* A developer imports a $4.2\text{ MB}$ package (`lodash`) to call a single function (`isEqual` or `clamp`).
* A Flutter developer imports an entire 40-widget package just to use a dotted border container.
* A Python developer installs a utility package containing 50 transitive sub-dependencies just to convert a snake_case string to camelCase.

### The Consequences
1. **Bundle & Binary Bloat:** Unnecessary bytes shipped to client devices or container images, degrading startup time and memory footprint.
2. **Supply Chain Attack Surface:** Every transitive dependency introduces third-party code running with full application privileges.
3. **Maintenance & Version Churn:** Outdated, abandoned packages block modern compiler upgrades, trigger endless dependabot noise, and introduce breaking build changes.

**DepTax** changes the equation. It acts as an automated forensic auditor and inliner:
1. It scans your dependency manifests and codebase AST to measure the **exact weight of what you imported versus how much of it you actually use**.
2. It flags **"Parasitic Dependencies"** where the tax ratio exceeds sane thresholds.
3. With a single command (`deptax evict <package>`), it extracts or synthesizes an in-repo, zero-dependency native implementation, rewrites all call-sites, and completely removes the bloated package from your project.

---

## 2. Mathematical Definition of the DepTax Metric

To quantify whether a package is healthy or parasitic, DepTax evaluates the mathematical ratio between **the footprint brought into the project** and **the real utility extracted**.

### 2.1 The Raw Footprint Metric ($\Phi(P)$)
The total physical weight of package $P$ on disk and across the dependency tree:

$$\Phi(P) = S_{\text{disk}}(P) \times \left( 1 + \lambda_{\text{trans}} \cdot T(P) \right)$$

Where:
* $S_{\text{disk}}(P)$: The installed disk footprint of package $P$ in Kilobytes ($\text{KB}$), read directly from `node_modules`, `.pub-cache`, or `site-packages`.
* $T(P)$: The count of **transitive dependencies** pulled in recursively by package $P$.
* $\lambda_{\text{trans}}$: Transitive penalty multiplier (Default: $0.25$). Transitive packages carry high risk because they are unmanaged by the parent project.

### 2.2 The Active Utilization Metric ($U(P)$)
The active API surface area consumed by the project:

$$U(P) = \sum_{s \in \text{ExportedSymbols}(P)} \mathbb{I}(s) \times \ln(1 + C(s))$$

Where:
* $\mathbb{I}(s) \in \{0, 1\}$: Binary indicator whether symbol/function/widget $s$ is imported anywhere in the project.
* $C(s)$: Total number of distinct call-sites or constructor invocations of symbol $s$ across the codebase.
* The logarithmic scaling prevents a single repeated utility call in a loop from falsely inflating the perceived utility of a library.

### 2.3 The DepTax Ratio & Score

$$\text{Tax Ratio}(P) = \frac{\Phi(P)}{\max(1, |\text{Symbols}_{\text{used}}(P)|)}$$

$$\text{DepTax Score}(P) = \frac{\Phi(P)}{U(P) + 0.1}$$

### 2.4 Classification Thresholds

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DEPTAX CLASSIFICATION                           │
├────────────────────┬────────────────────┬──────────────────────────────┤
│ Classification     │ DepTax Score Range │ Meaning & Action             │
├────────────────────┼────────────────────┼──────────────────────────────┤
│ 🟢 Healthy         │ Score < 25         │ Balanced utility. Keep pkg.  │
│ 🟡 Heavy / Bloated │ 25 <= Score <= 150 │ Underutilized. Watchlist.    │
│ 🔴 Parasitic       │ Score > 150        │ Massive baggage for trivial  │
│                    │                    │ utility. Immediate Eviction. │
└────────────────────┴────────────────────┴──────────────────────────────┘
```

#### Real-World Example Calculation:
* **Package:** `lodash` installed in a TypeScript project.
* **Disk Footprint ($S_{\text{disk}}$):** $4,200\text{ KB}$ across 640 files.
* **Transitive Dependencies ($T$):** $0$.
* **Footprint ($\Phi$):** $4,200\text{ KB}$.
* **Exported Symbols Available:** $\approx 300+$ functions.
* **Symbols Used in Code:** Exactly $1$ (`isEqual`), invoked at $2$ call-sites.
* **Utilization ($U$):** $1 \times \ln(1 + 2) \approx 1.098$.
* **DepTax Score:** $\frac{4,200}{1.098 + 0.1} \approx \mathbf{3,505}$ 🔴 **(Critical Parasite)**.

---

## 3. System Architecture & End-to-End Pipeline

DepTax operates completely locally as a deterministic static engine with five sequential execution stages:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Target Project Workspace                                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage 1: Manifest & Lockfile Parser                                    │
│ - Ingests package.json, pubspec.yaml, or requirements.txt              │
│ - Cross-references package-lock.json, pubspec.lock, or poetry.lock     │
│ - Maps declared dependencies and their declared versions               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage 2: Local Package Cache Inspector                                 │
│ - Traverses physical paths on disk (node_modules, .pub-cache, .venv)   │
│ - Computes real byte sizes, file counts, and exported symbols index    │
│ - Crawls transitive dependency trees deterministically                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage 3: AST Import & Call-Site Grapher                                │
│ - Tree-sitter / native AST parse of all workspace source files         │
│ - Identifies exact import statements matching package names            │
│ - Resolves all call-sites, argument signatures, and member accesses    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage 4: Tax Engine & Opportunity Ranking                              │
│ - Calculates Tax Ratio and DepTax Score per installed package          │
│ - Ranks dependencies from most parasitic to healthiest                 │
│ - Identifies inlining candidates with zero runtime risk                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage 5: Inlining & Eviction Engine (CLI `evict`)                      │
│ - Generates zero-dependency native helper in src/utils/native_helpers  │
│ - Rewrites call-site ASTs across the project                           │
│ - Removes package entry from manifest and triggers prune/clean         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Ecosystem Adapters

DepTax uses modular language adapters so that the same scoring engine evaluates JavaScript/TypeScript, Dart/Flutter, and Python projects.

| Operation | Node.js / TypeScript | Dart / Flutter | Python |
| :--- | :--- | :--- | :--- |
| **Manifest** | `package.json` | `pubspec.yaml` | `requirements.txt` / `pyproject.toml` |
| **Lockfile** | `package-lock.json` / `pnpm-lock.yaml` | `pubspec.lock` | `poetry.lock` / `Pipfile.lock` |
| **Local Cache** | `./node_modules/<pkg>` | `~/.pub-cache/hosted/pub.dev/<pkg>` | `.venv/lib/python3.x/site-packages/<pkg>` |
| **AST Parser** | `@babel/parser` or Tree-sitter TS | `analyzer` package or Tree-sitter Dart | `ast` standard library or Tree-sitter Python |
| **Prune Tool** | `npm uninstall <pkg>` | `flutter pub remove <pkg>` | `pip uninstall -y <pkg>` |

---

## 5. The Inlining & Eviction Mechanics

The eviction process is what transforms DepTax from a passive linter into an active developer tool.

### 5.1 Two-Tier Inlining Strategy

#### Tier 1: Deterministic Recipe Replacement (Zero-Risk Pattern Match)
For the most common high-tax utility libraries (`lodash`, `uuid`, `dayjs`, `chalk`, `quiver`), DepTax maintains a built-in dictionary of **Idiomatic Native Equivalents**.

| Target Call | Package Used | Native Replacement Synthesized by DepTax |
| :--- | :--- | :--- |
| `isEqual(a, b)` | `lodash` | Standard deep/shallow equality recursive helper ($< 15\text{ LOC}$) |
| `capitalize(str)` | `lodash` | `str.charAt(0).toUpperCase() + str.slice(1)` |
| `v4()` | `uuid` | `crypto.randomUUID()` (Native in Node 19+, Web APIs, modern runtimes) |
| `clamp(val, min, max)` | `lodash` | `Math.min(Math.max(val, min), max)` |
| `quiver.strings.isBlank` | `quiver` (Dart) | `str == null \|\| str.trim().isEmpty` |

#### Tier 2: AST Extraction & Self-Contained Inlining (Generic Fallback)
When a parasitic package does not have a built-in recipe:
1. DepTax locates the function declaration in the package's local source code.
2. It walks that function's AST to verify it has **zero external package dependencies** and is self-contained.
3. If self-contained, DepTax copies the pure function directly into the local repo's `src/utils/native_helpers/` directory, preserving license attribution comments (MIT/Apache 2.0).

---

### 5.2 Step-by-Step Eviction Walkthrough

Let's walk through what happens when a developer runs:
```bash
deptax evict lodash
```

#### Step 1: Pre-flight Verification
* DepTax verifies `lodash` is present in `package.json`.
* It scans the repo and confirms all call-sites are limited to `isEqual`.

#### Step 2: Synthesis of the Native Helper
DepTax generates `src/utils/native_helpers/is_equal.ts`:
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

#### Step 3: AST Call-Site Rewriting
In all project files importing `lodash`:
```typescript
// BEFORE: src/services/cart.ts
import { isEqual } from 'lodash';

export function hasCartChanged(oldCart: any[], newCart: any[]) {
  return !isEqual(oldCart, newCart);
}
```

DepTax modifies the AST import node:
```typescript
// AFTER: src/services/cart.ts
import { isEqual } from '../utils/native_helpers/is_equal';

export function hasCartChanged(oldCart: any[], newCart: any[]) {
  return !isEqual(oldCart, newCart);
}
```

#### Step 4: Manifest Pruning & Cleanup
* Removes `"lodash"` from `package.json`.
* Executes `npm prune` or `npm install` to remove the $4.2\text{ MB}$ payload from `node_modules`.
* Emits a completion summary with exact byte savings.

---

## 6. CLI Developer Experience & Command Specification

### 6.1 `deptax scan` (The Project Audit)

```
$ deptax scan

┌────────────────────────────────────────────────────────────────────────┐
│ DEPTAX AUDIT REPORT: my-ecommerce-app                                  │
│ Target: /Users/dev/projects/my-ecommerce-app                           │
├─────────────────┬──────────┬──────────┬───────────┬────────────────────┤
│ Package         │ Footprint│ Exports  │ Used Here │ DepTax Rating      │
├─────────────────┼──────────┼──────────┼───────────┼────────────────────┤
│ lodash          │ 4.2 MB   │ 312      │ 1 func    │ 🔴 3,505 (Parasite)│
│ uuid            │ 180 KB   │ 8        │ 1 func    │ 🔴 164.0 (Parasite)│
│ moment          │ 2.8 MB   │ 120      │ 2 funcs   │ 🟡 94.2  (Bloat)   │
│ axios           │ 340 KB   │ 42       │ 38 calls  │ 🟢 8.1   (Healthy) │
│ react           │ 140 KB   │ 34       │ 29 calls  │ 🟢 4.1   (Healthy) │
└─────────────────┴──────────┴──────────┴───────────┴────────────────────┘

🚨 FOUND 2 PARASITIC DEPENDENCIES:
1. lodash (Score: 3,505) ── Used only for: isEqual() in 1 file
   Potential Saving: -4.2 MB on disk (-72 KB minified bundle)
2. uuid (Score: 164)     ── Used only for: v4() in 2 files
   Potential Saving: Native crypto.randomUUID() available

Run 'deptax evict <package>' to automatically replace with clean native code.
```

### 6.2 `deptax inspect <package>` (Deep Forensics)

```
$ deptax inspect lodash

┌────────────────────────────────────────────────────────────────────────┐
│ DEPTAX FORENSIC BREAKDOWN: lodash                                      │
├────────────────────────────────────────────────────────────────────────┤
│ Total Disk Size:       4,218 KB (640 files)                            │
│ Total Exported APIs:   312 functions                                   │
│ Transitive Packages:   0 packages                                      │
│ Active In-Repo Calls:  1 unique function called across 1 file          │
│ DepTax Score:          3,505.2 (Rank: Critical Parasite)               │
├────────────────────────────────────────────────────────────────────────┤
│ IN-REPO CALL-SITE MAP:                                                 │
│ • isEqual()                                                            │
│   └── src/services/cart.ts: Line 14                                    │
├────────────────────────────────────────────────────────────────────────┤
│ EVICTION RECIPE: AVAILABLE                                             │
│ Target Replacement: src/utils/native_helpers/is_equal.ts               │
│ Recipe Complexity:  18 lines of pure TypeScript                        │
│ External Callers:   0 dependencies                                     │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.3 `deptax evict <package>` (Automated Inlining & Removal)

```
$ deptax evict lodash

[1/4] Analyzing call-sites for lodash...
      Found 1 active symbol: isEqual() in src/services/cart.ts
[2/4] Synthesizing zero-dependency native helper...
      ✔ Created src/utils/native_helpers/is_equal.ts
[3/4] Rewriting project AST imports...
      ✔ Updated src/services/cart.ts
[4/4] Pruning dependency from package.json...
      ✔ Removed "lodash": "^4.17.21"
      ✔ Ran npm prune (Removed 640 files, -4.2 MB)

SUCCESS: lodash evicted with zero regressions.
Project footprint reduced by 4.2 MB.
```

---

## 7. JSON Output Contract (`deptax_report.json`)

When integrated into CI pipelines or IDE extensions, DepTax emits a deterministic JSON report:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "DepTaxReport",
  "type": "object",
  "properties": {
    "project_name": { "type": "string" },
    "ecosystem": { "type": "string", "enum": ["npm", "pub", "pip"] },
    "scanned_files": { "type": "integer" },
    "total_packages_audited": { "type": "integer" },
    "parasitic_packages_count": { "type": "integer" },
    "packages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "package_name": { "type": "string" },
          "installed_version": { "type": "string" },
          "disk_size_kb": { "type": "number" },
          "transitive_count": { "type": "integer" },
          "deptax_score": { "type": "number" },
          "status": { "type": "string", "enum": ["healthy", "bloated", "parasitic"] },
          "used_symbols": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "symbol_name": { "type": "string" },
                "call_count": { "type": "integer" },
                "files": { "type": "array", "items": { "type": "string" } }
              },
              "required": ["symbol_name", "call_count", "files"]
            }
          },
          "eviction_available": { "type": "boolean" },
          "eviction_strategy": { "type": "string", "enum": ["recipe", "ast_extract", "manual"] }
        },
        "required": [
          "package_name",
          "installed_version",
          "disk_size_kb",
          "deptax_score",
          "status",
          "used_symbols",
          "eviction_available"
        ]
      }
    }
  },
  "required": [
    "project_name",
    "ecosystem",
    "scanned_files",
    "total_packages_audited",
    "parasitic_packages_count",
    "packages"
  ]
}
```

---

## 8. Hackathon Execution Plan (The 12-Hour Build Roadmap)

Because DepTax works on single files, manifests, and local folders, **there are no network flaky calls or whole-compiler traps**. It can be built and polished in 12 hours:

```
┌────────────────────────────────────────────────────────────────────────┐
│ TIME SPAN  │ FOCUS AREA                │ DELIVERABLES                  │
├────────────┼───────────────────────────┼───────────────────────────────┤
│ Hours 0–3  │ Manifest & AST Scanner    │ • Parse package.json          │
│            │                           │ • Tree-sitter import scanner  │
│            │                           │ • Count symbol invocations    │
├────────────┼───────────────────────────┼───────────────────────────────┤
│ Hours 3–6  │ Cache Inspector & Math    │ • Walk node_modules folder    │
│            │                           │ • Compute disk sizes & KB     │
│            │                           │ • Implement DepTax formula    │
├────────────┼───────────────────────────┼───────────────────────────────┤
│ Hours 6–9  │ Inlining & Eviction Engine│ • Build 3 curated recipes:    │
│            │                           │   (lodash.isEqual, uuid.v4,   │
│            │                           │    quiver.strings)            │
│            │                           │ • AST import rewriter         │
│            │                           │ • Auto package.json stripper  │
├────────────┼───────────────────────────┼───────────────────────────────┤
│ Hours 9–11 │ CLI Presentation & Polish │ • Rich terminal tables        │
│            │                           │ • Colored progress indicators │
│            │                           │ • 'deptax evict' demo testbed │
├────────────┼───────────────────────────┼───────────────────────────────┤
│ Hours 11–12│ 2-Minute Demo Recording   │ • Record closed-loop script   │
└────────────┴───────────────────────────┴───────────────────────────────┘
```

---

## 9. The Winning 2-Minute Hackathon Demo Script

* **0:00 – 0:25 (The Pain):**
  Open a sample TypeScript or Flutter application. Show the `package.json` with 20 dependencies and a $120\text{ MB}$ `node_modules` folder. Point out that the team only uses one function from `lodash` and one from `uuid`.
* **0:25 – 0:50 (The Audit):**
  Run `deptax scan`. Show the terminal table pop up instantly in 200 milliseconds. Point to the glowing red line: `🔴 lodash (Tax Ratio: 3,505 - Critical Parasite)`.
* **0:50 – 1:20 (The Eviction Action):**
  Type `deptax evict lodash`. Show the tool creating `src/utils/native_helpers/is_equal.ts`, rewriting the call-site in `cart.ts`, and removing the package from `package.json`.
* **1:20 – 1:45 (The Verification):**
  Run `npm test` or `npm run build` live on screen. The build succeeds with 0 errors. Show `node_modules` size drop immediately.
* **1:45 – 2:00 (The Closing Pitch):**
  *"DepTax turns dependency bloat from an invisible liability into a 1-click optimization. Pure, deterministic, zero-dependency engineering."*
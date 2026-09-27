import * as path from 'path';
import { ROOT_NODE, type EcosystemModel, type ResolvedImport } from '../adapters/EcosystemAdapter';
import { classify, utilization } from '../model/Classifier';
import { computeDominators, dominatedSet, reachableSet, type DominatorTree } from '../model/Dominators';
import { LivenessAnalysis, reachableModules, type ModuleProvider } from '../model/Liveness';
import type { ModuleInfo, NameSet } from '../model/ModuleModel';
import { lookup as recipeLookup } from '../recipes/RecipeRegistry';
import type { DeclaredDependency, ImportSite, ScoredPackage, UsedSymbol } from '../types/index';

/** Files at least this large that are loaded whole with low export coverage get a note. */
const MONOLITH_NOTE_BYTES = 64 * 1024;
/** Indivisible modules at least this large are measured through standalone per-function modules. */
const STANDALONE_MIN_BYTES = 16 * 1024;

export interface EcosystemEvaluation {
  packages: ScoredPackage[];
  installedDiskBytes: number;
  sharedDiskBytes: number;
  warnings: string[];
}

interface Usage {
  imports: ResolvedImport[];
  runtimeImports: number;
  typeOnlyImports: number;
}

/**
 * Stage 4 — evaluate every declared dependency of one ecosystem.
 *
 *  1. Dominator tree of the package graph → what removing each dependency frees.
 *  2. R: modules reachable from the public entry points of each dependency's
 *     exclusive subtree (the code it brings in).
 *  3. K: liveness analysis seeded by the project's imports (the code used).
 *  4. Classification from u = K/R and the dead bytes R − K.
 */
export async function evaluateEcosystem(model: EcosystemModel, workspaceRoot: string): Promise<EcosystemEvaluation> {
  const warnings = [...model.warnings];
  const dom = computeDominators({ root: ROOT_NODE, successors: model.edges });
  const top = directDominators(dom);
  const rel = (f: string) => path.relative(workspaceRoot, f).split(path.sep).join('/');

  // Merge duplicate declarations (a package listed as both runtime and dev dependency is runtime).
  const declared = new Map<string, DeclaredDependency>();
  for (const d of model.declared) {
    const prev = declared.get(d.name);
    declared.set(d.name, prev ? { ...prev, isDev: prev.isDev && d.isDev } : d);
  }

  // ── Group project imports by the direct dependency that owns them ────────
  const usage = new Map<string, Usage>();
  const notes = new Map<string, string[]>();
  const addNote = (dep: string, note: string) => {
    const list = notes.get(dep) ?? [];
    if (!list.includes(note)) { list.push(note); }
    notes.set(dep, list);
  };
  const nodeToDep = new Map<string, string>();
  for (const [name, id] of model.declaredNodes) { nodeToDep.set(id, name); }

  for (const imp of model.imports) {
    let depName: string | null = null;
    if (imp.packageId && top.has(imp.packageId)) {
      const owner = top.get(imp.packageId)!;
      depName = nodeToDep.get(owner) ?? null;
      const importedNode = model.nodes.get(imp.packageId);
      if (depName && owner !== imp.packageId && importedNode && !model.declaredNodes.has(importedNode.name)) {
        addNote(depName, `Your code imports "${importedNode.name}", which is not declared and is installed only because of this package.`);
      }
      if (!depName) {
        warnings.push(`"${model.nodes.get(imp.packageId)?.name}" is imported by ${rel(imp.file)} but is not a declared dependency.`);
        continue;
      }
    } else if (imp.packageName && declared.has(imp.packageName)) {
      depName = imp.packageName;
    }
    if (!depName) { continue; }
    const u = usage.get(depName) ?? { imports: [], runtimeImports: 0, typeOnlyImports: 0 };
    u.imports.push(imp);
    if (imp.runtime) { u.runtimeImports++; } else { u.typeOnlyImports++; }
    usage.set(depName, u);
  }

  // ── Which dependencies get R / K measurements ────────────────────────────
  const domSets = new Map<string, Set<string>>();
  const scored: string[] = [];
  for (const dep of declared.values()) {
    const id = model.declaredNodes.get(dep.name);
    if (!id || !dom.idom.has(id)) { continue; }
    domSets.set(dep.name, dominatedSet(dom, id));
    const node = model.nodes.get(id)!;
    if (!dep.isDev && !node.isTypes && !node.isSdk && (usage.get(dep.name)?.runtimeImports ?? 0) > 0) {
      scored.push(dep.name);
    }
  }

  const scopeNodes = new Set<string>();
  for (const name of scored) { for (const n of domSets.get(name)!) { scopeNodes.add(n); } }
  const provider: ModuleProvider = {
    analyze: (f) => model.analyzeModule(f),
    sideEffectFree: (f) => model.sideEffectFree(f),
    inScope: (f) => { const o = model.ownerOf(f); return !!o && scopeNodes.has(o); },
  };

  const seeds: Array<[string, NameSet]> = [];
  const entries: string[] = [];
  const opaque = new Map<string, string>();
  for (const name of scored) {
    for (const imp of usage.get(name)!.imports) {
      if (!imp.runtime) { continue; }
      if (imp.targets.length === 0 && imp.packageId) {
        opaque.set(imp.packageId, `the import "${imp.specifier}" could not be resolved to a file, so all of its code is counted as used`);
      }
      for (const t of imp.targets) {
        entries.push(t);
        const standalone = model.ecosystem === 'npm' ? await standaloneModules(model, t, imp) : null;
        if (standalone) {
          for (const f of standalone.files) { seeds.push([f, 'ALL']); entries.push(f); }
          addNote(name, standalone.note);
        } else {
          seeds.push([t, imp.targetNames?.get(t) ?? imp.names]);
        }
      }
    }
  }

  // R: loadable code of the exclusive subtrees.
  for (const n of scopeNodes) { entries.push(...model.nodes.get(n)!.entryFiles); }
  const view = await reachableModules(provider, entries);

  // K: what the project's imports need.
  const liveness = new LivenessAnalysis(provider);
  for (const [f, names] of seeds) { liveness.request(f, names); }
  await liveness.run();

  const rBytes = new Map<string, number>();
  const kBytes = new Map<string, number>();
  const wholeFiles = new Map<string, Array<{ file: string; bytes: number }>>();
  for (const f of view) {
    const owner = model.ownerOf(f)!;
    rBytes.set(owner, (rBytes.get(owner) ?? 0) + model.moduleBytes(f));
  }
  const computedLoads = new Map<string, string[]>();
  for (const f of liveness.includedFiles()) {
    const owner = model.ownerOf(f);
    if (!owner) { continue; }
    const bytes = model.moduleBytes(f);
    const fraction = liveness.liveFraction(f);
    kBytes.set(owner, (kBytes.get(owner) ?? 0) + bytes * fraction);
    const info = await model.analyzeModule(f);
    if (info?.dynamicLoads) { computedLoads.set(owner, [...(computedLoads.get(owner) ?? []), shortPath(f)]); }
    if (info && isIndivisible(info) && bytes >= MONOLITH_NOTE_BYTES) {
      const list = wholeFiles.get(owner) ?? [];
      list.push({ file: f, bytes });
      wholeFiles.set(owner, list);
    }
  }

  // A package whose import could not be resolved counts as fully used, together
  // with everything it can reach: K cannot be measured, so assume the worst case.
  const forced = new Set<string>();
  const stack = [...opaque.keys()];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (forced.has(id) || !scopeNodes.has(id)) { continue; }
    forced.add(id);
    for (const s of model.edges.get(id) ?? []) { stack.push(s); }
  }
  for (const id of forced) {
    const all = [...(model.nodes.get(id)?.codeFiles.values() ?? [])].reduce((a, b) => a + b, 0);
    const r = Math.max(all, rBytes.get(id) ?? 0);
    rBytes.set(id, r);
    kBytes.set(id, r);
  }

  // ── Assemble results ─────────────────────────────────────────────────────
  const packages: ScoredPackage[] = [];
  let retainedTotal = 0;
  const installed = [...dom.reachable].filter((n) => n !== ROOT_NODE)
    .reduce((sum, n) => sum + (model.nodes.get(n)?.diskBytes ?? 0), 0);

  for (const dep of declared.values()) {
    const id = model.declaredNodes.get(dep.name);
    const node = id ? model.nodes.get(id) : undefined;
    const u = usage.get(dep.name) ?? { imports: [], runtimeImports: 0, typeOnlyImports: 0 };
    const depNotes = [...(notes.get(dep.name) ?? [])];
    const symbols = aggregateSymbols(u.imports, rel);
    const importSites: ImportSite[] = u.imports.map((i) => ({ file: rel(i.file), line: i.line, endLine: i.endLine }));

    const domSet = domSets.get(dep.name);
    const retainedDisk = domSet ? [...domSet].reduce((s, n) => s + (model.nodes.get(n)?.diskBytes ?? 0), 0) : 0;
    retainedTotal += retainedDisk;
    const exclusive = domSet && id
      ? [...domSet].filter((n) => n !== id).map((n) => model.nodes.get(n)?.name ?? n).sort()
      : [];
    const sharedCount = id && domSet
      ? [...reachableSet({ root: ROOT_NODE, successors: model.edges }, id)].filter((n) => !domSet.has(n)).length
      : 0;

    const isScored = scored.includes(dep.name);
    let R: number | null = null;
    let K: number | null = null;
    if (isScored && domSet) {
      R = 0;
      K = 0;
      for (const n of domSet) {
        R += rBytes.get(n) ?? 0;
        K += kBytes.get(n) ?? 0;
        if (opaque.has(n)) { depNotes.push(`${model.nodes.get(n)?.name}: ${opaque.get(n)}.`); }
        const computed = computedLoads.get(n);
        if (computed) {
          const list = computed.slice(0, 3).join(', ') + (computed.length > 3 ? ' and others' : '');
          depNotes.push(`${list} ${computed.length === 1 ? 'loads' : 'load'} modules whose names are only `
            + 'known at runtime; those modules are not counted as used.');
        }
      }
      K = Math.min(Math.round(K), Math.round(R));
      R = Math.round(R);
    }

    const measured = !!node && !node.isSdk;
    const unmeasuredReason = !node
      ? (model.missingReasons.get(dep.name) ?? 'not installed')
      : node.isSdk ? 'provided by the SDK' : undefined;
    const classification = classify({
      measured,
      unmeasuredReason,
      isDev: dep.isDev,
      isTypesPackage: node?.isTypes ?? false,
      hasCli: node?.hasCli ?? false,
      runtimeImports: u.runtimeImports,
      typeOnlyImports: u.typeOnlyImports,
      codeBytes: R ?? 0,
      usedCodeBytes: K ?? 0,
    });
    if (classification.status === 'unused') {
      depNotes.push('No import was found. It may still be used through configuration, assets or generated code.');
    }

    const coverage = isScored ? await exportCoverage(u.imports, liveness) : null;
    // A large module loaded whole while only a few of the package's exports are used: the
    // measurement cannot see inside the file, so say so rather than guess.
    const narrowUse = !!coverage && coverage.total >= 10 && coverage.used / coverage.total <= 0.1;
    if (model.ecosystem === 'npm' && isScored && domSet && narrowUse) {
      for (const n of domSet) {
        for (const w of wholeFiles.get(n) ?? []) {
          depNotes.push(`${shortPath(w.file)} (${formatKb(w.bytes)}) cannot be split below file level, so all of it `
            + `counts as used, although you use ${coverage!.used} of ${coverage!.total} exports.`);
        }
      }
    }

    const runtimeSymbols = symbols.filter((s) => s.references > 0);
    const wholeModule = u.imports.some((i) => i.runtime && i.names === 'ALL');
    const eviction = u.runtimeImports > 0
      ? recipeLookup(dep.name, runtimeSymbols, wholeModule)
      : { available: false, strategy: null, covered: [], uncovered: [] };

    packages.push({
      packageName: dep.name,
      ecosystem: model.ecosystem,
      installedVersion: node?.version ?? null,
      declaredVersion: dep.declaredVersion,
      isDev: dep.isDev,
      status: classification.status,
      statusReason: classification.reason,
      metrics: {
        diskBytes: node?.diskBytes ?? 0,
        retainedDiskBytes: retainedDisk,
        exclusiveDependencies: exclusive,
        sharedDependencyCount: sharedCount,
        codeBytes: R,
        usedCodeBytes: K,
        utilization: R !== null && K !== null ? utilization(R, K) : null,
        exportCoverage: coverage,
      },
      usedSymbols: symbols,
      importSites,
      eviction,
      notes: depNotes,
    });
  }

  return {
    packages,
    installedDiskBytes: installed,
    sharedDiskBytes: Math.max(0, installed - retainedTotal),
    warnings,
  };
}

/** For every node, the direct dependency (child of the root in the dominator tree) above it. */
function directDominators(dom: DominatorTree): Map<string, string> {
  const top = new Map<string, string>();
  for (const n of dom.reachable) {
    if (n === ROOT_NODE) { continue; }
    const chain: string[] = [];
    let x = n;
    while (!top.has(x) && dom.idom.get(x) !== ROOT_NODE) {
      chain.push(x);
      x = dom.idom.get(x)!;
    }
    const t = top.get(x) ?? x;
    top.set(x, t);
    for (const c of chain) { top.set(c, t); }
  }
  return top;
}

function aggregateSymbols(imports: ResolvedImport[], rel: (f: string) => string): UsedSymbol[] {
  const byKey = new Map<string, UsedSymbol>();
  for (const imp of imports) {
    for (const [name, use] of imp.symbols) {
      const key = `${imp.specifier}\u0000${name}`;
      let s = byKey.get(key);
      if (!s) {
        s = { name, module: imp.specifier, references: 0, typeReferences: 0, callArities: [], files: [] };
        byKey.set(key, s);
      }
      s.references += use.references;
      s.typeReferences += use.typeReferences;
      s.callArities.push(...use.callArities);
      const f = rel(imp.file);
      if (!s.files.includes(f)) { s.files.push(f); }
    }
  }
  return [...byKey.values()].sort((a, b) => b.references - a.references || a.name.localeCompare(b.name));
}

/** Used export names versus the export tables of the modules the project imports. */
async function exportCoverage(
  imports: ResolvedImport[],
  liveness: LivenessAnalysis,
): Promise<{ used: number; total: number } | null> {
  const total = new Set<string>();
  const used = new Set<string>();
  for (const imp of imports) {
    if (!imp.runtime) { continue; }
    if (imp.targetNames) { return null; }
    for (const t of imp.targets) {
      const table = await liveness.exportTable(t, new Set());
      if (table === 'OPEN') { return null; }
      for (const n of table) { total.add(`${imp.specifier}\u0000${n}`); }
    }
    if (imp.names === 'ALL') { return null; }
    for (const n of imp.names) {
      if (n !== 'default') { used.add(`${imp.specifier}\u0000${n}`); }
    }
  }
  // A default export is often the whole API object; coverage says nothing then.
  if (total.size === 0 || used.size === 0) { return null; }
  return { used: [...used].filter((u) => total.has(u)).length, total: total.size };
}

/**
 * A module the analysis cannot split: indivisible by language semantics, or
 * dominated by code that runs on load (a UMD/IIFE bundle).
 */
function isIndivisible(info: ModuleInfo): boolean {
  if (info.granularity === 'whole') { return true; }
  const rootSize = info.items.reduce((sum, item) => sum + (item.root ? item.size : 0), 0);
  return rootSize >= 0.5 * info.size;
}

/**
 * Standalone modules for the names imported from an indivisible module.
 *
 * Some packages ship one monolithic entry (lodash's UMD `lodash.js`) next to
 * a module per function (`lodash/isEqual.js`). No static analysis can split
 * the monolith, but the standalone module is the package's own statement of
 * the code a function needs, so K is measured through it. Applied only when
 * every imported name has such a module.
 */
async function standaloneModules(
  model: EcosystemModel,
  target: string,
  imp: ResolvedImport,
): Promise<{ files: string[]; note: string } | null> {
  const info = await model.analyzeModule(target);
  const size = model.moduleBytes(target);
  if (!info || !isIndivisible(info) || size < STANDALONE_MIN_BYTES || imp.names === 'ALL') { return null; }

  let names = [...imp.names].filter((n) => n !== 'default');
  if (imp.names.has('default')) {
    // A default binding used only through member accesses (`_.isEqual`).
    if (imp.symbols.has('default') || imp.symbols.has('*')) { return null; }
    names = [...new Set([...names, ...imp.symbols.keys()])];
  }
  const owner = model.ownerOf(target);
  const dir = owner ? model.nodes.get(owner)?.dir : null;
  if (names.length === 0 || !owner || !dir) { return null; }

  const files: string[] = [];
  for (const n of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(n)) { return null; }
    const hit = [path.join(dir, `${n}.js`), path.join(dir, n, 'index.js'), path.join(path.dirname(target), `${n}.js`)]
      .find((c) => c !== target && model.nodes.get(owner)!.codeFiles.has(c));
    if (!hit) { return null; }
    files.push(hit);
  }
  const rel = (f: string) => path.relative(dir, f).split(path.sep).join('/');
  return {
    files,
    note: `${rel(target)} is a single ${formatKb(size)} module that cannot be split, so the code needed for `
      + `${names.join(', ')} is measured through the package's standalone module${files.length > 1 ? 's' : ''} `
      + `(${files.map(rel).join(', ')}).`,
  };
}

/** A package file path from the package name on (`lodash/lodash.js`, `yaml/constructor.py`). */
function shortPath(file: string): string {
  const parts = file.split(path.sep);
  const at = Math.max(parts.lastIndexOf('node_modules'), parts.lastIndexOf('site-packages'));
  if (at >= 0) { return parts.slice(at + 1).join('/'); }
  const lib = parts.lastIndexOf('lib');
  return lib > 0 ? parts.slice(lib - 1).join('/') : path.basename(file);
}

function formatKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

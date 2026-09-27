import * as fs from 'fs';
import * as path from 'path';
import type { DeclaredDependency } from '../types/index';
import type { ModuleInfo, NameSet } from '../model/ModuleModel';
import { analyzePyModule, analyzePyProjectFile, type PyResolver } from '../analysis/PyAnalyzer';
import { loadGrammars, parse } from '../stages/TreeSitterHelper';
import {
  ROOT_NODE,
  type EcosystemAdapter,
  type EcosystemModel,
  type PackageNode,
  type ResolvedImport,
} from './EcosystemAdapter';

/** PEP 503 normalised distribution name. */
export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** A PEP 508 requirement: `name[extra1,extra2] >=1.0 ; marker`. */
export interface Requirement {
  name: string;
  extras: string[];
  marker: string;
}

export function parseRequirement(text: string): Requirement | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?([^;]*)(?:;(.*))?$/.exec(text);
  if (!m) { return null; }
  return {
    name: m[1],
    extras: (m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    marker: (m[4] ?? '').trim(),
  };
}

const DEV_GROUPS = new Set(['dev', 'develop', 'development', 'test', 'tests', 'testing', 'lint', 'linting', 'docs', 'doc', 'typing', 'types', 'style', 'qa']);

interface Distribution {
  id: string;
  name: string;
  version: string | null;
  distInfo: string;
  requires: Requirement[];
  files: Map<string, number>;
  topLevel: string[];
  hasCli: boolean;
}

export class PipAdapter implements EcosystemAdapter {
  readonly ecosystem = 'pip' as const;
  readonly manifestFiles = ['pyproject.toml', 'setup.py', 'setup.cfg'];

  constructor(private readonly wasmDir: string) {}

  async detect(workspaceRoot: string): Promise<boolean> {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
      if (await fs.promises.access(path.join(workspaceRoot, f)).then(() => true, () => false)) { return true; }
    }
    return false;
  }

  isSourceFile(file: string): boolean {
    return file.endsWith('.py');
  }

  async load(workspaceRoot: string, sourceFiles: string[]): Promise<EcosystemModel> {
    await loadGrammars(this.wasmDir);
    const warnings: string[] = [];
    const declared = await readManifests(workspaceRoot);
    const nodes = new Map<string, PackageNode>();
    const edges = new Map<string, string[]>([[ROOT_NODE, []]]);
    const declaredNodes = new Map<string, string>();
    const missingReasons = new Map<string, string>();

    const sitePackages = await findSitePackages(workspaceRoot);
    const empty = (): EcosystemModel => ({
      ecosystem: 'pip', declared, declaredNodes, missingReasons, nodes, edges, projectFiles: sourceFiles,
      imports: [], ownerOf: () => null, moduleBytes: () => 0, analyzeModule: async () => null,
      sideEffectFree: () => false, warnings,
    });
    if (!sitePackages) {
      for (const d of declared) {
        missingReasons.set(d.name, 'no Python environment found (looked for .venv, venv, env, $VIRTUAL_ENV, $CONDA_PREFIX)');
      }
      warnings.push('No Python virtual environment was found, so Python dependencies could not be measured.');
      return empty();
    }

    // ── Stage 2: installed distributions ───────────────────────────────────
    const dists = await readDistributions(sitePackages);
    const fileOwner = new Map<string, string>();
    for (const dist of dists.values()) {
      const node: PackageNode = {
        id: dist.id,
        name: dist.name,
        version: dist.version,
        dir: dist.distInfo,
        diskBytes: [...dist.files.values()].reduce((a, b) => a + b, 0),
        codeFiles: new Map(),
        entryFiles: [],
        hasCli: dist.hasCli,
        isTypes: /^types-|-stubs$/.test(dist.id),
        isSdk: false,
      };
      for (const [f, size] of dist.files) {
        if (!isPyCodeFile(f) || !f.startsWith(sitePackages + path.sep)) { continue; }
        node.codeFiles.set(f, size);
        fileOwner.set(f, dist.id);
        // Every module is importable; test suites shipped inside packages are not part of the API.
        if (!/[\\/](tests?|testing)[\\/]/.test(path.relative(sitePackages, f))) { node.entryFiles.push(f); }
      }
      nodes.set(dist.id, node);
    }

    // Edges from Requires-Dist, honouring requested extras (a small fixed point).
    const extrasOf = new Map<string, Set<string>>();
    const queue: string[] = [];
    const requestExtras = (id: string, extras: string[]) => {
      const set = extrasOf.get(id) ?? new Set<string>();
      const before = set.size;
      for (const e of extras) { set.add(canonicalName(e)); }
      if (!extrasOf.has(id) || set.size > before) {
        extrasOf.set(id, set);
        queue.push(id);
      }
    };
    for (const d of declared) {
      const id = canonicalName(d.name);
      if (!dists.has(id)) {
        missingReasons.set(d.name, `not installed in ${path.relative(workspaceRoot, sitePackages) || sitePackages}`);
        continue;
      }
      declaredNodes.set(d.name, id);
      edges.get(ROOT_NODE)!.push(id);
      requestExtras(id, d.extras ?? []);
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const extras = extrasOf.get(id)!;
      const out = new Set(edges.get(id) ?? []);
      for (const req of dists.get(id)!.requires) {
        const extraMatch = /extra\s*==\s*["']([^"']+)["']/.exec(req.marker);
        if (extraMatch && !extras.has(canonicalName(extraMatch[1]))) { continue; }
        const target = canonicalName(req.name);
        if (!dists.has(target) || target === id) { continue; } // not installed: optional or excluded by a marker
        out.add(target);
        requestExtras(target, req.extras);
      }
      edges.set(id, [...out]);
    }

    // ── Module resolution ──────────────────────────────────────────────────
    const exists = (p: string) => fileOwner.has(p) || fs.existsSync(p);
    const extCache = new Map<string, string[]>();
    const listDir = (dir: string): string[] => {
      let entries = extCache.get(dir);
      if (!entries) {
        try { entries = fs.readdirSync(dir); } catch { entries = []; }
        extCache.set(dir, entries);
      }
      return entries;
    };
    /** The file implementing an absolute dotted module name (not its parent packages). */
    const moduleFile = (dotted: string): string | null => {
      const parts = dotted.split('.').filter(Boolean);
      if (parts.length === 0) { return null; }
      const base = path.join(sitePackages, ...parts);
      for (const candidate of [path.join(base, '__init__.py'), base + '.py']) {
        if (exists(candidate) && fileOwner.has(candidate)) { return candidate; }
      }
      const stem = path.basename(base) + '.';
      const ext = listDir(path.dirname(base)).find((e) => e.startsWith(stem) && /\.(so|pyd)$/.test(e));
      const extFile = ext ? path.join(path.dirname(base), ext) : null;
      return extFile && fileOwner.has(extFile) ? extFile : null;
    };
    const dottedOf = (file: string, level: number, module: string): string => {
      const pkgParts = path.relative(sitePackages, path.dirname(file)).split(path.sep).filter(Boolean);
      const base = pkgParts.slice(0, Math.max(0, pkgParts.length - (level - 1)));
      return [...base, ...(module ? module.split('.') : [])].join('.');
    };
    const resolver: PyResolver = {
      module: (fromFile, dotted, level) => moduleFile(level === 0 ? dotted : dottedOf(fromFile, level, dotted)),
      submodules: (initFile) => {
        const dir = path.dirname(initFile);
        const out: Array<[string, string]> = [];
        for (const e of listDir(dir)) {
          if (e === '__init__.py' || e.startsWith('.')) { continue; }
          const full = path.join(dir, e);
          const name = e.replace(/\.(py|[^.]*\.(so|pyd)|so|pyd)$/, '');
          if (/^[A-Za-z_]\w*$/.test(name) && fileOwner.has(full)) { out.push([name, full]); continue; }
          const init = path.join(full, '__init__.py');
          if (fileOwner.has(init)) { out.push([e, init]); }
        }
        return out;
      },
      packageFiles: (file) => {
        const owner = fileOwner.get(file);
        const dir = path.dirname(file) + path.sep;
        return owner ? [...nodes.get(owner)!.codeFiles.keys()].filter((f) => f.startsWith(dir)) : [];
      },
    };

    const moduleCache = new Map<string, ModuleInfo | null>();
    const analyzeModule = async (file: string): Promise<ModuleInfo | null> => {
      if (moduleCache.has(file)) { return moduleCache.get(file)!; }
      let info: ModuleInfo | null = null;
      if (file.endsWith('.py')) {
        try {
          const text = await fs.promises.readFile(file, 'utf8');
          const tree = parse('python', text);
          try {
            info = analyzePyModule(tree.rootNode, file, resolver);
          } finally {
            tree.delete();
          }
        } catch {
          info = null;
        }
      }
      moduleCache.set(file, info);
      return info;
    };

    // ── Stage 3: project imports ───────────────────────────────────────────
    const byTopLevel = new Map<string, string>();
    for (const dist of dists.values()) {
      for (const t of dist.topLevel) { if (!byTopLevel.has(t)) { byTopLevel.set(t, dist.id); } }
    }
    const declaredByCanonical = new Map(declared.map((d) => [canonicalName(d.name), d.name]));
    const imports: ResolvedImport[] = [];
    let parseFailures = 0;

    for (const file of sourceFiles) {
      let analysis;
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        const tree = parse('python', text);
        try { analysis = analyzePyProjectFile(tree.rootNode); } finally { tree.delete(); }
      } catch {
        parseFailures++;
        continue;
      }
      for (const imp of analysis.imports) {
        const top = imp.specifier.split('.')[0];
        if (!top || isLocalModule(workspaceRoot, file, top)) { continue; }
        // `from pkg import sub` where `sub` is a submodule is a use of that submodule.
        const targets: string[] = [];
        const targetNames = new Map<string, NameSet>();
        let baseNames: NameSet = imp.names;
        if (imp.names !== 'ALL') {
          const remaining = new Set(imp.names);
          for (const n of imp.names) {
            const sub = moduleFile(`${imp.specifier}.${n}`);
            if (!sub) { continue; }
            targets.push(sub);
            targetNames.set(sub, imp.memberNames?.get(n) ?? 'ALL');
            remaining.delete(n);
          }
          baseNames = remaining;
        }
        const base = moduleFile(imp.specifier);
        if (base && (targets.length === 0 || baseNames === 'ALL' || baseNames.size > 0)) {
          targets.unshift(base);
          targetNames.set(base, baseNames);
        }
        let packageId = targets.length > 0 ? fileOwner.get(targets[0]) ?? null : byTopLevel.get(top) ?? null;
        let packageName = packageId ? nodes.get(packageId)!.name : null;
        if (!packageName) {
          // Declared but not installed: match on the normalised name.
          packageName = declaredByCanonical.get(canonicalName(top)) ?? null;
          packageId = null;
        }
        if (!packageName) { continue; } // standard library or unknown module
        imports.push({ ...imp, file, packageName, packageId, targets, targetNames });
      }
    }
    if (parseFailures > 0) {
      warnings.push(`${parseFailures} Python file(s) could not be parsed and were skipped.`);
    }
    warnings.push(`Python environment: ${sitePackages}`);

    return {
      ecosystem: 'pip',
      declared,
      declaredNodes,
      missingReasons,
      nodes,
      edges,
      projectFiles: sourceFiles,
      imports,
      ownerOf: (f) => fileOwner.get(f) ?? null,
      moduleBytes: (f) => nodes.get(fileOwner.get(f) ?? '')?.codeFiles.get(f) ?? 0,
      analyzeModule,
      sideEffectFree: () => false,
      warnings,
    };
  }
}

function isPyCodeFile(f: string): boolean {
  return /\.(py|so|pyd)$/.test(f) && !f.includes(`${path.sep}__pycache__${path.sep}`) && !/\.dist-info[\\/]/.test(f);
}

/** Modules importable from the project itself shadow installed ones. */
function isLocalModule(root: string, file: string, top: string): boolean {
  for (const base of [root, path.join(root, 'src'), path.dirname(file)]) {
    if (fs.existsSync(path.join(base, `${top}.py`)) || fs.existsSync(path.join(base, top, '__init__.py'))) { return true; }
  }
  return false;
}

/** Project-local environments first, then the active one. */
export async function findSitePackages(root: string): Promise<string | null> {
  const prefixes = [
    path.join(root, '.venv'), path.join(root, 'venv'), path.join(root, 'env'),
    process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX,
  ].filter((p): p is string => !!p);
  for (const prefix of prefixes) {
    const winSite = path.join(prefix, 'Lib', 'site-packages');
    if (fs.existsSync(winSite)) { return fs.realpathSync(winSite); }
    let entries: string[] = [];
    try { entries = await fs.promises.readdir(path.join(prefix, 'lib')); } catch { continue; }
    for (const e of entries.filter((x) => /^python\d/.test(x)).sort().reverse()) {
      const site = path.join(prefix, 'lib', e, 'site-packages');
      if (fs.existsSync(site)) { return fs.realpathSync(site); }
    }
  }
  return null;
}

async function readDistributions(sitePackages: string): Promise<Map<string, Distribution>> {
  const dists = new Map<string, Distribution>();
  const entries = await fs.promises.readdir(sitePackages).catch(() => [] as string[]);
  await Promise.all(entries.filter((e) => e.endsWith('.dist-info')).map(async (e) => {
    const distInfo = path.join(sitePackages, e);
    const read = (f: string) => fs.promises.readFile(path.join(distInfo, f), 'utf8').catch(() => '');
    const [metadata, record, topLevel, entryPoints] = await Promise.all([
      read('METADATA'), read('RECORD'), read('top_level.txt'), read('entry_points.txt'),
    ]);
    const name = /^Name:\s*(.+)$/m.exec(metadata)?.[1].trim() ?? e.replace(/-[^-]+\.dist-info$/, '');
    const version = /^Version:\s*(.+)$/m.exec(metadata)?.[1].trim() ?? null;
    const requires = [...metadata.matchAll(/^Requires-Dist:\s*(.+)$/gm)]
      .map((m) => parseRequirement(m[1]))
      .filter((r): r is Requirement => r !== null);

    const files = new Map<string, number>();
    const unsized: string[] = [];
    for (const line of record.split('\n')) {
      if (!line.trim()) { continue; }
      const parts = splitCsvLine(line);
      const file = path.resolve(sitePackages, parts[0]);
      const size = Number(parts[2]);
      if (parts[2] && Number.isFinite(size)) { files.set(file, size); } else { unsized.push(file); }
    }
    await Promise.all(unsized.map(async (f) => {
      const s = await fs.promises.stat(f).catch(() => null);
      if (s?.isFile()) { files.set(f, s.size); }
    }));

    let tops = topLevel.split('\n').map((s) => s.trim()).filter(Boolean);
    if (tops.length === 0) {
      tops = [...new Set([...files.keys()]
        .map((f) => path.relative(sitePackages, f).split(path.sep))
        .filter((p) => p.length > 0 && !p[0].startsWith('..') && !p[0].endsWith('.dist-info') && p[0] !== '__pycache__')
        .map((p) => (p.length === 1 ? p[0].replace(/\.(py|so|pyd)$/, '').split('.')[0] : p[0]))
        .filter((t) => /^[A-Za-z_]\w*$/.test(t)))];
    }
    const id = canonicalName(name);
    dists.set(id, {
      id, name, version, distInfo, requires, files, topLevel: tops,
      hasCli: /^\[(console_scripts|gui_scripts)\]/m.test(entryPoints),
    });
  }));
  return dists;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else { quoted = !quoted; }
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── Manifests ─────────────────────────────────────────────────────────────

async function readManifests(root: string): Promise<DeclaredDependency[]> {
  const out: DeclaredDependency[] = [];
  const add = (req: Requirement | null, version: string, isDev: boolean) => {
    if (!req || canonicalName(req.name) === 'python') { return; }
    const key = canonicalName(req.name);
    const existing = out.find((d) => canonicalName(d.name) === key);
    if (existing) {
      existing.isDev = existing.isDev && isDev;
      existing.extras = [...new Set([...(existing.extras ?? []), ...req.extras])];
      return;
    }
    out.push({ name: req.name, declaredVersion: version, isDev, extras: req.extras });
  };

  const readRequirements = async (file: string, isDev: boolean, depth = 0): Promise<void> => {
    let text: string;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { return; }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      if (!line) { continue; }
      const include = /^(?:-r|--requirement)\s*=?\s*(\S+)/.exec(line);
      if (include && depth < 5) {
        await readRequirements(path.resolve(path.dirname(file), include[1]), isDev, depth + 1);
        continue;
      }
      if (line.startsWith('-')) {
        const egg = /#egg=([A-Za-z0-9._-]+)/.exec(raw);
        if (egg) { add(parseRequirement(egg[1]), '', isDev); }
        continue;
      }
      const req = parseRequirement(line);
      add(req, req ? line.slice(req.name.length).split(';')[0].trim() : '', isDev);
    }
  };
  await readRequirements(path.join(root, 'requirements.txt'), false);

  for (const file of ['pyproject.toml', 'Pipfile']) {
    let text: string;
    try { text = await fs.promises.readFile(path.join(root, file), 'utf8'); } catch { continue; }
    for (const entry of tomlDependencyEntries(text)) {
      add(parseRequirement(entry.spec), entry.version, entry.isDev);
    }
  }
  return out;
}

interface TomlDependency { spec: string; version: string; isDev: boolean }

/**
 * Dependency lists from pyproject.toml (PEP 621, PEP 735 dependency groups,
 * Poetry, PDM, uv) and Pipfile. A deliberately small TOML reader: tables,
 * `key = "…"`, `key = { … }` and multi-line string arrays.
 */
export function tomlDependencyEntries(text: string): TomlDependency[] {
  const out: TomlDependency[] = [];
  const lines = text.split('\n');
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('#')) { continue; }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) { table = header[1].replace(/\s+/g, ''); continue; }
    const kv = /^("?[A-Za-z0-9_.-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv) { continue; }
    const key = kv[1].replace(/"/g, '');
    let value = kv[2];

    // Collect a multi-line array.
    if (value.startsWith('[')) {
      let depth = bracketDepth(value);
      while (depth > 0 && i + 1 < lines.length) {
        value += '\n' + lines[++i];
        depth = bracketDepth(value);
      }
    }

    const arrayStrings = () => [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

    if (table === 'project' && key === 'dependencies') {
      for (const s of arrayStrings()) { out.push({ spec: s, version: s, isDev: false }); }
    } else if (table === 'project.optional-dependencies') {
      for (const s of arrayStrings()) { out.push({ spec: s, version: s, isDev: DEV_GROUPS.has(key.toLowerCase()) }); }
    } else if (table === 'dependency-groups' || table === 'tool.pdm.dev-dependencies'
      || (table === 'tool.uv' && key === 'dev-dependencies')) {
      for (const s of arrayStrings()) {
        if (!s.startsWith('{')) { out.push({ spec: s, version: s, isDev: true }); }
      }
    } else if (table === 'tool.poetry.dependencies' || table === 'packages') {
      out.push({ spec: key, version: value.trim(), isDev: false });
    } else if (table === 'tool.poetry.dev-dependencies' || table === 'dev-packages'
      || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table)) {
      const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(table)?.[1];
      out.push({ spec: key, version: value.trim(), isDev: group !== 'main' });
    }
  }
  return out;
}

function bracketDepth(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  let comment = false;
  for (const c of s) {
    if (comment) { if (c === '\n') { comment = false; } continue; }
    if (quote) { if (c === quote) { quote = null; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') { comment = true; continue; }
    if (c === '[') { depth++; } else if (c === ']') { depth--; }
  }
  return depth;
}

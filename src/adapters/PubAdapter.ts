import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { DeclaredDependency } from '../types/index';
import type { ModuleInfo } from '../model/ModuleModel';
import { LivenessAnalysis } from '../model/Liveness';
import {
  buildDartLibrary, identifierCounts, localExtensions, parseDartUnit, partUris, type DartUnitFile,
} from '../analysis/DartAnalyzer';
import { parseYamlMap, yamlMap, yamlString } from '../analysis/MiniYaml';
import type { SymbolUse } from '../analysis/ProjectModel';
import { listFiles, sumSizes } from '../stages/CacheInspector';
import {
  ROOT_NODE,
  type EcosystemAdapter,
  type EcosystemModel,
  type PackageNode,
  type ResolvedImport,
} from './EcosystemAdapter';

interface PubPackage {
  name: string;
  rootDir: string;
  libDir: string;
}

export class PubAdapter implements EcosystemAdapter {
  readonly ecosystem = 'pub' as const;
  readonly manifestFiles = ['pubspec.yaml'];

  constructor(_wasmDir: string) {}

  async detect(workspaceRoot: string): Promise<boolean> {
    return fs.promises.access(path.join(workspaceRoot, 'pubspec.yaml')).then(() => true, () => false);
  }

  isSourceFile(file: string): boolean {
    return file.endsWith('.dart');
  }

  async load(workspaceRoot: string, sourceFiles: string[]): Promise<EcosystemModel> {
    const warnings: string[] = [];
    const pubspec = parseYamlMap(await fs.promises.readFile(path.join(workspaceRoot, 'pubspec.yaml'), 'utf8'));
    const projectName = yamlString(pubspec.name) ?? path.basename(workspaceRoot);
    const lock = yamlMap(parseYamlMap(await fs.promises.readFile(path.join(workspaceRoot, 'pubspec.lock'), 'utf8')
      .catch(() => '')).packages);

    // ── Stage 1: manifest ──────────────────────────────────────────────────
    const declared: DeclaredDependency[] = [];
    for (const [section, isDev] of [['dependencies', false], ['dev_dependencies', true]] as const) {
      for (const [name, value] of Object.entries(yamlMap(pubspec[section]))) {
        const version = typeof value === 'string' ? value : yamlString(yamlMap(value).version) ?? '';
        declared.push({ name, declaredVersion: version, isDev });
      }
    }

    // ── Stage 2: package locations ─────────────────────────────────────────
    const packages = await readPackageConfig(workspaceRoot, projectName)
      ?? fallbackLocations(lock, warnings);
    const nodes = new Map<string, PackageNode>();
    const edges = new Map<string, string[]>();
    const declaredNodes = new Map<string, string>();
    const missingReasons = new Map<string, string>();
    const rootIndex = new Map<string, string>();
    const libFiles = new Map<string, number>();

    await Promise.all([...packages.values()].map(async (p) => {
      const lockEntry = yamlMap(lock[p.name]);
      const isSdk = yamlString(lockEntry.source) === 'sdk';
      const node: PackageNode = {
        id: p.name,
        name: p.name,
        version: yamlString(lockEntry.version) ?? null,
        dir: p.rootDir,
        diskBytes: 0,
        codeFiles: new Map(),
        entryFiles: [],
        hasCli: false,
        isTypes: false,
        isSdk,
      };
      nodes.set(p.name, node);
      rootIndex.set(p.rootDir, p.name);
      const spec = parseYamlMap(await fs.promises.readFile(path.join(p.rootDir, 'pubspec.yaml'), 'utf8').catch(() => ''));
      node.hasCli = Object.keys(yamlMap(spec.executables)).length > 0;
      edges.set(p.name, Object.keys(yamlMap(spec.dependencies)));
      if (isSdk) { return; } // SDK packages are never scored; skip measuring them

      const files = await listFiles(p.rootDir, new Set(['.dart_tool', '.git', 'build']));
      node.diskBytes = sumSizes(files);
      const srcDir = path.join(p.libDir, 'src') + path.sep;
      for (const [f, size] of files) {
        if (!f.endsWith('.dart') || !f.startsWith(p.libDir + path.sep)) { continue; }
        node.codeFiles.set(f, size);
        libFiles.set(f, size);
        if (!f.startsWith(srcDir)) { node.entryFiles.push(f); }
      }
    }));
    for (const [id, out] of edges) { edges.set(id, out.filter((n) => nodes.has(n) && n !== id)); }

    const rootEdges: string[] = [];
    for (const d of declared) {
      if (nodes.has(d.name)) {
        declaredNodes.set(d.name, d.name);
        rootEdges.push(d.name);
      } else {
        missingReasons.set(d.name, 'not found in .dart_tool/package_config.json (run `dart pub get`)');
      }
    }
    edges.set(ROOT_NODE, rootEdges);

    // ── Module analysis ────────────────────────────────────────────────────
    const resolveUri = (uri: string, fromFile: string): string | null | 'skip' => {
      if (uri.startsWith('dart:')) { return 'skip'; }
      if (uri.startsWith('package:')) {
        const [name, ...rest] = uri.slice('package:'.length).split('/');
        const p = packages.get(name);
        if (!p) { return name === projectName ? 'skip' : null; }
        const file = path.join(p.libDir, ...rest);
        return fs.existsSync(file) ? file : null;
      }
      if (/^[a-z]+:/.test(uri)) { return null; }
      const file = path.resolve(path.dirname(fromFile), uri);
      return fs.existsSync(file) ? file : null;
    };

    const ownerOf = (file: string): string | null => {
      let dir = path.dirname(file);
      for (;;) {
        const hit = rootIndex.get(dir);
        if (hit) { return hit; }
        const parent = path.dirname(dir);
        if (parent === dir) { return null; }
        dir = parent;
      }
    };

    const moduleCache = new Map<string, ModuleInfo | null>();
    const analyzeModule = async (file: string): Promise<ModuleInfo | null> => {
      if (moduleCache.has(file)) { return moduleCache.get(file)!; }
      let info: ModuleInfo | null = null;
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        const unit = parseDartUnit(text);
        if (!unit.directives.some((d) => d.kind === 'part-of')) {
          const units: DartUnitFile[] = [{ file, text, unit }];
          for (const uri of partUris(unit)) {
            const partFile = resolveUri(uri, file);
            if (typeof partFile !== 'string') { continue; }
            const partText = await fs.promises.readFile(partFile, 'utf8').catch(() => null);
            if (partText !== null) { units.push({ file: partFile, text: partText, unit: parseDartUnit(partText) }); }
          }
          info = buildDartLibrary(units, resolveUri);
        }
      } catch {
        info = null;
      }
      moduleCache.set(file, info);
      return info;
    };

    const moduleBytes = (file: string): number => {
      const info = moduleCache.get(file);
      const files = info ? info.files : [file];
      return files.reduce((sum, f) => sum + (libFiles.get(f) ?? 0), 0);
    };

    // Export tables for resolving unprefixed imports in project code.
    const tables = new LivenessAnalysis({ analyze: analyzeModule, sideEffectFree: () => true, inScope: () => true });

    /** Named extensions visible through a library (its own and re-exported ones) → member names. */
    const extensionCache = new Map<string, Map<string, string[]>>();
    const visibleExtensions = async (lib: string, visiting = new Set<string>()): Promise<Map<string, string[]>> => {
      const cached = extensionCache.get(lib);
      if (cached) { return cached; }
      const out = new Map<string, string[]>();
      const info = await analyzeModule(lib);
      if (!info || visiting.has(lib)) { return out; }
      visiting.add(lib);
      for (const [name, members] of localExtensions(info)) { out.set(name, members); }
      for (const r of info.reexports) {
        if (!r.target) { continue; }
        const sub = await visibleExtensions(r.target, visiting);
        for (const [name, members] of sub) {
          const visible = r.kind === 'named' ? r.imported === name : (!r.show || r.show.has(name)) && !r.hide?.has(name);
          if (visible) { out.set(r.kind === 'named' ? r.exported : name, members); }
        }
      }
      extensionCache.set(lib, out);
      return out;
    };

    // ── Stage 3: project imports ───────────────────────────────────────────
    const imports: ResolvedImport[] = [];
    for (const file of sourceFiles) {
      let text: string;
      try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
      const unit = parseDartUnit(text);
      const { counts, members } = identifierCounts(unit);
      const memberAccesses = new Map<string, number>();
      for (const byMember of members.values()) {
        for (const [m, c] of byMember) { memberAccesses.set(m, (memberAccesses.get(m) ?? 0) + c); }
      }
      const lineOf = (offset: number) => countLines(text, offset);

      for (const d of unit.directives) {
        if (d.kind !== 'import' && d.kind !== 'export') { continue; }
        const uri = d.uris[0];
        if (!uri?.startsWith('package:')) { continue; }
        const pkgName = uri.slice('package:'.length).split('/')[0];
        if (pkgName === projectName) { continue; }
        const targets = d.uris.map((u) => resolveUri(u, file)).filter((t): t is string => typeof t === 'string');

        const symbols = new Map<string, SymbolUse>();
        let names: Set<string> | 'ALL' = new Set<string>();
        if (d.kind === 'export') {
          names = d.show ? new Set(d.show) : 'ALL';
          for (const n of d.show ?? []) { symbols.set(n, { references: 1, typeReferences: 0, callArities: [] }); }
        } else if (d.prefix) {
          for (const [m, count] of members.get(d.prefix) ?? []) {
            if (d.show && !d.show.has(m)) { continue; }
            symbols.set(m, { references: count, typeReferences: 0, callArities: [] });
            names.add(m);
          }
        } else {
          // Extension members apply without naming the extension: match `.member` accesses.
          for (const t of targets) {
            for (const [ext, extMembers] of await visibleExtensions(t)) {
              if ((d.show && !d.show.has(ext)) || d.hide?.has(ext)) { continue; }
              const hits = extMembers.filter((m) => memberAccesses.has(m));
              if (hits.length === 0) { continue; }
              names.add(ext);
              for (const m of hits) {
                symbols.set(m, { references: memberAccesses.get(m)!, typeReferences: 0, callArities: [] });
              }
            }
          }
          for (const t of targets) {
            const table = await tables.exportTable(t, new Set());
            if (table === 'OPEN') { names = 'ALL'; break; }
            for (const n of table) {
              if ((d.show && !d.show.has(n)) || d.hide?.has(n)) { continue; }
              const count = counts.get(n);
              if (!count) { continue; }
              symbols.set(n, { references: count, typeReferences: 0, callArities: [] });
              names.add(n);
            }
          }
        }

        imports.push({
          specifier: uri,
          kind: d.kind === 'export' ? 'reexport' : 'import',
          line: lineOf(d.start),
          endLine: lineOf(d.end),
          runtime: true,
          names,
          symbols,
          file,
          packageName: pkgName,
          packageId: nodes.has(pkgName) ? pkgName : null,
          targets,
        });
      }
    }

    return {
      ecosystem: 'pub',
      declared,
      declaredNodes,
      missingReasons,
      nodes,
      edges,
      projectFiles: sourceFiles,
      imports,
      ownerOf,
      moduleBytes,
      analyzeModule,
      sideEffectFree: () => true,
      warnings,
    };
  }
}

/** Package locations from `.dart_tool/package_config.json`, written by `pub get`. */
async function readPackageConfig(root: string, projectName: string): Promise<Map<string, PubPackage> | null> {
  const configPath = path.join(root, '.dart_tool', 'package_config.json');
  let config: { packages?: Array<{ name: string; rootUri: string; packageUri?: string }> };
  try {
    config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  } catch {
    return null;
  }
  const base = pathToFileURL(configPath);
  const out = new Map<string, PubPackage>();
  for (const p of config.packages ?? []) {
    if (p.name === projectName) { continue; }
    let rootDir: string;
    try {
      rootDir = fileURLToPath(new URL(p.rootUri.endsWith('/') ? p.rootUri : p.rootUri + '/', base));
    } catch {
      continue;
    }
    rootDir = rootDir.replace(/[\\/]$/, '');
    try { rootDir = fs.realpathSync(rootDir); } catch { /* keep */ }
    out.set(p.name, { name: p.name, rootDir, libDir: path.join(rootDir, (p.packageUri ?? 'lib/').replace(/\/$/, '')) });
  }
  return out;
}

/** Without package_config.json, locate hosted packages in the pub cache by their locked versions. */
function fallbackLocations(lock: Record<string, unknown>, warnings: string[]): Map<string, PubPackage> {
  warnings.push('.dart_tool/package_config.json not found; run `dart pub get` for exact package locations.');
  const cache = process.env.PUB_CACHE
    ?? (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Pub', 'Cache')
      : path.join(os.homedir(), '.pub-cache'));
  const out = new Map<string, PubPackage>();
  for (const [name, value] of Object.entries(lock)) {
    const entry = yamlMap(value as never);
    const version = yamlString(entry.version);
    if (yamlString(entry.source) !== 'hosted' || !version) { continue; }
    for (const host of ['pub.dev', 'pub.dartlang.org']) {
      const rootDir = path.join(cache, 'hosted', host, `${name}-${version}`);
      if (fs.existsSync(rootDir)) {
        out.set(name, { name, rootDir, libDir: path.join(rootDir, 'lib') });
        break;
      }
    }
  }
  return out;
}

function countLines(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) { if (text.charCodeAt(i) === 10) { n++; } }
  return n;
}

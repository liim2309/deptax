import * as fs from 'fs';
import * as path from 'path';
import type { DeclaredDependency } from '../types/index';
import type { ModuleInfo } from '../model/ModuleModel';
import { analyzeJsModule } from '../analysis/JsModuleAnalyzer';
import { analyzeJsProjectFile } from '../analysis/JsProjectAnalyzer';
import { isJsCodeFile, isRelative, NodeResolver, splitSpecifier } from '../analysis/NodeResolver';
import { jsGrammarFor, loadGrammars, parse } from '../stages/TreeSitterHelper';
import { listFiles, sumSizes } from '../stages/CacheInspector';
import {
  ROOT_NODE,
  type EcosystemAdapter,
  type EcosystemModel,
  type PackageNode,
  type ResolvedImport,
} from './EcosystemAdapter';

const SOURCE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export class NpmAdapter implements EcosystemAdapter {
  readonly ecosystem = 'npm' as const;
  readonly manifestFiles = ['package.json'];

  constructor(private readonly wasmDir: string) {}

  async detect(workspaceRoot: string): Promise<boolean> {
    return fs.promises.access(path.join(workspaceRoot, 'package.json')).then(() => true, () => false);
  }

  isSourceFile(file: string): boolean {
    return SOURCE_RE.test(file) && !/\.d\.[cm]?ts$/.test(file);
  }

  async load(workspaceRoot: string, sourceFiles: string[]): Promise<EcosystemModel> {
    await loadGrammars(this.wasmDir);
    const resolver = new NodeResolver();
    const root = resolver.realpath(workspaceRoot);
    const rootPj = resolver.readPackageJson(root) ?? {};
    const warnings: string[] = [];

    // ── Stage 1: manifest ──────────────────────────────────────────────────
    const declared: DeclaredDependency[] = [];
    const addDeps = (deps: Record<string, string> | undefined, isDev: boolean) => {
      for (const [name, version] of Object.entries(deps ?? {})) {
        declared.push({ name, declaredVersion: version, isDev });
      }
    };
    addDeps(rootPj.dependencies, false);
    addDeps(rootPj.optionalDependencies, false);
    addDeps(rootPj.devDependencies, true);

    // ── Stage 2: package graph from node_modules ───────────────────────────
    const nodes = new Map<string, PackageNode>();
    const edges = new Map<string, string[]>();
    const declaredNodes = new Map<string, string>();
    const missingReasons = new Map<string, string>();

    const rootEdges: string[] = [];
    const queue: string[] = [];
    const ensureNode = (dir: string) => {
      if (!nodes.has(dir)) {
        const pj = resolver.readPackageJson(dir);
        nodes.set(dir, {
          id: dir,
          name: pj?.name ?? path.basename(dir),
          version: pj?.version ?? null,
          dir,
          diskBytes: 0,
          codeFiles: new Map(),
          entryFiles: [],
          hasCli: !!pj?.bin,
          isTypes: (pj?.name ?? '').startsWith('@types/'),
          isSdk: false,
        });
        queue.push(dir);
      }
      return dir;
    };

    for (const dep of declared) {
      const dir = resolver.findPackage(dep.name, root);
      if (!dir) {
        missingReasons.set(dep.name, 'not installed (run your package manager\'s install)');
        continue;
      }
      declaredNodes.set(dep.name, ensureNode(dir));
      rootEdges.push(dir);
    }
    edges.set(ROOT_NODE, [...new Set(rootEdges)]);

    while (queue.length > 0) {
      const dir = queue.shift()!;
      const pj = resolver.readPackageJson(dir) ?? {};
      const names = new Set([
        ...Object.keys(pj.dependencies ?? {}),
        ...Object.keys(pj.optionalDependencies ?? {}),
        ...Object.keys(pj.peerDependencies ?? {}),
      ]);
      const out: string[] = [];
      for (const name of names) {
        const child = resolver.findPackage(name, dir);
        if (child && child !== dir) { out.push(ensureNode(child)); }
      }
      edges.set(dir, out);
    }

    await Promise.all([...nodes.values()].map(async (node) => {
      const files = await listFiles(node.dir!, new Set(['node_modules']));
      node.diskBytes = sumSizes(files);
      for (const [f, size] of files) {
        if (isJsCodeFile(f)) { node.codeFiles.set(f, size); }
      }
      node.entryFiles = resolver.entryFiles(node.dir!, 'import');
    }));

    const ownerCache = new Map<string, string | null>();
    const ownerOf = (file: string): string | null => {
      const start = path.dirname(file);
      if (ownerCache.has(start)) { return ownerCache.get(start)!; }
      let dir = start;
      const visited: string[] = [];
      let found: string | null = null;
      for (;;) {
        if (ownerCache.has(dir)) { found = ownerCache.get(dir)!; break; }
        visited.push(dir);
        if (nodes.has(dir)) { found = dir; break; }
        const parent = path.dirname(dir);
        if (parent === dir || dir === root) { break; }
        dir = parent;
      }
      for (const v of visited) { ownerCache.set(v, found); }
      return found;
    };

    const moduleCache = new Map<string, ModuleInfo | null>();
    const analyzeModule = async (file: string): Promise<ModuleInfo | null> => {
      if (moduleCache.has(file)) { return moduleCache.get(file)!; }
      let info: ModuleInfo | null = null;
      if (isJsCodeFile(file) && !file.endsWith('.json')) {
        try {
          const text = await fs.promises.readFile(file, 'utf8');
          const tree = parse(jsGrammarFor(file), text);
          try {
            const owner = ownerOf(file);
            const context = (prefix: string) => [...(owner ? nodes.get(owner)!.codeFiles.keys() : [])]
              .filter((f) => f.startsWith(prefix) && f !== file);
            info = analyzeJsModule(tree.rootNode, file, (spec, kind) => resolver.resolve(spec, file, kind), context);
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

    const moduleBytes = (file: string): number => {
      const owner = ownerOf(file);
      const size = owner ? nodes.get(owner)?.codeFiles.get(file) : undefined;
      if (size !== undefined) { return size; }
      try { return fs.statSync(file).size; } catch { return 0; }
    };

    const sideEffectFree = (file: string): boolean => {
      const owner = ownerOf(file);
      if (!owner) { return false; }
      const flag = resolver.readPackageJson(owner)?.sideEffects;
      if (flag === false) { return true; }
      if (Array.isArray(flag)) {
        const rel = path.relative(owner, file).split(path.sep).join('/');
        return !flag.some((pattern) => globMatch(pattern, rel));
      }
      return false;
    };

    // ── Stage 3: project imports ───────────────────────────────────────────
    const declaredNames = new Set(declared.map((d) => d.name));
    const imports: ResolvedImport[] = [];
    let parseFailures = 0;

    for (const file of sourceFiles) {
      let text: string;
      try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
      let analysis;
      try {
        const tree = parse(jsGrammarFor(file), text);
        try {
          analysis = analyzeJsProjectFile(tree.rootNode, /\.[cm]?tsx?$/.test(file));
        } finally {
          tree.delete();
        }
      } catch {
        parseFailures++;
        continue;
      }

      const fileImports = [...analysis.imports];
      if (analysis.hasJsx && declaredNodes.has('react')) {
        fileImports.push({
          specifier: 'react/jsx-runtime', kind: 'implicit', line: 0, endLine: 0, runtime: true,
          names: new Set(['jsx', 'jsxs', 'Fragment']), symbols: new Map(),
        });
      }

      for (const imp of fileImports) {
        if (isRelative(imp.specifier) || imp.specifier.startsWith('#')) { continue; }
        const kind = imp.kind === 'require' ? 'require' : 'import';
        const target = resolver.resolve(imp.specifier, file, kind);
        if (target === 'builtin') { continue; }
        const { name } = splitSpecifier(imp.specifier);
        const pkgDir = resolver.findPackage(name, path.dirname(resolver.realpath(file)));
        if (!pkgDir && !declaredNames.has(name)) { continue; } // path alias or undeclared, uninstalled module
        let packageId: string | null = null;
        if (pkgDir) {
          if (!nodes.has(pkgDir)) {
            warnings.push(`"${name}" is imported by ${path.relative(workspaceRoot, file)} but is not a declared dependency.`);
            continue;
          }
          packageId = pkgDir;
        }
        imports.push({
          ...imp,
          file,
          packageName: name,
          packageId,
          targets: typeof target === 'string' && ownerOf(target) ? [target] : [],
        });
      }
    }
    if (parseFailures > 0) {
      warnings.push(`${parseFailures} source file(s) could not be parsed and were skipped.`);
    }

    return {
      ecosystem: 'npm',
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
      sideEffectFree,
      warnings,
    };
  }
}

/** package.json `sideEffects` glob: `*` within a segment, `**` across segments; bare names match anywhere. */
function globMatch(pattern: string, rel: string): boolean {
  let p = pattern.replace(/^\.\//, '');
  if (!p.includes('/')) { p = `**/${p}`; }
  const re = p.split('/').map((seg) => (seg === '**'
    ? '(?:.*/)?'
    : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/'))
    .join('').replace(/\/$/, '').replace(/\(\?:\.\*\/\)\?$/, '.*');
  return new RegExp(`^${re}$`).test(rel);
}

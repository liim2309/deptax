import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DeclaredDependency, PackageFootprint } from '../types/index';
import type { EcosystemAdapter } from './EcosystemAdapter';
import { parseDart, collectNodes } from '../stages/TreeSitterHelper';
import { computeDirSize } from '../stages/CacheInspector';

export class PubAdapter implements EcosystemAdapter {
  readonly ecosystem = 'pub' as const;

  constructor(private readonly wasmDir: string = '') {}

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(workspaceRoot, 'pubspec.yaml'));
      return true;
    } catch {
      return false;
    }
  }

  async parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]> {
    const specPath = path.join(workspaceRoot, 'pubspec.yaml');
    const raw = await fs.promises.readFile(specPath, 'utf8');

    // Resolved versions from pubspec.lock (best-effort)
    const resolvedVersions = await this.readLockfileVersions(workspaceRoot);

    // State-machine line parser for pubspec.yaml
    // We only care about the top-level "dependencies:" and "dev_dependencies:" sections.
    // Package entries look like:
    //   dependencies:
    //     http: ^0.13.5
    //     provider:
    //       version: ^6.0.0
    //     flutter:
    //       sdk: flutter        ← sdk deps — include as-is
    type Section = 'none' | 'dependencies' | 'dev_dependencies';
    let section: Section = 'none';
    const results: DeclaredDependency[] = [];

    // Track multi-line package blocks like:
    //   provider:
    //     version: ^6.0.0
    let pendingName: string | null = null;
    let pendingIsDev = false;

    const flush = (name: string | null, declaredVersion: string, isDev: boolean) => {
      if (!name) { return; }
      results.push({
        name,
        declaredVersion: resolvedVersions.get(name) ?? declaredVersion,
        isDev,
      });
    };

    for (const line of raw.split('\n')) {
      // Skip blank lines and comments
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.trimStart().startsWith('#')) { continue; }

      const indent = line.length - line.trimStart().length;

      // Top-level section headers (no indentation)
      if (indent === 0) {
        // Flush any pending multi-line entry
        if (pendingName) {
          flush(pendingName, '', pendingIsDev);
          pendingName = null;
        }
        if (trimmed === 'dependencies:') { section = 'dependencies'; continue; }
        if (trimmed === 'dev_dependencies:') { section = 'dev_dependencies'; continue; }
        // Any other top-level key ends the dependency sections
        section = 'none';
        continue;
      }

      if (section === 'none') { continue; }

      const isDev = section === 'dev_dependencies';

      // Depth-1 entries (2-space indent) — package names
      if (indent === 2) {
        // Flush previous pending entry
        if (pendingName) {
          flush(pendingName, '', pendingIsDev);
          pendingName = null;
        }

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) { continue; }
        const pkgName = trimmed.slice(0, colonIdx).trim();
        const rest = trimmed.slice(colonIdx + 1).trim();

        if (rest) {
          // Inline version: "http: ^0.13.5"  or  "flutter: any"
          flush(pkgName, rest, isDev);
        } else {
          // Multi-line block — wait for the "version:" child key
          pendingName = pkgName;
          pendingIsDev = isDev;
        }
        continue;
      }

      // Depth-2 entries (4-space indent) — attributes of a pending package
      if (indent >= 4 && pendingName) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          const val = trimmed.slice(colonIdx + 1).trim();
          if (key === 'version' && val) {
            flush(pendingName, val, pendingIsDev);
            pendingName = null;
          }
        }
      }
    }

    // Flush any trailing pending entry
    if (pendingName) {
      flush(pendingName, '', pendingIsDev);
    }

    return results;
  }

  /**
   * Parse pubspec.lock for resolved versions.
   * The lock file structure (simplified):
   *
   *   packages:
   *     http:
   *       version: "0.13.6"
   *     provider:
   *       version: "6.0.5"
   */
  private async readLockfileVersions(workspaceRoot: string): Promise<Map<string, string>> {
    const lockPath = path.join(workspaceRoot, 'pubspec.lock');
    try {
      const raw = await fs.promises.readFile(lockPath, 'utf8');
      return this.parsePubspecLock(raw);
    } catch {
      return new Map<string, string>();
    }
  }

  private parsePubspecLock(content: string): Map<string, string> {
    const versions = new Map<string, string>();
    let inPackages = false;
    let currentPkg: string | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.trimStart().startsWith('#')) { continue; }

      const indent = trimmed.length - trimmed.trimStart().length;

      if (indent === 0) {
        inPackages = trimmed === 'packages:';
        currentPkg = null;
        continue;
      }

      if (!inPackages) { continue; }

      // Package name block at indent 2
      if (indent === 2) {
        const colonIdx = trimmed.indexOf(':');
        currentPkg = colonIdx !== -1 ? trimmed.slice(0, colonIdx).trim() : null;
        continue;
      }

      // Attributes at indent 4
      if (indent === 4 && currentPkg) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (key === 'version' && val) {
            versions.set(currentPkg, val);
          }
        }
      }
    }
    return versions;
  }

  async inspectPackage(workspaceRoot: string, dep: DeclaredDependency): Promise<PackageFootprint> {
    const zeroStub = (): PackageFootprint => ({
      name: dep.name,
      installedVersion: dep.declaredVersion,
      diskSizeKb: 0,
      fileCount: 0,
      transitiveCount: 0,
      exportedSymbols: [],
    });

    // Resolve installed version from lockfile if not already resolved
    const version = dep.declaredVersion.replace(/^[\^~>=<]+/, '').trim() || '';

    // Try to locate the package directory in pub-cache
    const pubCacheBase = path.join(os.homedir(), '.pub-cache', 'hosted', 'pub.dev');
    let pkgLibDir: string | null = null;

    if (version) {
      const candidate = path.join(pubCacheBase, `${dep.name}-${version}`, 'lib');
      const exists = await fs.promises.access(candidate).then(() => true).catch(() => false);
      if (exists) { pkgLibDir = candidate; }
    }

    // Fallback: glob-style scan for any version of the package
    if (!pkgLibDir) {
      const prefix = `${dep.name}-`;
      const entries = await fs.promises.readdir(pubCacheBase).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const candidate = path.join(pubCacheBase, entry, 'lib');
          const exists = await fs.promises.access(candidate).then(() => true).catch(() => false);
          if (exists) {
            pkgLibDir = candidate;
            break;
          }
        }
      }
    }

    if (!pkgLibDir) { return zeroStub(); }

    const { sizeKb, fileCount } = await computeDirSize(pkgLibDir);

    // Transitive count: parse pubspec.lock for this package's dependencies block
    const transitiveCount = await this.readTransitiveCount(workspaceRoot, dep.name);

    // Exported symbols: scan .dart files for public top-level declarations
    const exportedSymbols = await this.extractDartSymbols(pkgLibDir);

    // Determine installed version from directory name
    const dirName = path.basename(path.dirname(pkgLibDir)); // e.g. "http-0.13.6"
    const installedVersion = dirName.startsWith(`${dep.name}-`)
      ? dirName.slice(dep.name.length + 1)
      : dep.declaredVersion;

    return { name: dep.name, installedVersion, diskSizeKb: sizeKb, fileCount, transitiveCount, exportedSymbols };
  }

  private async readTransitiveCount(workspaceRoot: string, packageName: string): Promise<number> {
    const lockPath = path.join(workspaceRoot, 'pubspec.lock');
    try {
      const raw = await fs.promises.readFile(lockPath, 'utf8');
      return this.parseTransitiveDepsCount(raw, packageName);
    } catch {
      return 0;
    }
  }

  /**
   * Parse pubspec.lock to count the number of dependencies for a given package.
   * The lock file format:
   *
   *   packages:
   *     http:
   *       dependency: "direct main"
   *       dependencies:
   *         async: ">=2.5.0 <3.0.0"
   *         ...
   */
  private parseTransitiveDepsCount(content: string, packageName: string): number {
    let inPackages = false;
    let inTargetPkg = false;
    let inDepsBlock = false;
    let count = 0;

    for (const line of content.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.trimStart().startsWith('#')) { continue; }
      const indent = trimmed.length - trimmed.trimStart().length;

      if (indent === 0) {
        inPackages = trimmed === 'packages:';
        inTargetPkg = false;
        inDepsBlock = false;
        continue;
      }
      if (!inPackages) { continue; }

      if (indent === 2) {
        inDepsBlock = false;
        const colonIdx = trimmed.indexOf(':');
        const name = colonIdx !== -1 ? trimmed.slice(0, colonIdx).trim() : trimmed.trim();
        inTargetPkg = name === packageName;
        continue;
      }

      if (indent === 4 && inTargetPkg) {
        inDepsBlock = trimmed.trim() === 'dependencies:';
        continue;
      }

      if (indent >= 6 && inTargetPkg && inDepsBlock) {
        // Each line here is one dependency entry
        count++;
      }
    }
    return count;
  }

  private async extractDartSymbols(libDir: string): Promise<string[]> {
    const seen = new Set<string>();
    // Collect symbols from the package's own lib/ files, then follow any
    // cross-package `export 'package:X/...'` directives in barrel files.
    await this.collectDartSymbolsFromDir(libDir, seen, /* followPackageExports */ true);
    return Array.from(seen);
  }

  /**
   * Recursively scan a lib directory for public Dart symbol declarations.
   *
   * When `followPackageExports` is true, barrel files (files containing only
   * `export` directives — common in facade packages like `supabase_flutter`,
   * `google_fonts`, `fl_chart`) are followed into the pub-cache of the
   * re-exported package.  This is the key fix for packages that re-export
   * their entire public API from a dependency.
   *
   * Re-export depth is capped at 2 to avoid runaway traversal.
   */
  private async collectDartSymbolsFromDir(
    libDir: string,
    seen: Set<string>,
    followPackageExports: boolean,
    depth: number = 0,
  ): Promise<void> {
    // Patterns for top-level public declarations
    const declarationRe = /^(?:abstract\s+(?:class|interface)|class|mixin|extension|typedef|enum)\s+([A-Z]\w*)/;
    const functionRe = /^(?:Future|Stream|String|int|bool|dynamic|void|List|Map|\w+)\s+([a-z]\w*)\s*\(/;
    // Pattern to detect cross-package export directives in barrel files
    const pkgExportRe = /^export\s+['"]package:([^/'"]+)\/[^'"]+['"]/;

    let dartFiles: string[] = [];
    try {
      const entries = await fs.promises.readdir(libDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.dart')) {
          const filePath = path.join(
            entry.parentPath ?? (entry as unknown as { path: string }).path ?? libDir,
            entry.name,
          );
          dartFiles.push(filePath);
        }
      }
    } catch {
      return;
    }

    // Track which external packages this lib re-exports, to follow them
    const reExportedPackages = new Set<string>();

    for (const filePath of dartFiles) {
      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const stripped = line.trimStart();
        if (!stripped || stripped.startsWith('//')) { continue; }

        // Collect re-exported package names from barrel files
        if (followPackageExports && depth < 2) {
          const em = pkgExportRe.exec(stripped);
          if (em) {
            reExportedPackages.add(em[1]);
            continue;
          }
        }

        // Skip private declarations
        if (stripped.startsWith('_')) { continue; }

        const dm = declarationRe.exec(stripped);
        if (dm && !seen.has(dm[1])) {
          seen.add(dm[1]);
          continue;
        }
        const fm = functionRe.exec(stripped);
        if (fm && !seen.has(fm[1])) {
          seen.add(fm[1]);
        }
      }
    }

    // Follow cross-package re-exports (e.g. supabase_flutter → supabase)
    if (followPackageExports && depth < 2 && reExportedPackages.size > 0) {
      const pubCacheBase = path.join(os.homedir(), '.pub-cache', 'hosted', 'pub.dev');
      let allEntries: string[] = [];
      try {
        allEntries = await fs.promises.readdir(pubCacheBase);
      } catch { /* pub-cache not available */ }

      for (const pkgName of reExportedPackages) {
        // Find the installed version directory (pick the first/latest match)
        const prefix = `${pkgName}-`;
        const match = allEntries.find(e => e.startsWith(prefix));
        if (!match) { continue; }
        const depLibDir = path.join(pubCacheBase, match, 'lib');
        const exists = await fs.promises.access(depLibDir).then(() => true).catch(() => false);
        if (!exists) { continue; }
        // Recurse — but don't follow further cross-package exports at depth 2
        await this.collectDartSymbolsFromDir(depLibDir, seen, true, depth + 1);
      }
    }
  }

  getSourceGlobs(): string[] {
    return ['**/*.dart'];
  }

  /**
   * Parse a Dart file and extract packageName → symbol names.
   *
   * Handles two cases:
   *
   *   1. Explicit show combinator:
   *        import 'package:quiver/strings.dart' show isBlank;
   *      → quiver, ['isBlank']   (exact, use as-is)
   *
   *   2. Bare wildcard import (the common case for facade packages):
   *        import 'package:supabase_flutter/supabase_flutter.dart';
   *      → quiver, ['SupabaseClient', 'Supabase', ...]
   *      We fall back to scanning the file text for any identifier that matches
   *      one of the package's known exported symbols. This is how you actually
   *      measure usage of packages that export classes you reference by name.
   */
  async extractImports(
    fileText: string,
    _filePath: string,
    exportedSymbolsMap?: Map<string, string[]>,
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!this.wasmDir) { return result; }

    let tree;
    try {
      tree = await parseDart(fileText, this.wasmDir);
    } catch {
      return result;
    }

    // The Dart grammar nests import URIs deeply:
    //   import_or_export → library_import → import_specification
    //     → configurable_uri → uri → string_literal
    //
    // We only collect the top-level `import_or_export` nodes (one per import
    // statement), then use deepFind() to locate the URI and combinator
    // anywhere inside each node — regardless of nesting depth.
    const importNodes = collectNodes(tree.rootNode, new Set(['import_or_export']));

    for (const node of importNodes) {
      // Find the URI string_literal anywhere inside this import node
      const uriNode = deepFind(node, n =>
        n.type === 'string_literal' || n.type === 'uri' || n.type === 'string',
      );
      if (!uriNode) { continue; }
      const uri = uriNode.text.replace(/^['"]|['"]$/g, '');

      // Only process package: imports
      if (!uri.startsWith('package:')) { continue; }
      const packageName = uri.slice('package:'.length).split('/')[0];

      if (!result.has(packageName)) {
        result.set(packageName, []);
      }
      const existing = result.get(packageName)!;

      // Case 1: explicit `show` combinator — find it anywhere inside the node
      const showCombinator = deepFind(node, n =>
        n.type === 'show_combinator' || n.type === 'combinator',
      );
      if (showCombinator) {
        for (const child of showCombinator.namedChildren) {
          if (child.type === 'identifier' && !existing.includes(child.text)) {
            existing.push(child.text);
          }
        }
        continue;
      }

      // Case 2: bare import — scan the file text for occurrences of the package's
      // exported symbols. We match any word-boundary occurrence (class name, constructor,
      // property access, type annotation) — not just function calls.
      const knownExports = exportedSymbolsMap?.get(packageName) ?? [];
      for (const sym of knownExports) {
        const pattern = new RegExp(`\\b${escapeRegex(sym)}\\b`);
        if (pattern.test(fileText) && !existing.includes(sym)) {
          existing.push(sym);
        }
      }
    }

    tree.delete();
    return result;
  }

  /**
   * Count occurrences of `symbolName` in Dart source.
   *
   * Counts ALL identifier usages — function calls `sym(`, constructor calls `sym(`,
   * member accesses `.sym`, type annotations `: sym`, and standalone references `sym`.
   * This is necessary because Dart usage patterns are dominated by class/widget
   * instantiation and property access, not just bare function calls.
   */
  countCallSites(fileText: string, symbolName: string): number {
    // Match any word-boundary occurrence of the identifier
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g');
    return (fileText.match(pattern) ?? []).length;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Depth-first search for the first node satisfying `predicate` anywhere
 * inside `root` (inclusive).  Returns undefined if not found.
 */
function deepFind(
  root: import('web-tree-sitter').SyntaxNode,
  predicate: (n: import('web-tree-sitter').SyntaxNode) => boolean,
): import('web-tree-sitter').SyntaxNode | undefined {
  if (predicate(root)) { return root; }
  for (const child of root.namedChildren) {
    const found = deepFind(child, predicate);
    if (found) { return found; }
  }
  return undefined;
}

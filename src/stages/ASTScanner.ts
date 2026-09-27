import * as fs from 'fs';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import type { EcosystemAdapter } from '../adapters/EcosystemAdapter';
import type { PackageFootprint, PackageUsage, UsedSymbol } from '../types/index';

/**
 * Stage 3 — AST Scanner.
 *
 * Orchestrates file discovery and delegates all language-specific parsing to
 * the active EcosystemAdapter.  The adapter calls back into TreeSitterHelper
 * for the actual Tree-sitter work.
 */
export class ASTScanner {
  private initialized = false;

  constructor(private readonly wasmDir: string) {}

  /**
   * Initialize web-tree-sitter.  Must be called once before `scanWorkspace`.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) { return; }
    await Parser.init({
      locateFile: (file: string) => path.join(this.wasmDir, file),
    });
    this.initialized = true;
  }

  /**
   * Scan all source files in `workspaceRoot` that match the adapter's globs
   * and return a map of packageName → aggregated PackageUsage.
   *
   * @param footprints - Optional list of already-inspected package footprints.
   *   When provided, the exported symbols are passed to `extractImports` so that
   *   adapters can resolve bare wildcard imports (e.g. Dart's
   *   `import 'package:supabase_flutter/…'`) by scanning file text for known
   *   identifiers rather than returning an empty symbol list.
   */
  async scanWorkspace(
    workspaceRoot: string,
    adapter: EcosystemAdapter,
    footprints?: PackageFootprint[],
  ): Promise<Map<string, PackageUsage>> {
    await this.initialize();

    // Build a map of packageName → exported symbol names from the footprints
    // so that adapters can perform bare-import fallback symbol resolution.
    const exportedSymbolsMap = new Map<string, string[]>();
    for (const fp of footprints ?? []) {
      exportedSymbolsMap.set(fp.name, fp.exportedSymbols);
    }

    const files = await this.globFiles(workspaceRoot, adapter.getSourceGlobs());
    const aggregate = new Map<string, PackageUsage>();

    for (const filePath of files) {
      let fileText: string;
      try {
        fileText = await fs.promises.readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      // Ask the adapter which packages/symbols this file imports.
      // Pass exportedSymbolsMap so adapters can resolve bare wildcard imports.
      let importsMap: Map<string, string[]>;
      try {
        importsMap = await adapter.extractImports(fileText, filePath, exportedSymbolsMap);
      } catch {
        continue;
      }

      for (const [packageName, symbols] of importsMap) {
        if (!aggregate.has(packageName)) {
          aggregate.set(packageName, { packageName, usedSymbols: [] });
        }
        const usage = aggregate.get(packageName)!;

        for (const symbolName of symbols) {
          // Count invocations in this file
          let callCount = 0;
          try {
            callCount = adapter.countCallSites(fileText, symbolName);
          } catch {
            callCount = 0;
          }

          // Merge into the aggregate UsedSymbol entry
          const existing = usage.usedSymbols.find(s => s.symbolName === symbolName);
          if (existing) {
            existing.callCount += callCount;
            if (!existing.files.includes(filePath)) {
              existing.files.push(filePath);
            }
          } else {
            const usedSym: UsedSymbol = {
              symbolName,
              callCount,
              files: [filePath],
            };
            usage.usedSymbols.push(usedSym);
          }
        }
      }
    }

    return aggregate;
  }

  /**
   * Expand one or more glob patterns relative to `root`.
   * Uses a simple recursive directory walk — avoids adding a glob library.
   */
  private async globFiles(root: string, globs: string[]): Promise<string[]> {
    const allFiles = await this.walkDir(root, root);
    return allFiles.filter(f => {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      return globs.some(g => this.matchGlob(g, rel));
    });
  }

  private async walkDir(base: string, dir: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      // Skip hidden directories and common large directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.dart_tool') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await this.walkDir(base, full));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
    return results;
  }

  /**
   * Minimal glob matcher that handles `**`, `*`, and `?` patterns.
   * Pattern segments are matched against path segments.
   */
  private matchGlob(pattern: string, filePath: string): boolean {
    // Convert glob to a regex
    const regexStr = pattern
      .split('/')
      .map(seg => {
        if (seg === '**') { return '(?:.+/)?'; }
        return (
          seg
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')
        ) + '/';
      })
      .join('')
      .replace(/\/$/, '$');
    try {
      return new RegExp('^' + regexStr).test(filePath);
    } catch {
      return false;
    }
  }
}

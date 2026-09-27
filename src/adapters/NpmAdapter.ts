import * as fs from 'fs';
import * as path from 'path';
import type { DeclaredDependency, PackageFootprint } from '../types/index';
import type { EcosystemAdapter } from './EcosystemAdapter';
import { parseTypeScript, collectNodes } from '../stages/TreeSitterHelper';
import { computeDirSize } from '../stages/CacheInspector';

export class NpmAdapter implements EcosystemAdapter {
  readonly ecosystem = 'npm' as const;

  constructor(private readonly wasmDir: string = '') {}

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(workspaceRoot, 'package.json'));
      return true;
    } catch {
      return false;
    }
  }

  async parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]> {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    const raw = await fs.promises.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // Build resolved-version map from lockfile (package-lock.json v2/v3 or pnpm-lock.yaml)
    const resolvedVersions = await this.readLockfileVersions(workspaceRoot);

    const results: DeclaredDependency[] = [];

    const addDeps = (deps: Record<string, string> | undefined, isDev: boolean) => {
      if (!deps) { return; }
      for (const [name, declaredVersion] of Object.entries(deps)) {
        results.push({
          name,
          declaredVersion: resolvedVersions.get(name) ?? declaredVersion,
          isDev,
        });
      }
    };

    addDeps(pkg.dependencies, false);
    addDeps(pkg.devDependencies, true);

    return results;
  }

  private async readLockfileVersions(workspaceRoot: string): Promise<Map<string, string>> {
    // Try package-lock.json first (npm v2/v3 — uses top-level "packages" key)
    const npmLockPath = path.join(workspaceRoot, 'package-lock.json');
    try {
      const raw = await fs.promises.readFile(npmLockPath, 'utf8');
      const lock = JSON.parse(raw) as {
        packages?: Record<string, { version?: string }>;
      };
      const versions = new Map<string, string>();
      if (lock.packages) {
        for (const [key, entry] of Object.entries(lock.packages)) {
          // keys look like "node_modules/lodash" or "" (root)
          if (!key || !entry.version) { continue; }
          const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
          versions.set(name, entry.version);
        }
      }
      return versions;
    } catch {
      // fall through
    }

    // Try pnpm-lock.yaml (simple line scan — no full YAML parser)
    const pnpmLockPath = path.join(workspaceRoot, 'pnpm-lock.yaml');
    try {
      const raw = await fs.promises.readFile(pnpmLockPath, 'utf8');
      return this.parsePnpmLock(raw);
    } catch {
      // No lockfile — caller will use declared versions
    }

    return new Map<string, string>();
  }

  /**
   * Minimal pnpm-lock.yaml version extractor.
   * Looks for blocks like:
   *   /lodash@4.17.21:
   *     resolution: {integrity: ...}
   *     version: 4.17.21
   */
  private parsePnpmLock(content: string): Map<string, string> {
    const versions = new Map<string, string>();
    // pnpm lock v6+: top-level keys look like "/packageName@version:"
    const pkgHeader = /^\/?([\w@][\w./-]*)@([\d][^\s:/]*):?\s*$/;
    let currentName: string | null = null;
    for (const line of content.split('\n')) {
      const hm = pkgHeader.exec(line);
      if (hm) {
        currentName = hm[1];
        // Use the version from the header key as a fallback
        if (!versions.has(currentName)) {
          versions.set(currentName, hm[2]);
        }
        continue;
      }
      if (currentName) {
        const vm = /^\s+version:\s+'?([\S]+?)'?\s*$/.exec(line);
        if (vm) {
          versions.set(currentName, vm[1]);
        }
      }
    }
    return versions;
  }

  async inspectPackage(workspaceRoot: string, dep: DeclaredDependency): Promise<PackageFootprint> {
    const pkgDir = path.join(workspaceRoot, 'node_modules', dep.name);

    // Check the package directory exists
    const exists = await fs.promises.access(pkgDir).then(() => true).catch(() => false);
    if (!exists) {
      return {
        name: dep.name,
        installedVersion: dep.declaredVersion,
        diskSizeKb: 0,
        fileCount: 0,
        transitiveCount: 0,
        exportedSymbols: [],
      };
    }

    // Disk size and file count
    const { sizeKb, fileCount } = await computeDirSize(pkgDir);

    // Parse the package's own package.json
    let installedVersion = dep.declaredVersion;
    let transitiveCount = 0;
    let typesEntry: string | undefined;

    const pkgJsonPath = path.join(pkgDir, 'package.json');
    try {
      const raw = await fs.promises.readFile(pkgJsonPath, 'utf8');
      const pkgJson = JSON.parse(raw) as {
        version?: string;
        dependencies?: Record<string, string>;
        types?: string;
        typings?: string;
      };
      if (pkgJson.version) { installedVersion = pkgJson.version; }
      transitiveCount = pkgJson.dependencies ? Object.keys(pkgJson.dependencies).length : 0;
      typesEntry = pkgJson.types ?? pkgJson.typings;
    } catch {
      // best-effort
    }

    // Find the types declaration file
    const candidatePaths: string[] = [];
    if (typesEntry) {
      candidatePaths.push(path.join(pkgDir, typesEntry));
    }
    candidatePaths.push(path.join(pkgDir, 'index.d.ts'));

    let dtsContent: string | null = null;
    for (const candidate of candidatePaths) {
      try {
        dtsContent = await fs.promises.readFile(candidate, 'utf8');
        break;
      } catch {
        // try next
      }
    }

    const exportedSymbols: string[] = [];
    if (dtsContent) {
      // Named exports: export (function|const|class|interface|type|enum) <Name>
      const namedExportRe = /^export\s+(?:declare\s+)?(?:function|const|class|interface|type|enum|abstract\s+class)\s+(\w+)/gm;
      let m: RegExpExecArray | null;
      while ((m = namedExportRe.exec(dtsContent)) !== null) {
        if (!exportedSymbols.includes(m[1])) { exportedSymbols.push(m[1]); }
      }

      // Re-export lists: export { Foo, Bar as Baz }
      const reExportRe = /^export\s*\{([^}]+)\}/gm;
      while ((m = reExportRe.exec(dtsContent)) !== null) {
        for (const part of m[1].split(',')) {
          // "Foo as Bar" → take the last identifier (the exported name)
          const nameMatch = /(\w+)\s*$/.exec(part.trim());
          if (nameMatch && !exportedSymbols.includes(nameMatch[1])) {
            exportedSymbols.push(nameMatch[1]);
          }
        }
      }
    }

    return { name: dep.name, installedVersion, diskSizeKb: sizeKb, fileCount, transitiveCount, exportedSymbols };
  }

  getSourceGlobs(): string[] {
    return ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
  }

  /**
   * Parse a TypeScript/JS file and extract a map of
   * packageName → imported symbol names.
   *
   * Handles:
   *   import { isEqual, clamp } from 'lodash';
   *   import _ from 'lodash';
   *   import * as _ from 'lodash';
   */
  async extractImports(fileText: string, _filePath: string, _exportedSymbolsMap?: Map<string, string[]>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!this.wasmDir) { return result; }

    let tree;
    try {
      tree = await parseTypeScript(fileText, this.wasmDir);
    } catch {
      return result;
    }

    // Collect all import_statement nodes
    const importNodes = collectNodes(tree.rootNode, new Set(['import_statement']));

    for (const node of importNodes) {
      // The `source` field is a string node like "'lodash'"
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) { continue; }
      const rawSource = sourceNode.text.replace(/^['"]|['"]$/g, '');

      // Skip relative imports
      if (rawSource.startsWith('.')) { continue; }

      // Derive package name (handles scoped packages like @org/pkg)
      const packageName = this.packageNameFromSpecifier(rawSource);

      const symbols: string[] = [];

      // Walk children looking for import clause / named imports
      for (const child of node.children) {
        if (child.type === 'import_clause') {
          this.extractClauseSymbols(child, symbols);
        }
      }

      if (!result.has(packageName)) {
        result.set(packageName, []);
      }
      const existing = result.get(packageName)!;
      for (const s of symbols) {
        if (!existing.includes(s)) { existing.push(s); }
      }
    }

    tree.delete();
    return result;
  }

  /** Count call-site occurrences of `symbolName` in a TypeScript/JS file. */
  countCallSites(fileText: string, symbolName: string): number {
    // Simple regex approach — avoids async in a sync interface
    // Matches `symbolName(` at word boundary
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\s*\\(`, 'g');
    return (fileText.match(pattern) ?? []).length;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private packageNameFromSpecifier(specifier: string): string {
    if (specifier.startsWith('@')) {
      // Scoped: "@org/pkg/sub" → "@org/pkg"
      const parts = specifier.split('/');
      return parts.slice(0, 2).join('/');
    }
    // Regular: "lodash/fp" → "lodash"
    return specifier.split('/')[0];
  }

  private extractClauseSymbols(clauseNode: import('web-tree-sitter').SyntaxNode, out: string[]): void {
    for (const child of clauseNode.children) {
      switch (child.type) {
        case 'identifier':
          // default import: `import foo from '...'`
          out.push(child.text);
          break;
        case 'namespace_import':
          // `import * as foo` — record the local alias
          for (const nc of child.namedChildren) {
            if (nc.type === 'identifier') { out.push(nc.text); }
          }
          break;
        case 'named_imports': {
          // `{ isEqual, clamp as c }` — record exported (remote) name
          for (const spec of child.namedChildren) {
            if (spec.type === 'import_specifier') {
              // The first identifier child is the exported name
              const nameNode = spec.namedChildren[0];
              if (nameNode) { out.push(nameNode.text); }
            }
          }
          break;
        }
      }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

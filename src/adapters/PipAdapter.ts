import * as fs from 'fs';
import * as path from 'path';
import type { DeclaredDependency, PackageFootprint } from '../types/index';
import type { EcosystemAdapter } from './EcosystemAdapter';
import { parsePython, collectNodes } from '../stages/TreeSitterHelper';
import { computeDirSize } from '../stages/CacheInspector';

export class PipAdapter implements EcosystemAdapter {
  readonly ecosystem = 'pip' as const;

  constructor(private readonly wasmDir: string = '') {}

  async detect(workspaceRoot: string): Promise<boolean> {
    const candidates = ['requirements.txt', 'pyproject.toml'];
    for (const file of candidates) {
      try {
        await fs.promises.access(path.join(workspaceRoot, file));
        return true;
      } catch {
        // keep trying
      }
    }
    return false;
  }

  async parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]> {
    // Resolved versions from poetry.lock (best-effort)
    const resolvedVersions = await this.readLockfileVersions(workspaceRoot);

    const results: DeclaredDependency[] = [];
    const seen = new Set<string>();

    const add = (name: string, declaredVersion: string, isDev: boolean) => {
      // Normalise pip package names: lowercase, hyphens → underscores canonical form
      const canonical = name.toLowerCase().replace(/-/g, '_');
      if (seen.has(canonical)) { return; }
      seen.add(canonical);
      results.push({
        name,
        declaredVersion: resolvedVersions.get(canonical) ?? resolvedVersions.get(name) ?? declaredVersion,
        isDev,
      });
    };

    // --- requirements.txt ---
    const reqPath = path.join(workspaceRoot, 'requirements.txt');
    try {
      const raw = await fs.promises.readFile(reqPath, 'utf8');
      for (const entry of this.parseRequirementsTxt(raw)) {
        add(entry.name, entry.version, false);
      }
    } catch {
      // file may not exist
    }

    // --- pyproject.toml ---
    const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
    try {
      const raw = await fs.promises.readFile(pyprojectPath, 'utf8');
      for (const entry of this.parsePyprojectToml(raw)) {
        add(entry.name, entry.version, entry.isDev);
      }
    } catch {
      // file may not exist
    }

    return results;
  }

  /**
   * Parse a requirements.txt file.
   * Handles:
   *   - blank lines and # comments
   *   - version specifiers: ==, >=, <=, ~=, !=, <, >
   *   - optional extras: package[extra1,extra2]
   *   - -r includes and -c constraints are skipped
   */
  private parseRequirementsTxt(content: string): Array<{ name: string; version: string }> {
    const results: Array<{ name: string; version: string }> = [];
    for (const rawLine of content.split('\n')) {
      // Strip inline comment and whitespace
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line || line.startsWith('-')) { continue; }

      // Strip extras, e.g. "requests[security]"
      const withoutExtras = line.replace(/\[.*?\]/, '');

      // Split on first version specifier
      const specMatch = /^([A-Za-z0-9_.-]+)\s*((?:[><=!~]=?|~=)[^\s;]*)/.exec(withoutExtras);
      if (specMatch) {
        results.push({ name: specMatch[1], version: specMatch[2] });
      } else {
        // No version specifier — bare package name
        const nameMatch = /^([A-Za-z0-9_.-]+)/.exec(withoutExtras);
        if (nameMatch) {
          results.push({ name: nameMatch[1], version: '' });
        }
      }
    }
    return results;
  }

  /**
   * Parse [tool.poetry.dependencies] and [tool.poetry.dev-dependencies] /
   * [tool.poetry.group.dev.dependencies] blocks from a pyproject.toml.
   *
   * This is a minimal line-by-line parser — not a full TOML library.
   * It handles the simple key = "value" and key = {version = "..."} forms used by Poetry.
   */
  private parsePyprojectToml(
    content: string,
  ): Array<{ name: string; version: string; isDev: boolean }> {
    const results: Array<{ name: string; version: string; isDev: boolean }> = [];

    type Section = 'none' | 'deps' | 'dev_deps';
    let section: Section = 'none';

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();

      // Section headers
      if (line.startsWith('[')) {
        if (
          line === '[tool.poetry.dependencies]' ||
          line === '[tool.poetry.dependencies]' // duplicate guard for clarity
        ) {
          section = 'deps';
        } else if (
          line === '[tool.poetry.dev-dependencies]' ||
          line === '[tool.poetry.group.dev.dependencies]'
        ) {
          section = 'dev_deps';
        } else {
          section = 'none';
        }
        continue;
      }

      if (section === 'none') { continue; }
      if (!line || line.startsWith('#')) { continue; }

      // Skip "python = ..." — not a package
      if (/^python\s*=/.test(line)) { continue; }

      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) { continue; }

      const name = line.slice(0, eqIdx).trim();
      const valuePart = line.slice(eqIdx + 1).trim();

      // Extract version string from either:
      //   name = "^1.2.3"
      //   name = {version = "^1.2.3", ...}
      let version = '';
      const quoted = /^["']([^"']+)["']/.exec(valuePart);
      if (quoted) {
        version = quoted[1];
      } else {
        const inlineVersion = /version\s*=\s*["']([^"']+)["']/.exec(valuePart);
        if (inlineVersion) {
          version = inlineVersion[1];
        }
      }

      results.push({ name, version, isDev: section === 'dev_deps' });
    }

    return results;
  }

  /**
   * Parse poetry.lock for resolved versions.
   * Format uses TOML [[package]] blocks:
   *
   *   [[package]]
   *   name = "requests"
   *   version = "2.31.0"
   */
  private async readLockfileVersions(workspaceRoot: string): Promise<Map<string, string>> {
    const lockPath = path.join(workspaceRoot, 'poetry.lock');
    try {
      const raw = await fs.promises.readFile(lockPath, 'utf8');
      return this.parsePoetryLock(raw);
    } catch {
      return new Map<string, string>();
    }
  }

  private parsePoetryLock(content: string): Map<string, string> {
    const versions = new Map<string, string>();
    let currentName: string | null = null;
    let currentVersion: string | null = null;

    const flush = () => {
      if (currentName && currentVersion) {
        // Store both original and canonical form
        versions.set(currentName, currentVersion);
        versions.set(currentName.toLowerCase().replace(/-/g, '_'), currentVersion);
      }
      currentName = null;
      currentVersion = null;
    };

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line === '[[package]]') {
        flush();
        continue;
      }
      const nameMatch = /^name\s*=\s*["']([^"']+)["']/.exec(line);
      if (nameMatch) { currentName = nameMatch[1]; continue; }

      const versionMatch = /^version\s*=\s*["']([^"']+)["']/.exec(line);
      if (versionMatch) { currentVersion = versionMatch[1]; continue; }
    }
    flush(); // final block

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

    // Locate site-packages directory
    const sitePackages = await this.findSitePackages(workspaceRoot);
    if (!sitePackages) { return zeroStub(); }

    // Try both the original name and the normalised (hyphens → underscores) form
    const nameCandidates = [dep.name, dep.name.replace(/-/g, '_')];
    let pkgDir: string | null = null;
    for (const candidate of nameCandidates) {
      const p = path.join(sitePackages, candidate);
      const exists = await fs.promises.access(p).then(() => true).catch(() => false);
      if (exists) { pkgDir = p; break; }
    }
    if (!pkgDir) { return zeroStub(); }

    const { sizeKb, fileCount } = await computeDirSize(pkgDir);

    // Installed version and transitive count from .dist-info/METADATA
    let installedVersion = dep.declaredVersion;
    let transitiveCount = 0;

    const distInfoDir = await this.findDistInfo(sitePackages, dep.name);
    if (distInfoDir) {
      const metadataPath = path.join(distInfoDir, 'METADATA');
      try {
        const metadata = await fs.promises.readFile(metadataPath, 'utf8');
        for (const line of metadata.split('\n')) {
          if (line.startsWith('Version:')) {
            installedVersion = line.slice('Version:'.length).trim();
          } else if (line.startsWith('Requires-Dist:')) {
            transitiveCount++;
          }
        }
      } catch {
        // best-effort
      }
    }

    // Exported symbols from __init__.py
    const exportedSymbols = await this.extractPythonSymbols(pkgDir);

    return { name: dep.name, installedVersion, diskSizeKb: sizeKb, fileCount, transitiveCount, exportedSymbols };
  }

  /**
   * Locate the site-packages directory for the current environment.
   * Priority:
   *   1. <workspaceRoot>/.venv/lib/pythonX.Y/site-packages
   *   2. $VIRTUAL_ENV/lib/pythonX.Y/site-packages
   */
  private async findSitePackages(workspaceRoot: string): Promise<string | null> {
    const roots = [path.join(workspaceRoot, '.venv', 'lib')];
    const virtualEnv = process.env['VIRTUAL_ENV'];
    if (virtualEnv) {
      roots.unshift(path.join(virtualEnv, 'lib'));
    }

    for (const libDir of roots) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(libDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (/^python\d/.test(entry)) {
          const candidate = path.join(libDir, entry, 'site-packages');
          const exists = await fs.promises.access(candidate).then(() => true).catch(() => false);
          if (exists) { return candidate; }
        }
      }
    }
    return null;
  }

  /**
   * Find the .dist-info directory for a package in site-packages.
   * Matches <name>-<version>.dist-info, normalising hyphens/underscores.
   */
  private async findDistInfo(sitePackages: string, packageName: string): Promise<string | null> {
    const normalised = packageName.toLowerCase().replace(/[-_.]+/g, '_');
    let entries: string[];
    try {
      entries = await fs.promises.readdir(sitePackages);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.dist-info')) { continue; }
      const entryNorm = entry.toLowerCase().replace(/[-_.]+/g, '_');
      if (entryNorm.startsWith(normalised + '_') || entryNorm.startsWith(normalised + '-')) {
        return path.join(sitePackages, entry);
      }
    }
    return null;
  }

  private async extractPythonSymbols(pkgDir: string): Promise<string[]> {
    const initPath = path.join(pkgDir, '__init__.py');
    let content: string;
    try {
      content = await fs.promises.readFile(initPath, 'utf8');
    } catch {
      return [];
    }

    // Try to extract __all__ = [...] list
    const allMatch = /__all__\s*=\s*\[([^\]]+)\]/.exec(content);
    if (allMatch) {
      const symbols: string[] = [];
      const itemRe = /['"](\w+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = itemRe.exec(allMatch[1])) !== null) {
        symbols.push(m[1]);
      }
      return symbols;
    }

    // Fallback: scan top-level def and class declarations (non-private)
    const symbols: string[] = [];
    const seen = new Set<string>();
    const topLevelRe = /^(?:def|class)\s+([a-zA-Z]\w*)/;
    for (const line of content.split('\n')) {
      const m = topLevelRe.exec(line);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        symbols.push(m[1]);
      }
    }
    return symbols;
  }

  getSourceGlobs(): string[] {
    return ['**/*.py'];
  }

  /**
   * Parse a Python file and extract packageName → symbol names.
   *
   * Handles:
   *   from uuid import uuid4           → uuid, ['uuid4']
   *   from uuid import uuid4 as u4     → uuid, ['uuid4']
   *   import requests                  → requests, []
   *   import numpy as np               → numpy, []
   */
  async extractImports(fileText: string, _filePath: string, _exportedSymbolsMap?: Map<string, string[]>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!this.wasmDir) { return result; }

    let tree;
    try {
      tree = await parsePython(fileText, this.wasmDir);
    } catch {
      return result;
    }

    const importNodes = collectNodes(
      tree.rootNode,
      new Set(['import_from_statement', 'import_statement']),
    );

    for (const node of importNodes) {
      if (node.type === 'import_from_statement') {
        // from <module_name> import <names>
        // module_name is the first named child; its text may be "uuid" or "os.path"
        const moduleNode = node.namedChild(0);
        if (!moduleNode) { continue; }
        const packageName = moduleNode.text.split('.')[0];

        const symbols: string[] = [];
        for (const child of node.namedChildren.slice(1)) {
          // Each imported name is an `identifier` or `aliased_import`
          if (child.type === 'identifier') {
            symbols.push(child.text);
          } else if (child.type === 'aliased_import') {
            // `uuid4 as u4` — take the original name (first identifier)
            const nameNode = child.namedChild(0);
            if (nameNode) { symbols.push(nameNode.text); }
          }
        }

        if (!result.has(packageName)) { result.set(packageName, []); }
        const existing = result.get(packageName)!;
        for (const s of symbols) {
          if (!existing.includes(s)) { existing.push(s); }
        }
      } else if (node.type === 'import_statement') {
        // import requests  /  import numpy as np
        for (const child of node.namedChildren) {
          let pkgName: string;
          if (child.type === 'aliased_import') {
            const nameNode = child.namedChild(0);
            if (!nameNode) { continue; }
            pkgName = nameNode.text.split('.')[0];
          } else if (child.type === 'dotted_name' || child.type === 'identifier') {
            pkgName = child.text.split('.')[0];
          } else {
            continue;
          }
          if (!result.has(pkgName)) { result.set(pkgName, []); }
        }
      }
    }

    tree.delete();
    return result;
  }

  /** Count call-site occurrences of `symbolName` in Python source. */
  countCallSites(fileText: string, symbolName: string): number {
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\s*\\(`, 'g');
    return (fileText.match(pattern) ?? []).length;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

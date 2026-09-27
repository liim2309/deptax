import type { DeclaredDependency, PackageFootprint } from '../types/index';

export interface EcosystemAdapter {
  readonly ecosystem: 'npm' | 'pub' | 'pip';

  // Stage 1: does this workspace contain this ecosystem's manifest?
  detect(workspaceRoot: string): Promise<boolean>;

  // Stage 1: parse the manifest and lockfile
  parseManifest(workspaceRoot: string): Promise<DeclaredDependency[]>;

  // Stage 2: inspect local package cache for disk footprint + exported symbols
  inspectPackage(workspaceRoot: string, dep: DeclaredDependency): Promise<PackageFootprint>;

  // Stage 3: return the source file glob patterns to scan
  getSourceGlobs(): string[];

  // Stage 3: given a source file's text and its path, extract all import statements
  // Returns map of packageName → list of imported symbol names.
  // exportedSymbolsMap is provided so adapters can resolve bare wildcard imports
  // (e.g. `import 'package:supabase_flutter/…'`) by scanning the file text for
  // known exported identifiers from each package.
  extractImports(
    fileText: string,
    filePath: string,
    exportedSymbolsMap?: Map<string, string[]>,
  ): Promise<Map<string, string[]>>;

  // Stage 3: given a source file's text, count call-sites for a given symbol name
  countCallSites(fileText: string, symbolName: string): number;
}

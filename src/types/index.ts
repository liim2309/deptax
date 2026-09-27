export type Ecosystem = 'npm' | 'pub' | 'pip';

/**
 * - parasitic / bloated / healthy: imported at runtime and scored by utilization.
 * - unused:     a runtime dependency that no source file imports.
 * - tooling:    dev dependencies, type-only packages and CLI tools; not shipped code.
 * - unmeasured: the package could not be located or analysed.
 */
export type PackageStatus = 'parasitic' | 'bloated' | 'healthy' | 'unused' | 'tooling' | 'unmeasured';

/** A dependency as declared in the project manifest. */
export interface DeclaredDependency {
  name: string;
  declaredVersion: string;
  isDev: boolean;
  /** Optional features requested with the dependency (Python extras). */
  extras?: string[];
}

/** Location of an import statement in project source (0-based line numbers). */
export interface ImportSite {
  file: string;
  line: number;
  endLine: number;
}

/** One export of a package that project code uses. */
export interface UsedSymbol {
  /** Export name (`default` for a default export). */
  name: string;
  /** The import specifier it came through, e.g. `lodash/isEqual` or `numpy.linalg`. */
  module: string;
  /** References in value positions (calls, reads). */
  references: number;
  /** References in type positions only. */
  typeReferences: number;
  /** Argument counts of direct calls, used to check recipe preconditions. */
  callArities: number[];
  files: string[];
}

export interface PackageMetrics {
  /** Bytes installed for this package alone. */
  diskBytes: number;
  /** Bytes that removing the package would free (its exclusive dependency subtree). */
  retainedDiskBytes: number;
  /** Packages that would be removed together with this one. */
  exclusiveDependencies: string[];
  /** Dependencies of this package that other packages also need. */
  sharedDependencyCount: number;
  /** R: loadable code carried because of this package, in bytes. */
  codeBytes: number | null;
  /** K: the part of that code your imports need, in bytes. */
  usedCodeBytes: number | null;
  /** u = K / R. */
  utilization: number | null;
  /** Exports used versus exports offered by the modules you import. */
  exportCoverage: { used: number; total: number } | null;
}

export interface EvictionInfo {
  available: boolean;
  strategy: 'recipe' | null;
  /** Used symbols with a native replacement whose preconditions hold. */
  covered: string[];
  /** Used symbols without one. */
  uncovered: string[];
}

export interface ScoredPackage {
  packageName: string;
  ecosystem: Ecosystem;
  installedVersion: string | null;
  declaredVersion: string;
  isDev: boolean;
  status: PackageStatus;
  statusReason: string;
  metrics: PackageMetrics;
  usedSymbols: UsedSymbol[];
  importSites: ImportSite[];
  eviction: EvictionInfo;
  notes: string[];
}

export interface ReportSummary {
  byStatus: Record<PackageStatus, number>;
  /** Bytes of all installed packages in the dependency graph. */
  installedDiskBytes: number;
  /** Bytes of packages that no single direct dependency owns. */
  sharedDiskBytes: number;
  /** Sum of unused code across scored packages. */
  unusedCodeBytes: number;
}

/** The scan report written to `.deptax/deptax_report.json`. */
export interface DeptaxReport {
  schemaVersion: 2;
  projectName: string;
  ecosystems: Ecosystem[];
  scannedFiles: number;
  generatedAt: string;
  summary: ReportSummary;
  packages: ScoredPackage[];
  warnings: string[];
}

export interface EvictionRecipe {
  packageName: string;
  symbolName: string;
  /** Import specifiers + export names this recipe replaces, e.g. `['lodash', 'isEqual']`. */
  matches: Array<[string, string]>;
  nativeCode: string;
  nativeImportPath: string;
  outputFileName: string;
  /** Every call must use at most this many arguments, and the symbol may not be passed as a value. */
  maxArity?: number;
  /** Runtime requirement of the generated code, shown to the user. */
  requires?: string;
}

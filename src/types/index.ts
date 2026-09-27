// The parsed manifest entry for one package
export interface DeclaredDependency {
  name: string;
  declaredVersion: string;
  isDev: boolean;
}

// Result of Stage 2 cache inspection
export interface PackageFootprint {
  name: string;
  installedVersion: string;
  diskSizeKb: number;
  fileCount: number;
  transitiveCount: number;
  exportedSymbols: string[]; // list of exported API names
}

// One used symbol found by the AST scanner
export interface UsedSymbol {
  symbolName: string;
  callCount: number;
  files: string[];
}

// Full result per package after Stage 3
export interface PackageUsage {
  packageName: string;
  usedSymbols: UsedSymbol[];
}

// Final scored result per package (output of TaxEngine)
export interface ScoredPackage {
  packageName: string;
  installedVersion: string;
  diskSizeKb: number;
  transitiveCount: number;
  exportedSymbolCount: number;
  usedSymbols: UsedSymbol[];
  phi: number;          // Φ(P) raw footprint
  utilization: number;  // U(P)
  taxRatio: number;
  deptaxScore: number;
  status: 'healthy' | 'bloated' | 'parasitic';
  evictionAvailable: boolean;
  evictionStrategy: 'recipe' | 'ast_extract' | 'manual' | null;
}

// The full scan report (written to deptax_report.json)
export interface DeptaxReport {
  projectName: string;
  ecosystem: 'npm' | 'pub' | 'pip';
  scannedFiles: number;
  totalPackagesAudited: number;
  parasiticPackagesCount: number;
  packages: ScoredPackage[];
  generatedAt: string; // ISO timestamp
}

// Used by the RecipeRegistry (Sub-Task 6)
export interface EvictionRecipe {
  packageName: string;
  symbolName: string;
  nativeCode: string;         // the generated helper file content
  nativeImportPath: string;   // e.g. '../utils/native_helpers/is_equal'
  outputFileName: string;     // e.g. 'is_equal.ts'
}

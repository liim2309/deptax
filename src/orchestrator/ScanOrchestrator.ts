import * as path from 'path';
import { detectAdapters } from '../adapters/AdapterRegistry';
import { ASTScanner } from '../stages/ASTScanner';
import { TaxEngine } from '../stages/TaxEngine';
import { ReportCache } from '../cache/ReportCache';
import type { DeptaxReport, ScoredPackage } from '../types/index';

export class ScanOrchestrator {
  private readonly taxEngine = new TaxEngine();
  private readonly cache = new ReportCache();

  constructor(private readonly wasmDir: string) {}

  async run(workspaceRoot: string): Promise<DeptaxReport> {
    const adapters = await detectAdapters(workspaceRoot, this.wasmDir);

    if (adapters.length === 0) {
      const report: DeptaxReport = {
        projectName: path.basename(workspaceRoot),
        ecosystem: 'npm',
        scannedFiles: 0,
        totalPackagesAudited: 0,
        parasiticPackagesCount: 0,
        packages: [],
        generatedAt: new Date().toISOString(),
      };
      await this.cache.write(report, workspaceRoot);
      return report;
    }

    const allPackages: ScoredPackage[] = [];
    let totalScannedFiles = 0;

    for (const adapter of adapters) {
      try {
        // Stage 1: parse manifest
        const deps = await adapter.parseManifest(workspaceRoot);

        // Stage 2: inspect all packages in parallel
        const footprints = await Promise.all(
          deps.map((dep) => adapter.inspectPackage(workspaceRoot, dep)),
        );

        // Stage 3: AST scan — pass footprints so bare wildcard imports can be
        // resolved by scanning file text for known exported identifiers.
        const scanner = new ASTScanner(this.wasmDir);
        await scanner.initialize();
        const usageMap = await scanner.scanWorkspace(workspaceRoot, adapter, footprints);

        // Count scanned files (glob the same patterns used by the scanner)
        // We track it via the usageMap — each UsedSymbol contains file paths.
        const fileSet = new Set<string>();
        for (const usage of usageMap.values()) {
          for (const sym of usage.usedSymbols) {
            for (const f of sym.files) {
              fileSet.add(f);
            }
          }
        }
        totalScannedFiles += fileSet.size;

        // Stage 4: score every package
        for (let i = 0; i < deps.length; i++) {
          const dep = deps[i];
          const footprint = footprints[i];
          const usage = usageMap.get(dep.name);
          allPackages.push(this.taxEngine.score(footprint, usage, dep));
        }
      } catch (err) {
        console.error(`[DepTax] Error processing adapter "${adapter.ecosystem}":`, err);
      }
    }

    // Sort by deptaxScore descending
    allPackages.sort((a, b) => b.deptaxScore - a.deptaxScore);

    const ecosystemValue =
      adapters.length === 1
        ? adapters[0].ecosystem
        : (adapters.map((a) => a.ecosystem).join(',') as DeptaxReport['ecosystem']);

    const report: DeptaxReport = {
      projectName: path.basename(workspaceRoot),
      ecosystem: ecosystemValue,
      scannedFiles: totalScannedFiles,
      totalPackagesAudited: allPackages.length,
      parasiticPackagesCount: allPackages.filter((p) => p.status === 'parasitic').length,
      packages: allPackages,
      generatedAt: new Date().toISOString(),
    };

    await this.cache.write(report, workspaceRoot);
    return report;
  }
}

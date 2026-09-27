import * as path from 'path';
import { detectAdapters } from '../adapters/AdapterRegistry';
import { ReportCache } from '../cache/ReportCache';
import { STATUS_ORDER } from '../model/Classifier';
import { listProjectFiles } from '../stages/ProjectFiles';
import { evaluateEcosystem } from '../stages/TaxEngine';
import type { DeptaxReport, Ecosystem, PackageStatus, ScoredPackage } from '../types/index';

export class ScanOrchestrator {
  private readonly cache = new ReportCache();

  constructor(private readonly wasmDir: string) {}

  async run(workspaceRoot: string): Promise<DeptaxReport> {
    const adapters = await detectAdapters(workspaceRoot, this.wasmDir);
    const packages: ScoredPackage[] = [];
    const warnings: string[] = [];
    const ecosystems: Ecosystem[] = [];
    const scanned = new Set<string>();
    let installed = 0;
    let shared = 0;

    for (const adapter of adapters) {
      try {
        const sourceFiles = await listProjectFiles(workspaceRoot, (f) => adapter.isSourceFile(f), adapter.manifestFiles);
        const model = await adapter.load(workspaceRoot, sourceFiles);
        const result = await evaluateEcosystem(model, workspaceRoot);
        packages.push(...result.packages);
        warnings.push(...result.warnings);
        installed += result.installedDiskBytes;
        shared += result.sharedDiskBytes;
        for (const f of sourceFiles) { scanned.add(f); }
        ecosystems.push(adapter.ecosystem);
      } catch (err) {
        warnings.push(`${adapter.ecosystem}: scan failed — ${(err as Error).message}`);
        console.error(`[DepTax] Error processing adapter "${adapter.ecosystem}":`, err);
      }
    }

    packages.sort(comparePackages);
    const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<PackageStatus, number>;
    for (const p of packages) { byStatus[p.status]++; }

    const report: DeptaxReport = {
      schemaVersion: 2,
      projectName: path.basename(workspaceRoot),
      ecosystems,
      scannedFiles: scanned.size,
      generatedAt: new Date().toISOString(),
      summary: {
        byStatus,
        installedDiskBytes: installed,
        sharedDiskBytes: shared,
        unusedCodeBytes: packages.reduce((s, p) =>
          s + (p.metrics.codeBytes !== null && p.metrics.usedCodeBytes !== null
            ? p.metrics.codeBytes - p.metrics.usedCodeBytes : 0), 0),
      },
      packages,
      warnings,
    };
    await this.cache.write(report, workspaceRoot);
    return report;
  }
}

/** Most severe status first; within a status, the largest waste first. */
export function comparePackages(a: ScoredPackage, b: ScoredPackage): number {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (byStatus !== 0) { return byStatus; }
  return wasteOf(b) - wasteOf(a) || a.packageName.localeCompare(b.packageName);
}

function wasteOf(p: ScoredPackage): number {
  const m = p.metrics;
  if (m.codeBytes !== null && m.usedCodeBytes !== null) { return m.codeBytes - m.usedCodeBytes; }
  return m.retainedDiskBytes;
}

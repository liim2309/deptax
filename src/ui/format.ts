import { formatPercent } from '../model/Classifier';
import type { PackageStatus, ScoredPackage } from '../types/index';

export { formatPercent };

export function formatBytes(bytes: number | null): string {
  if (bytes === null) { return '–'; }
  if (bytes >= 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  if (bytes >= 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${Math.round(bytes)} B`;
}

export const STATUS_EMOJI: Record<PackageStatus, string> = {
  parasitic: '🔴',
  bloated: '🟡',
  unused: '⚪',
  healthy: '🟢',
  tooling: '🔧',
  unmeasured: '❔',
};

export const STATUS_LABEL: Record<PackageStatus, string> = {
  parasitic: 'Parasitic',
  bloated: 'Bloated',
  unused: 'Unused',
  healthy: 'Healthy',
  tooling: 'Tooling',
  unmeasured: 'Unmeasured',
};

/** One-line summary of what a package costs and how much of it is used. */
export function usageSummary(pkg: ScoredPackage): string {
  const m = pkg.metrics;
  if (m.utilization !== null && m.codeBytes !== null) {
    return `${formatPercent(m.utilization)} of ${formatBytes(m.codeBytes)} used`;
  }
  if (pkg.status === 'unused') { return `unused · frees ${formatBytes(m.retainedDiskBytes)}`; }
  return pkg.statusReason;
}

/** Diagnostic text for a flagged package. */
export function diagnosticMessage(pkg: ScoredPackage): string {
  const m = pkg.metrics;
  const freed = `Removing it would free ${formatBytes(m.retainedDiskBytes)}`
    + (m.exclusiveDependencies.length > 0 ? ` (with ${m.exclusiveDependencies.length} dependencies of its own).` : '.');
  if (pkg.status === 'unused') {
    return `DepTax: "${pkg.packageName}" is not imported by any source file. ${freed}`;
  }
  const used = m.usedCodeBytes !== null && m.codeBytes !== null && m.utilization !== null
    ? `your imports need ${formatBytes(m.usedCodeBytes)} of the ${formatBytes(m.codeBytes)} of code it brings in `
      + `(${formatPercent(m.utilization)}). `
    : '';
  const recipe = pkg.eviction.available ? ' A native replacement is available.' : '';
  return `DepTax ${STATUS_EMOJI[pkg.status]} "${pkg.packageName}" is ${pkg.status}: ${used}${freed}${recipe}`;
}

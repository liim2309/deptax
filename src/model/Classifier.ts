import type { PackageStatus } from '../types/index';

/**
 * Classification of a direct dependency P.
 *
 * Two measurements drive the verdict, both in bytes of loadable code and both
 * restricted to P's exclusive subtree (the packages that disappear with P):
 *
 *   R(P)  code you carry because of P  (everything reachable from the public
 *         entry points of those packages)
 *   K(P)  code your imports actually need (a tree-shaking style liveness
 *         analysis starting from your import statements)
 *
 *   u(P) = K / R   — fraction of the carried code you use (0..1, unit-free)
 *   W(P) = R − K   — dead code you carry, in bytes
 *
 * A package is flagged only when BOTH the fraction is low and the absolute
 * waste is material: a 3 KB helper used at 5% is not worth anyone's time, and a
 * 5 MB framework used at 60% is doing its job.
 *
 * The rules are monotone: for fixed R, increasing K never makes the verdict
 * worse (u rises and W falls).
 */

/** At most this fraction of the carried code is used → candidate for parasitic. */
export const UTILIZATION_PARASITIC = 0.10;
/** …and at least this much carried code is dead. */
export const DEAD_BYTES_PARASITIC = 100 * 1024;

/** At most this fraction of the carried code is used → candidate for bloated. */
export const UTILIZATION_BLOATED = 0.30;
/** …and at least this much carried code is dead. */
export const DEAD_BYTES_BLOATED = 25 * 1024;

export interface ClassificationInput {
  /** False when the package could not be located or measured. */
  measured: boolean;
  unmeasuredReason?: string;
  isDev: boolean;
  /** Type-declaration-only package, such as `@types/node`. */
  isTypesPackage: boolean;
  /** The package ships a command-line tool (npm `bin`, Python console scripts). */
  hasCli: boolean;
  /** Import statements that need the package at runtime. */
  runtimeImports: number;
  /** Import statements that only use types (erased at compile time). */
  typeOnlyImports: number;
  /** R(P), in bytes. */
  codeBytes: number;
  /** K(P), in bytes. */
  usedCodeBytes: number;
}

export interface Classification {
  status: PackageStatus;
  reason: string;
}

export function utilization(codeBytes: number, usedCodeBytes: number): number {
  if (codeBytes <= 0) { return 1; }
  return Math.min(1, Math.max(0, usedCodeBytes / codeBytes));
}

export function classify(input: ClassificationInput): Classification {
  if (!input.measured) {
    return { status: 'unmeasured', reason: input.unmeasuredReason ?? 'package could not be measured' };
  }

  if (input.isDev) {
    return { status: 'tooling', reason: 'development dependency; not part of the shipped code' };
  }
  if (input.isTypesPackage) {
    return { status: 'tooling', reason: 'type declarations only; erased at compile time' };
  }

  if (input.runtimeImports === 0) {
    if (input.typeOnlyImports > 0) {
      return { status: 'tooling', reason: 'imported for types only; no runtime code is used' };
    }
    if (input.hasCli) {
      return { status: 'tooling', reason: 'not imported by source code; provides a command-line tool' };
    }
    return { status: 'unused', reason: 'not imported by any source file' };
  }

  const u = utilization(input.codeBytes, input.usedCodeBytes);
  const dead = Math.max(0, input.codeBytes - input.usedCodeBytes);
  const pct = formatPercent(u);

  if (u <= UTILIZATION_PARASITIC && dead >= DEAD_BYTES_PARASITIC) {
    return { status: 'parasitic', reason: `uses ${pct} of the code it brings in` };
  }
  if (u <= UTILIZATION_BLOATED && dead >= DEAD_BYTES_BLOATED) {
    return { status: 'bloated', reason: `uses ${pct} of the code it brings in` };
  }
  return { status: 'healthy', reason: `uses ${pct} of the code it brings in` };
}

export function formatPercent(u: number): string {
  if (u > 0 && u < 0.01) { return '<1%'; }
  return `${Math.round(u * 100)}%`;
}

/** Severity order used for sorting reports (most severe first). */
export const STATUS_ORDER: readonly PackageStatus[] = [
  'parasitic', 'bloated', 'unused', 'healthy', 'tooling', 'unmeasured',
];

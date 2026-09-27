import type {
  DeclaredDependency,
  PackageFootprint,
  PackageUsage,
  ScoredPackage,
} from '../types/index';
import { lookup as recipeLookup } from '../recipes/RecipeRegistry';

// ─── Named scoring constants ────────────────────────────────────────────────

/** Transitive-dependency amplification factor for Φ(P). */
const LAMBDA_TRANS = 0.25;

/** DepTax scores below this threshold are classified as healthy. */
const THRESHOLD_HEALTHY = 25;

/** DepTax scores above this threshold are classified as parasitic. */
const THRESHOLD_BLOATED = 150;

// ────────────────────────────────────────────────────────────────────────────

export class TaxEngine {
  /**
   * Score a single package and return a fully populated `ScoredPackage`.
   *
   * Formulas (spec Section 2):
   *
   *   Φ(P) = diskSizeKb × (1 + λ_trans × transitiveCount)
   *   U(P) = Σ [ I(s) × ln(1 + C(s)) ]   for all used symbols s
   *            where I(s) = 1 if symbol s is imported, else 0
   *                  C(s) = call-site count for s
   *   TaxRatio    = Φ(P) / max(1, |usedSymbols|)
   *   DepTaxScore = Φ(P) / (U(P) + 0.1)
   *
   * Status thresholds:
   *   score < THRESHOLD_HEALTHY  → 'healthy'
   *   score ≤ THRESHOLD_BLOATED  → 'bloated'
   *   score > THRESHOLD_BLOATED  → 'parasitic'
   */
  score(
    footprint: PackageFootprint,
    usage: PackageUsage | undefined,
    dep: DeclaredDependency,
  ): ScoredPackage {
    const usedSymbols = usage?.usedSymbols ?? [];

    // Φ(P) — raw footprint weight
    const phi = footprint.diskSizeKb * (1 + LAMBDA_TRANS * footprint.transitiveCount);

    // U(P) — utilization score
    // Σ [ ln(1 + C(s)) ] for all symbols where I(s) = 1 (i.e. the symbol is
    // referenced in at least one file).
    let utilization = 0;
    for (const sym of usedSymbols) {
      // I(s) = 1 (symbol is imported), C(s) = callCount
      utilization += Math.log(1 + sym.callCount);
    }

    // Utilization floor: if the package is imported anywhere at all (i.e. we
    // have at least one UsedSymbol entry) but call-site counting returned zero
    // — which happens when symbol resolution fell back to identifier scanning
    // and found matches but countCallSites returned 0 — treat each matched
    // symbol as having at least 1 invocation so U(P) ≥ ln(2) per symbol.
    // This prevents packages like `supabase_flutter` (imported wholesale,
    // classes used by name) from scoring as if they had zero utility.
    if (utilization === 0 && usedSymbols.length > 0) {
      utilization = usedSymbols.length * Math.log(2); // ln(2) ≈ 0.693 per symbol
    }

    // Derived metrics
    const taxRatio = phi / Math.max(1, usedSymbols.length);
    const deptaxScore = phi / (utilization + 0.1);

    // Classification
    let status: ScoredPackage['status'];
    if (deptaxScore < THRESHOLD_HEALTHY) {
      status = 'healthy';
    } else if (deptaxScore <= THRESHOLD_BLOATED) {
      status = 'bloated';
    } else {
      status = 'parasitic';
    }

    // Recipe lookup
    const { evictionAvailable, evictionStrategy } = recipeLookup(
      footprint.name,
      usedSymbols,
    );

    return {
      packageName: footprint.name,
      installedVersion: footprint.installedVersion,
      diskSizeKb: footprint.diskSizeKb,
      transitiveCount: footprint.transitiveCount,
      exportedSymbolCount: footprint.exportedSymbols.length,
      usedSymbols,
      phi,
      utilization,
      taxRatio,
      deptaxScore,
      status,
      evictionAvailable,
      evictionStrategy,
    };
  }
}

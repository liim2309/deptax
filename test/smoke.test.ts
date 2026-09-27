/**
 * DepTax Smoke Test
 * Runs ScanOrchestrator against the test fixture project and asserts key outcomes.
 *
 * Run with: npx ts-node --project tsconfig.test.json test/smoke.test.ts
 */

import * as path from 'path';
import * as assert from 'assert';
import { ScanOrchestrator } from '../src/orchestrator/ScanOrchestrator';

// ── Paths ────────────────────────────────────────────────────────────────────

const wasmDir = path.join(__dirname, '../resources');
const fixtureRoot = path.join(__dirname, 'fixtures/ts-project');

// ── Helpers ──────────────────────────────────────────────────────────────────

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string, detail?: unknown): never {
  console.error(`  ✗ ${msg}`);
  if (detail !== undefined) { console.error('    detail:', detail); }
  process.exit(1);
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  assert.strictEqual(actual, expected);
  pass(`${label}: ${JSON.stringify(actual)}`);
}

function assertGt(label: string, actual: number, min: number): void {
  if (actual <= min) { fail(`${label}: expected > ${min}, got ${actual}`); }
  pass(`${label}: ${actual} > ${min}`);
}

function assertTrue(label: string, value: boolean): void {
  if (!value) { fail(`${label}: expected true, got false`); }
  pass(`${label}`);
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function runSmoke(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║       DepTax Smoke Test — Fixture Project      ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  console.log(`  wasmDir    : ${wasmDir}`);
  console.log(`  fixtureRoot: ${fixtureRoot}`);
  console.log('');

  // ── Run orchestrator ──────────────────────────────────────────────────────
  console.log('Running ScanOrchestrator...');
  const orchestrator = new ScanOrchestrator(wasmDir);
  let report;
  try {
    report = await orchestrator.run(fixtureRoot);
  } catch (err) {
    fail('orchestrator.run() threw an error', err);
  }

  // ── Report summary ────────────────────────────────────────────────────────
  console.log('\n── Report summary ────────────────────────────────');
  console.log(`  projectName          : ${report.projectName}`);
  console.log(`  ecosystem            : ${report.ecosystem}`);
  console.log(`  totalPackagesAudited : ${report.totalPackagesAudited}`);
  console.log(`  parasiticPackagesCount: ${report.parasiticPackagesCount}`);
  console.log(`  scannedFiles         : ${report.scannedFiles}`);
  console.log('');

  for (const pkg of report.packages) {
    console.log(`  [${pkg.packageName}@${pkg.installedVersion}]`);
    console.log(`    diskSizeKb       : ${pkg.diskSizeKb.toFixed(2)}`);
    console.log(`    exportedSymbols  : ${pkg.exportedSymbolCount}`);
    console.log(`    usedSymbols      : ${pkg.usedSymbols.map(s => `${s.symbolName}(×${s.callCount})`).join(', ') || '(none)'}`);
    console.log(`    phi (Φ)          : ${pkg.phi.toFixed(2)}`);
    console.log(`    utilization (U)  : ${pkg.utilization.toFixed(4)}`);
    console.log(`    deptaxScore      : ${pkg.deptaxScore.toFixed(2)}`);
    console.log(`    status           : ${pkg.status}`);
    console.log(`    evictionAvailable: ${pkg.evictionAvailable}`);
    console.log(`    evictionStrategy : ${pkg.evictionStrategy}`);
    console.log('');
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  console.log('── Assertions ────────────────────────────────────');

  assertGt('totalPackagesAudited', report.totalPackagesAudited, 1);

  // ── lodash ────────────────────────────────────────────────────────────────
  const lodash = report.packages.find(p => p.packageName === 'lodash');
  if (!lodash) { fail('lodash package not found in report'); }

  console.log('\n  [lodash]');
  assertEq('  status', lodash.status, 'parasitic');
  assertGt('  deptaxScore', lodash.deptaxScore, 100);
  assertTrue('  evictionAvailable', lodash.evictionAvailable);
  assertEq('  evictionStrategy', lodash.evictionStrategy, 'recipe');

  // ── uuid ─────────────────────────────────────────────────────────────────
  const uuid = report.packages.find(p => p.packageName === 'uuid');
  if (!uuid) { fail('uuid package not found in report'); }

  console.log('\n  [uuid]');
  assertTrue('  evictionAvailable', uuid.evictionAvailable);

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║              All assertions passed!            ║');
  console.log('╚════════════════════════════════════════════════╝\n');
}

runSmoke().catch(err => {
  console.error('[smoke test] Uncaught error:', err);
  process.exit(1);
});

/**
 * End-to-end smoke test: builds a small npm project in a temporary directory
 * and checks that every status, the dominator-based savings and the
 * K ≤ R invariant come out as intended.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanOrchestrator } from '../src/orchestrator/ScanOrchestrator';
import type { DeptaxReport, ScoredPackage } from '../src/types/index';
import { run, test } from './harness';

const wasmDir = path.join(__dirname, '../resources');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deptax-smoke-'));

function write(rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** `count` pure functions of about 1 KB each. */
function functions(prefix: string, count: number, exported: boolean): string {
  const body = `return ${JSON.stringify('x'.repeat(980))}.length;`;
  return Array.from({ length: count }, (_, i) => `${exported ? 'export ' : ''}function ${prefix}${i}() { ${body} }`).join('\n');
}

function pkg(name: string, json: Record<string, unknown>, files: Record<string, string>): void {
  write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', ...json }));
  for (const [f, c] of Object.entries(files)) { write(`node_modules/${name}/${f}`, c); }
}

// Project
write('package.json', JSON.stringify({
  name: 'smoke',
  dependencies: {
    lodash: '1.0.0', 'esm-lib': '1.0.0', tiny: '1.0.0', uuid: '1.0.0',
    'unused-lib': '1.0.0', 'cli-tool': '1.0.0', 'missing-lib': '1.0.0',
  },
  devDependencies: { 'dev-lib': '1.0.0', '@types/foo': '1.0.0' },
}));
write('src/app.ts', [
  "import { isEqual } from 'lodash';",
  "import { small } from 'esm-lib';",
  "import tiny from 'tiny';",
  "import { v4 as uuidv4 } from 'uuid';",
  '',
  'export const run = () => [isEqual(1, 2), small(), tiny(), uuidv4()];',
].join('\n'));
write('test/app.test.ts', "import { check } from 'dev-lib';\ncheck();\n");

// A UMD monolith next to a standalone per-function module (like lodash).
pkg('lodash', { main: 'lodash.js', dependencies: { 'mono-dep': '1.0.0' } }, {
  'lodash.js': `;(function () {\n${functions('fn', 200, false)}\nfunction isEqual(a, b) { return a === b; }\nmodule.exports = { isEqual };\n}.call(this));\n`,
  'isEqual.js': "var helper = require('./_helper');\nfunction isEqual(a, b) { return helper(a) === helper(b); }\nmodule.exports = isEqual;\n",
  '_helper.js': 'module.exports = function helper(x) { return x; };\n',
});
pkg('mono-dep', {}, { 'index.js': 'module.exports = 1;\n' });

// An ES module barrel with lots of unused code, and a dependency shared with `tiny`.
pkg('esm-lib', { exports: { '.': { import: './index.mjs', require: './index.cjs' } }, sideEffects: false, dependencies: { shared: '1.0.0' } }, {
  'index.mjs': "export { small } from './small.mjs';\nexport * from './big.mjs';\n",
  'small.mjs': "import { s } from 'shared';\nexport function small() { return s; }\n",
  'big.mjs': functions('big', 300, true),
  'index.cjs': functions('cjsCopy', 300, false),
});
pkg('shared', { main: 'index.js' }, { 'index.js': 'exports.s = 1;\n' });
pkg('tiny', { main: 'index.js', dependencies: { shared: '1.0.0' } }, {
  'index.js': "var s = require('shared').s;\nmodule.exports = function tiny() { return s; };\n",
});
pkg('uuid', { exports: { '.': { import: './index.mjs' } } }, {
  'index.mjs': 'export function v4() { return "id"; }\nexport function v1() { return "id1"; }\n',
});
pkg('unused-lib', { main: 'index.js' }, { 'index.js': functions('u', 50, false) });
pkg('cli-tool', { main: 'index.js', bin: { tool: 'cli.js' } }, { 'index.js': '', 'cli.js': '' });
pkg('dev-lib', { main: 'index.js' }, { 'index.js': 'exports.check = function () {};\n' });
pkg('@types/foo', { types: 'index.d.ts' }, { 'index.d.ts': 'export declare const foo: number;\n' });

let report: DeptaxReport;
const byName = (name: string): ScoredPackage => {
  const p = report.packages.find((x) => x.packageName === name);
  assert.ok(p, `${name} missing from report`);
  return p;
};

test('scan completes and writes the report', async () => {
  report = await new ScanOrchestrator(wasmDir).run(root);
  assert.strictEqual(report.schemaVersion, 2);
  assert.ok(fs.existsSync(path.join(root, '.deptax', 'deptax_report.json')));
  assert.strictEqual(report.packages.length, 9);
});

test('ES module barrel with one used export is parasitic', () => {
  const p = byName('esm-lib');
  assert.strictEqual(p.status, 'parasitic', p.statusReason);
  assert.ok(p.metrics.utilization! < 0.02, `u=${p.metrics.utilization}`);
  assert.ok(!p.metrics.exclusiveDependencies.includes('shared'), 'shared is also needed by tiny');
  assert.ok(p.metrics.codeBytes! < 400 * 1024, 'the CommonJS copy of the same code is not counted twice');
});

test('monolith is measured through its standalone module', () => {
  const p = byName('lodash');
  assert.ok(p.status === 'parasitic' || p.status === 'bloated', `${p.status}: ${p.statusReason}`);
  assert.ok(p.notes.some((n) => n.includes('isEqual.js')), p.notes.join(' | '));
  assert.deepStrictEqual(p.metrics.exclusiveDependencies, ['mono-dep']);
  assert.strictEqual(p.eviction.available, true);
});

test('aliased import counts references of the local name', () => {
  const p = byName('uuid');
  const v4 = p.usedSymbols.find((s) => s.name === 'v4');
  assert.ok(v4 && v4.references === 1, JSON.stringify(p.usedSymbols));
  assert.deepStrictEqual(v4.callArities, [0]);
  assert.strictEqual(p.eviction.available, true);
  assert.strictEqual(p.status, 'healthy');
});

test('every other status', () => {
  assert.strictEqual(byName('tiny').status, 'healthy');
  assert.strictEqual(byName('unused-lib').status, 'unused');
  assert.ok(byName('unused-lib').metrics.retainedDiskBytes > 40 * 1024);
  assert.strictEqual(byName('cli-tool').status, 'tooling');
  assert.strictEqual(byName('dev-lib').status, 'tooling');
  assert.strictEqual(byName('@types/foo').status, 'tooling');
  assert.strictEqual(byName('missing-lib').status, 'unmeasured');
});

test('import sites point at the import statements', () => {
  assert.deepStrictEqual(byName('esm-lib').importSites, [{ file: 'src/app.ts', line: 1, endLine: 1 }]);
});

test('invariants: 0 ≤ K ≤ R and u = K / R', () => {
  for (const p of report.packages) {
    const { codeBytes: R, usedCodeBytes: K, utilization: u } = p.metrics;
    if (R === null) { continue; }
    assert.ok(K !== null && K >= 0 && K <= R, `${p.packageName}: K=${K} R=${R}`);
    assert.ok(Math.abs(u! - (R === 0 ? 1 : K / R)) < 1e-9, `${p.packageName}: u`);
  }
  assert.ok(report.summary.sharedDiskBytes > 0);
});

void run('Smoke').finally(() => fs.rmSync(root, { recursive: true, force: true }));

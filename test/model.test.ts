import * as assert from 'assert';
import { computeDominators, dominatedSet } from '../src/model/Dominators';
import {
  classify,
  DEAD_BYTES_BLOATED,
  DEAD_BYTES_PARASITIC,
  STATUS_ORDER,
  UTILIZATION_BLOATED,
  UTILIZATION_PARASITIC,
  type ClassificationInput,
} from '../src/model/Classifier';
import { LivenessAnalysis, reachableModules, type ModuleProvider } from '../src/model/Liveness';
import { emptyModule, type ModuleInfo, type ModuleItem } from '../src/model/ModuleModel';
import { run, test } from './harness';

// ── Dominators ───────────────────────────────────────────────────────────────

const graph = (edges: Record<string, string[]>) => ({
  root: 'R',
  successors: new Map(Object.entries(edges)),
});

test('diamond: a package reached through two paths is owned by neither', () => {
  const dom = computeDominators(graph({ R: ['A'], A: ['B', 'C'], B: ['D'], C: ['D'] }));
  assert.strictEqual(dom.idom.get('D'), 'A');
  assert.deepStrictEqual([...dominatedSet(dom, 'B')], ['B']);
  assert.deepStrictEqual(new Set(dominatedSet(dom, 'A')), new Set(['A', 'B', 'C', 'D']));
});

test('shared dependency of two direct dependencies belongs to the root', () => {
  const dom = computeDominators(graph({ R: ['A', 'B'], A: ['S', 'X'], B: ['S'] }));
  assert.strictEqual(dom.idom.get('S'), 'R');
  assert.deepStrictEqual(new Set(dominatedSet(dom, 'A')), new Set(['A', 'X']));
});

test('cycles are handled', () => {
  const dom = computeDominators(graph({ R: ['A'], A: ['B'], B: ['C'], C: ['B', 'D'] }));
  assert.strictEqual(dom.idom.get('C'), 'B');
  assert.strictEqual(dom.idom.get('D'), 'C');
  assert.ok(!dom.idom.has('Z'));
});

test('a dependency also declared directly is not owned by its dependent', () => {
  const dom = computeDominators(graph({ R: ['A', 'B'], A: ['B'], B: ['C'] }));
  assert.strictEqual(dom.idom.get('B'), 'R');
  assert.deepStrictEqual(new Set(dominatedSet(dom, 'A')), new Set(['A']));
});

// ── Classifier ───────────────────────────────────────────────────────────────

const base: ClassificationInput = {
  measured: true, isDev: false, isTypesPackage: false, hasCli: false,
  runtimeImports: 1, typeOnlyImports: 0, codeBytes: 0, usedCodeBytes: 0,
};
const KB = 1024;

test('non-scored categories', () => {
  assert.strictEqual(classify({ ...base, measured: false }).status, 'unmeasured');
  assert.strictEqual(classify({ ...base, isDev: true, codeBytes: 10_000 * KB }).status, 'tooling');
  assert.strictEqual(classify({ ...base, isTypesPackage: true }).status, 'tooling');
  assert.strictEqual(classify({ ...base, runtimeImports: 0, typeOnlyImports: 2 }).status, 'tooling');
  assert.strictEqual(classify({ ...base, runtimeImports: 0, hasCli: true }).status, 'tooling');
  assert.strictEqual(classify({ ...base, runtimeImports: 0 }).status, 'unused');
});

test('both a low fraction and material waste are required to flag', () => {
  // 5% used but only 19 KB dead: not worth flagging.
  assert.strictEqual(classify({ ...base, codeBytes: 20 * KB, usedCodeBytes: 1 * KB }).status, 'healthy');
  // 5% used of 2 MB: parasitic.
  assert.strictEqual(classify({ ...base, codeBytes: 2048 * KB, usedCodeBytes: 102 * KB }).status, 'parasitic');
  // 20% used of 1 MB: bloated.
  assert.strictEqual(classify({ ...base, codeBytes: 1024 * KB, usedCodeBytes: 205 * KB }).status, 'bloated');
  // 60% used of 50 MB: healthy, the framework is doing its job.
  assert.strictEqual(classify({ ...base, codeBytes: 50 * 1024 * KB, usedCodeBytes: 30 * 1024 * KB }).status, 'healthy');
});

test('threshold boundaries are inclusive', () => {
  const R = 10 * 1024 * KB;
  assert.strictEqual(classify({ ...base, codeBytes: R, usedCodeBytes: R * UTILIZATION_PARASITIC }).status, 'parasitic');
  assert.strictEqual(classify({ ...base, codeBytes: R, usedCodeBytes: R * UTILIZATION_BLOATED }).status, 'bloated');
  assert.strictEqual(classify({ ...base, codeBytes: DEAD_BYTES_PARASITIC, usedCodeBytes: 0 }).status, 'parasitic');
  assert.strictEqual(classify({ ...base, codeBytes: DEAD_BYTES_BLOATED, usedCodeBytes: 0 }).status, 'bloated');
});

test('monotone: using more of a package never makes its verdict worse', () => {
  const severity = (s: string) => ['parasitic', 'bloated', 'healthy'].indexOf(s);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  for (let i = 0; i < 5000; i++) {
    const R = Math.floor(rand() * 20 * 1024 * KB);
    const k1 = Math.floor(rand() * R);
    const k2 = k1 + Math.floor(rand() * (R - k1));
    const s1 = classify({ ...base, codeBytes: R, usedCodeBytes: k1 }).status;
    const s2 = classify({ ...base, codeBytes: R, usedCodeBytes: k2 }).status;
    assert.ok(severity(s2) >= severity(s1), `R=${R} K=${k1}→${k2}: ${s1} → ${s2}`);
  }
});

test('status order covers every status', () => {
  assert.strictEqual(new Set(STATUS_ORDER).size, 6);
});

// ── Liveness ─────────────────────────────────────────────────────────────────

function item(declares: string[], size: number, refs: string[] = [], root = false, memberRefs: Array<[string, string[]]> = []): ModuleItem {
  return { declares, size, refs, memberRefs, root, loads: [] };
}

function provider(modules: Record<string, ModuleInfo>, sideEffectFree = false): ModuleProvider {
  return {
    analyze: async (f) => modules[f] ?? null,
    sideEffectFree: () => sideEffectFree,
    inScope: () => true,
  };
}

function esm(file: string, items: ModuleItem[], exported: string[], size?: number): ModuleInfo {
  const info = emptyModule([file], size ?? items.reduce((s, i) => s + i.size, 0), 'items');
  info.items = items;
  for (const e of exported) { info.localExports.set(e, e); }
  return info;
}

test('only referenced declarations are live', async () => {
  const mod = esm('a', [
    item(['used'], 100, ['helper']),
    item(['helper'], 50),
    item(['unused'], 850),
  ], ['used', 'unused']);
  const la = new LivenessAnalysis(provider({ a: mod }));
  la.request('a', new Set(['used']));
  await la.run();
  assert.strictEqual(la.liveFraction('a'), 0.15);
});

test('side effects are always live; pure declarations are not', async () => {
  const mod = esm('a', [item(['x'], 10), item([], 90, [], true)], ['x']);
  const la = new LivenessAnalysis(provider({ a: mod }));
  la.request('a', new Set());
  await la.run();
  assert.strictEqual(la.liveFraction('a'), 0.9);
});

test('barrel re-exports are followed by name only', async () => {
  const barrel = emptyModule(['index'], 20, 'items');
  barrel.items = [item([], 10), item([], 10)];
  barrel.reexports = [
    { kind: 'named', target: 'a', exported: 'a', imported: 'a', item: 0 },
    { kind: 'star', target: 'b', item: 1 },
  ];
  const a = esm('a', [item(['a'], 100)], ['a']);
  const b = esm('b', [item(['b'], 1000)], ['b']);
  const la = new LivenessAnalysis(provider({ index: barrel, a, b }, true));
  la.request('index', new Set(['a']));
  await la.run();
  assert.strictEqual(la.liveFraction('index'), 0.5);
  assert.strictEqual(la.liveFraction('a'), 1);
  assert.strictEqual(la.liveFraction('b'), 0, 'b.mjs must not be included');
});

test('star re-exports reach names in the target', async () => {
  const barrel = emptyModule(['index'], 0, 'items');
  barrel.reexports = [{ kind: 'star', target: 'b' }, { kind: 'star', target: 'c' }];
  const b = esm('b', [item(['b1'], 10), item(['b2'], 10)], ['b1', 'b2']);
  const c = esm('c', [item(['c1'], 10)], ['c1']);
  const la = new LivenessAnalysis(provider({ index: barrel, b, c }, true));
  la.request('index', new Set(['b2']));
  await la.run();
  assert.strictEqual(la.liveFraction('b'), 0.5);
  assert.strictEqual(la.liveFraction('c'), 0);
});

test('namespace bindings request exactly the accessed members', async () => {
  const user = esm('u', [item(['f'], 10, [], false, [['ns', ['x']]])], ['f']);
  user.bindings = [{ local: 'ns', target: 'lib', imported: '*' }];
  const lib = esm('lib', [item(['x'], 10), item(['y'], 30)], ['x', 'y']);
  const la = new LivenessAnalysis(provider({ u: user, lib }, true));
  la.request('u', new Set(['f']));
  await la.run();
  assert.strictEqual(la.liveFraction('lib'), 0.25);
});

test('CommonJS default import requests the whole module object', async () => {
  const cjs = esm('cjs', [item([], 10), item([], 30)], []);
  cjs.openExports = true;
  cjs.exportItems.set('a', [0]);
  cjs.exportItems.set('b', [1]);
  const la = new LivenessAnalysis(provider({ cjs }));
  la.request('cjs', new Set(['default']));
  await la.run();
  assert.strictEqual(la.liveFraction('cjs'), 1);
});

test('cyclic imports terminate', async () => {
  const a = esm('a', [item(['a'], 10, ['b'])], ['a']);
  a.bindings = [{ local: 'b', target: 'b', imported: 'b' }];
  const b = esm('b', [item(['b'], 10, ['a'])], ['b']);
  b.bindings = [{ local: 'a', target: 'a', imported: 'a' }];
  const la = new LivenessAnalysis(provider({ a, b }));
  la.request('a', new Set(['a']));
  await la.run();
  assert.strictEqual(la.liveFraction('a'), 1);
  assert.strictEqual(la.liveFraction('b'), 1);
});

test('used code is always within reachable code (K ⊆ R)', async () => {
  const mods: Record<string, ModuleInfo> = {
    index: Object.assign(emptyModule(['index'], 0, 'items'), {
      reexports: [{ kind: 'star' as const, target: 'x' }, { kind: 'named' as const, target: 'y', exported: 'y', imported: 'y' }],
    }),
    x: esm('x', [item(['x'], 10, ['z'])], ['x']),
    y: esm('y', [item(['y'], 10)], ['y']),
  };
  mods.x.bindings = [{ local: 'z', target: 'z', imported: 'z' }];
  mods.z = esm('z', [item(['z'], 10), item(['dead'], 10)], ['z', 'dead']);
  const p = provider(mods, true);
  const la = new LivenessAnalysis(p);
  la.request('index', new Set(['x']));
  await la.run();
  const view = await reachableModules(p, ['index']);
  for (const f of la.includedFiles()) { assert.ok(view.has(f), `${f} used but not reachable`); }
  assert.strictEqual(la.liveFraction('z'), 0.5);
});

void run('Model');

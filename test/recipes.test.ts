/**
 * Differential test of the Tier 1 `isEqual` recipe against lodash.isEqual:
 * hand-picked edge cases plus randomly generated pairs of related values.
 */
import * as assert from 'assert';
import * as ts from 'typescript';
import { IS_EQUAL_TS, lookup, recipeFor } from '../src/recipes/RecipeRegistry';
import type { UsedSymbol } from '../src/types/index';
import { run, test } from './harness';

const lodash = require('lodash') as { isEqual(a: unknown, b: unknown): boolean };

const compiled = ts.transpileModule(IS_EQUAL_TS, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const recipe: { isEqual(a: unknown, b: unknown): boolean } = { isEqual: () => false };
new Function('exports', compiled.outputText)(recipe);

function check(a: unknown, b: unknown, label: string): void {
  const expected = lodash.isEqual(a, b);
  const actual = recipe.isEqual(a, b);
  assert.strictEqual(actual, expected, `${label}: recipe=${actual} lodash=${expected}`);
}

class Point { constructor(public x = 0, public y = 0) {} }
const sym = Symbol('k');

test('edge cases match lodash', () => {
  const cyclicA: Record<string, unknown> = { v: 1 };
  cyclicA.self = cyclicA;
  const cyclicB: Record<string, unknown> = { v: 1 };
  cyclicB.self = cyclicB;
  const argsOf = function (..._xs: unknown[]) { return arguments; };

  const cases: Array<[unknown, unknown, string]> = [
    [NaN, NaN, 'NaN'], [0, -0, '+0/-0'], [1, '1', 'number vs string'], [null, undefined, 'null/undefined'],
    [new Date(1), new Date(1), 'equal dates'], [new Date(1), new Date(2), 'different dates'],
    [new Date(NaN), new Date(NaN), 'invalid dates'],
    [/a/g, /a/g, 'equal regexps'], [/a/g, /a/i, 'regexp flags'], [/a/, /b/, 'regexp source'],
    [new Number(1), new Number(1), 'boxed numbers'], [new String('a'), new String('b'), 'boxed strings'],
    [new Boolean(true), true, 'boxed vs primitive'],
    [new Map([['a', 1]]), new Map([['a', 1]]), 'equal maps'], [new Map([['a', 1]]), new Map([['b', 2]]), 'maps'],
    [new Map([[1, 'x'], [2, 'y']]), new Map([[2, 'y'], [1, 'x']]), 'map order'],
    [new Set([1, 2]), new Set([2, 1]), 'set order'], [new Set([1]), new Set([2]), 'sets'],
    [new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }, { a: 2 }]), 'sets of objects'],
    [new Uint8Array([1, 2]), new Uint8Array([1, 2]), 'typed arrays'], [new Uint8Array([1]), new Int8Array([1]), 'typed array kinds'],
    [new ArrayBuffer(2), new ArrayBuffer(2), 'array buffers'], [new ArrayBuffer(2), new ArrayBuffer(3), 'buffer sizes'],
    [new DataView(new ArrayBuffer(2)), new DataView(new ArrayBuffer(2)), 'data views'],
    [new Error('a'), new Error('a'), 'errors'], [new Error('a'), new TypeError('a'), 'error types'],
    [new Point(1, 2), new Point(1, 2), 'class instances'], [new Point(1, 2), { x: 1, y: 2 }, 'instance vs object'],
    [Object.create(null), {}, 'null prototype'], [{ [sym]: 1 }, { [sym]: 1 }, 'symbol keys'],
    [{ [sym]: 1 }, {}, 'missing symbol key'], [{ a: undefined }, { b: undefined }, 'undefined values'],
    [[1, [2, [3]]], [1, [2, [3]]], 'nested arrays'], [[1, 2], [2, 1], 'array order'],
    [[, 1], [undefined, 1], 'sparse array'], [argsOf(1, 2), argsOf(1, 2), 'arguments'],
    [argsOf(1), { 0: 1 }, 'arguments vs object'], [cyclicA, cyclicB, 'cycles'],
    [() => 1, () => 1, 'functions'], [Symbol('a'), Symbol('a'), 'symbols'],
    [Object(Symbol.iterator), Object(Symbol.iterator), 'boxed symbols'],
    [{ constructor: 1 }, { constructor: 1 }, 'own constructor key'],
    [Promise.resolve(1), Promise.resolve(1), 'promises'],
  ];
  for (const [a, b, label] of cases) { check(a, b, label); }
});

// ── Random pairs ─────────────────────────────────────────────────────────────

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

function gen(depth: number): unknown {
  const leaves = [0, -0, 1, NaN, 'a', 'b', '', true, false, null, undefined];
  if (depth <= 0 || rand() < 0.35) { return pick(leaves); }
  switch (Math.floor(rand() * 9)) {
    case 0: return Array.from({ length: Math.floor(rand() * 4) }, () => gen(depth - 1));
    case 1: case 2: {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 4); i++) { o[pick(['a', 'b', 'c', 'd'])] = gen(depth - 1); }
      return o;
    }
    case 3: return new Date(pick([0, 1, 1e12]));
    case 4: return new Map(Array.from({ length: Math.floor(rand() * 3) }, () => [pick(['x', 'y', 1]), gen(depth - 1)]));
    case 5: return new Set(Array.from({ length: Math.floor(rand() * 3) }, () => gen(depth - 1)));
    case 6: return new Point(Math.floor(rand() * 2), Math.floor(rand() * 2));
    case 7: return pick([/a/, /a/g, /b/]);
    default: return new Uint8Array(Array.from({ length: Math.floor(rand() * 3) }, () => Math.floor(rand() * 2)));
  }
}

/** Deep copy that keeps types, optionally changing one leaf. */
function copy(v: unknown, mutate: { left: boolean }): unknown {
  if (mutate.left && rand() < 0.15) { mutate.left = false; return gen(1); }
  if (Array.isArray(v)) { return v.map((x) => copy(x, mutate)); }
  if (v instanceof Date) { return new Date(v.getTime()); }
  if (v instanceof RegExp) { return new RegExp(v.source, v.flags); }
  if (v instanceof Map) { return new Map([...v].map(([k, x]) => [k, copy(x, mutate)])); }
  if (v instanceof Set) { return new Set([...v].map((x) => copy(x, mutate))); }
  if (v instanceof Point) { return new Point(v.x, v.y); }
  if (v instanceof Uint8Array) { return new Uint8Array(v); }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, mutate)]));
  }
  return v;
}

test('5000 random pairs match lodash', () => {
  let equalPairs = 0;
  for (let i = 0; i < 5000; i++) {
    const a = gen(4);
    const b = copy(a, { left: rand() < 0.5 });
    if (lodash.isEqual(a, b)) { equalPairs++; }
    check(a, b, `pair #${i}`);
  }
  assert.ok(equalPairs > 1000 && equalPairs < 4500, `pairs should mix equal and unequal (${equalPairs} equal)`);
});

// ── Eviction logic ───────────────────────────────────────────────────────────

const sym0 = (name: string, module: string, references = 1, callArities = [1]): UsedSymbol =>
  ({ name, module, references, typeReferences: 0, callArities, files: [] });

test('eviction requires every used symbol to be covered', () => {
  assert.strictEqual(lookup('lodash', [sym0('isEqual', 'lodash')], false).available, true);
  assert.strictEqual(lookup('lodash', [sym0('isEqual', 'lodash'), sym0('cloneDeep', 'lodash')], false).available, false);
  assert.strictEqual(lookup('lodash', [sym0('isEqual', 'lodash')], true).available, false, 'whole-module use');
  assert.strictEqual(lookup('lodash', [sym0('default', 'lodash/isEqual')], false).available, true);
});

test('uuid v4 recipe only applies to argument-free calls', () => {
  assert.ok(recipeFor('uuid', sym0('v4', 'uuid', 2, [0, 0])));
  assert.ok(!recipeFor('uuid', sym0('v4', 'uuid', 1, [1])), 'v4(options)');
  assert.ok(!recipeFor('uuid', sym0('v4', 'uuid', 2, [0])), 'passed as a value');
});

void run('Recipes');

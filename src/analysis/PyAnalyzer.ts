import { emptyModule, type ModuleInfo, type ModuleItem, type ModuleLoad, type NameSet } from '../model/ModuleModel';
import type { SyntaxNode } from '../stages/TreeSitterHelper';
import type { ProjectFileAnalysis, ProjectImport, SymbolUse } from './ProjectModel';

/**
 * Python analysis at declaration granularity, the same model as JavaScript:
 * `def` and `class` statements and assignments of side-effect-free values are
 * items that are needed only when referenced; any other top-level statement
 * runs on import and is a root. `from m import x` creates a binding, and a
 * module's globals are its exports.
 */

/** Resolves modules for the analyser; supplied by the pip adapter. */
export interface PyResolver {
  /** File of an absolute (`level` 0) or relative module, or null. */
  module(fromFile: string, dotted: string, level: number): string | null;
  /** Submodules of a package, for a package's `__init__.py`: name → file. */
  submodules(initFile: string): Array<[string, string]>;
  /** Code files of the package containing `file` (for `import_module("." + name)`). */
  packageFiles(file: string): string[];
}

const PURE_CALLS = new Set([
  'frozenset', 'tuple', 'dict', 'set', 'list', 'object', 'str', 'int', 'float', 'bool', 'bytes', 'range',
  'len', 'type', 'property', 'staticmethod', 'classmethod', 'TypeVar', 'ParamSpec', 'TypeVarTuple',
  'NewType', 'namedtuple', 'collections.namedtuple', 'NamedTuple', 'typing.NamedTuple', 'TypedDict',
  'typing.TypeVar', 're.compile', 'logging.getLogger', 'object.__new__', 'Enum', 'IntEnum',
]);

export function analyzePyModule(root: SyntaxNode, file: string, resolver: PyResolver): ModuleInfo {
  const info = emptyModule([file], root.endIndex, 'items');
  info.starSkipsDefault = false;
  const bound = new Set<string>();

  const bindImport = (node: SyntaxNode, target: ModuleItem | null) => {
    // Imports inside a root item or function become loads of that item; top-level ones become bindings.
    for (const imp of importsOf(node)) {
      if (imp.wildcard) {
        const t = resolver.module(file, imp.module, imp.level);
        if (target) { target.loads.push({ target: t, names: 'ALL' }); } else { info.reexports.push({ kind: 'star', target: t }); }
        continue;
      }
      for (const b of imp.bindings) {
        let t: string | null;
        let imported: string;
        if (b.isModule) {
          t = resolver.module(file, b.symbol, imp.level);
          imported = '*';
          if (!b.aliased && b.symbol.includes('.')) {
            // `import a.b.c` binds `a` and loads a.b.c.
            const full: ModuleLoad = { target: t, names: 'ALL' };
            if (target) { target.loads.push(full); } else { info.loads.push(full); }
            t = resolver.module(file, b.symbol.split('.')[0], imp.level);
          }
        } else {
          const sub = resolver.module(file, imp.module ? `${imp.module}.${b.symbol}` : b.symbol, imp.level);
          if (sub) {
            t = sub;
            imported = '*';
          } else {
            t = resolver.module(file, imp.module, imp.level);
            imported = b.symbol;
          }
        }
        if (target) {
          target.loads.push({ target: t, names: imported === '*' ? 'ALL' : new Set([imported]) });
          target.declares.push(b.local);
        } else {
          info.bindings.push({ local: b.local, target: t, imported });
          bound.add(b.local);
        }
      }
    }
  };

  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'import_statement':
      case 'import_from_statement':
        bindImport(node, null);
        continue;
      case 'future_import_statement':
      case 'comment':
        continue;
      case 'function_definition':
      case 'class_definition':
      case 'decorated_definition': {
        const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
        const name = def?.childForFieldName('name')?.text;
        pushItem(info, node, name ? [name] : [], false, resolver, file, bindImport);
        continue;
      }
      case 'expression_statement': {
        const expr = node.namedChildren[0];
        if (!expr || expr.type === 'string') { continue; } // docstring
        if (expr.type === 'assignment') {
          const left = expr.childForFieldName('left');
          const right = expr.childForFieldName('right');
          if (left && (left.type === 'identifier' || left.type === 'pattern_list' || left.type === 'tuple_pattern')) {
            const names = identifiersIn(left);
            if (names.includes('__all__')) { continue; }
            pushItem(info, node, names, !!right && !isPurePy(right), resolver, file, bindImport);
            continue;
          }
        }
        pushItem(info, node, [], true, resolver, file, bindImport);
        continue;
      }
      case 'if_statement': {
        const cond = node.childForFieldName('condition')?.text.replace(/\s+/g, ' ') ?? '';
        if (cond === 'TYPE_CHECKING' || cond === 'typing.TYPE_CHECKING') { continue; }
        if (/^__name__ == ["']__main__["']$/.test(cond)) { continue; }
        pushItem(info, node, declaredIn(node), true, resolver, file, bindImport);
        continue;
      }
      default:
        pushItem(info, node, declaredIn(node), true, resolver, file, bindImport);
    }
  }

  // A module's globals are its attributes: every declared or imported name is an export.
  for (const item of info.items) {
    for (const n of item.declares) { info.localExports.set(n, n); }
  }
  for (const n of bound) { info.localExports.set(n, n); }

  // `package.submodule` is reachable as an attribute of the package.
  if (/[\\/]__init__\.py$/.test(file)) {
    for (const [name, sub] of resolver.submodules(file)) {
      if (!info.localExports.has(name)) {
        info.reexports.push({ kind: 'named', target: sub, exported: name, imported: '*' });
      }
    }
  }
  return info;
}

function pushItem(
  info: ModuleInfo,
  node: SyntaxNode,
  declares: string[],
  root: boolean,
  resolver: PyResolver,
  file: string,
  bindImport: (node: SyntaxNode, target: ModuleItem) => void,
): void {
  const item: ModuleItem = { declares: [...declares], size: node.endIndex - node.startIndex, refs: [], memberRefs: [], root, loads: [] };
  const refs = new Set<string>();
  const members = new Map<string, Set<string>>();
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    switch (n.type) {
      case 'import_statement':
      case 'import_from_statement':
        bindImport(n, item);
        continue;
      case 'identifier':
        refs.add(n.text);
        continue;
      case 'attribute': {
        const obj = n.childForFieldName('object');
        const attr = n.childForFieldName('attribute');
        if (obj?.type === 'identifier' && attr) {
          const set = members.get(obj.text) ?? new Set<string>();
          set.add(attr.text);
          members.set(obj.text, set);
          continue;
        }
        if (obj) { stack.push(obj); }
        continue;
      }
      case 'keyword_argument': {
        const value = n.childForFieldName('value');
        if (value) { stack.push(value); }
        continue;
      }
      case 'call': {
        const fn = n.childForFieldName('function');
        const fnText = fn?.text ?? '';
        if (fnText === 'importlib.import_module' || fnText === 'import_module' || fnText === '__import__') {
          const arg = n.childForFieldName('arguments')?.namedChildren[0];
          const literal = pyStringValue(arg);
          if (literal !== null && !literal.startsWith('.')) {
            item.loads.push({ target: resolver.module(file, literal, 0), names: 'ALL' });
          } else if (arg && isPackageRelative(arg)) {
            // import_module("." + name, __package__) and friends can reach any module of this package.
            for (const f of resolver.packageFiles(file)) { item.loads.push({ target: f, names: 'ALL' }); }
          } else {
            info.dynamicLoads = true;
          }
        }
        break;
      }
      case 'string':
      case 'comment':
        continue;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) { stack.push(c); }
    }
  }
  item.refs = [...refs];
  item.memberRefs = [...members.entries()].map(([k, v]) => [k, [...v]]);
  info.items.push(item);
}

/** `"." + name`, f".{name}", `__name__ + "." + name`, f"{__name__}.{name}", `__package__ + …`. */
function isPackageRelative(arg: SyntaxNode): boolean {
  const text = arg.text.replace(/\s+/g, '');
  return /^(f?["']\.|__name__\+|__package__\+|f["']\{__name__\}|f["']\{__package__\})/.test(text);
}

function identifiersIn(node: SyntaxNode): string[] {
  const out: string[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'identifier') { out.push(n.text); continue; }
    for (const c of n.namedChildren) { stack.push(c); }
  }
  return out;
}

/** Names bound anywhere inside a compound statement (try/if/with blocks at module level). */
function declaredIn(node: SyntaxNode): string[] {
  const out = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'function_definition' || n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text;
      if (name) { out.add(name); }
      continue;
    }
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      if (left) { for (const id of identifiersIn(left)) { out.add(id); } }
    }
    for (const c of n.namedChildren) { stack.push(c); }
  }
  return [...out];
}

/** True when evaluating the expression at import time has no observable side effect. */
function isPurePy(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'identifier': case 'string': case 'integer': case 'float': case 'true': case 'false':
    case 'none': case 'lambda': case 'concatenated_string': case 'ellipsis': case 'comment':
      return node.type !== 'string' || !node.namedChildren.some((c) => c.type === 'interpolation' && !c.namedChildren.every(isPurePy));
    case 'tuple': case 'list': case 'set': case 'dictionary': case 'pair': case 'parenthesized_expression':
    case 'unary_operator': case 'binary_operator': case 'boolean_operator': case 'comparison_operator':
    case 'not_operator': case 'conditional_expression': case 'subscript': case 'slice': case 'expression_list':
    case 'type': case 'generic_type': case 'type_parameter':
      return node.namedChildren.every(isPurePy);
    case 'attribute': {
      const obj = node.childForFieldName('object');
      return !obj || isPurePy(obj);
    }
    case 'call': {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      if (!fn || !PURE_CALLS.has(fn.text)) { return false; }
      return !args || args.namedChildren.every((a) => isPurePy(a.type === 'keyword_argument' ? (a.childForFieldName('value') ?? a) : a));
    }
    default:
      return false;
  }
}

// ── Import statements ───────────────────────────────────────────────────────

interface PyImport {
  module: string;
  level: number;
  wildcard: boolean;
  bindings: Array<{ local: string; symbol: string; isModule: boolean; aliased: boolean }>;
}

function importsOf(n: SyntaxNode): PyImport[] {
  if (n.type === 'import_statement') {
    const out: PyImport[] = [];
    for (const c of n.namedChildren) {
      const dotted = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
      if (!dotted || dotted.type !== 'dotted_name') { continue; }
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : undefined;
      const module = dotted.text;
      out.push({
        module, level: 0, wildcard: false,
        bindings: [{ local: alias ?? module.split('.')[0], symbol: module, isModule: true, aliased: !!alias }],
      });
    }
    return out;
  }
  if (n.type === 'import_from_statement') {
    const moduleNode = n.childForFieldName('module_name');
    if (!moduleNode) { return []; }
    let level = 0;
    let module = moduleNode.text;
    if (moduleNode.type === 'relative_import') {
      level = moduleNode.namedChildren.find((c) => c.type === 'import_prefix')?.text.length ?? 0;
      module = moduleNode.namedChildren.find((c) => c.type === 'dotted_name')?.text ?? '';
    }
    const imp: PyImport = { module, level, wildcard: false, bindings: [] };
    for (const c of n.namedChildren) {
      if (c.startIndex === moduleNode.startIndex) { continue; }
      if (c.type === 'wildcard_import') { imp.wildcard = true; continue; }
      const nameNode = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
      if (!nameNode || nameNode.type !== 'dotted_name') { continue; }
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : undefined;
      imp.bindings.push({ local: alias ?? nameNode.text, symbol: nameNode.text, isModule: false, aliased: !!alias });
    }
    return [imp];
  }
  return [];
}

function pyStringValue(node: SyntaxNode | undefined): string | null {
  if (!node || node.type !== 'string') { return null; }
  if (node.namedChildren.some((c) => c.type === 'interpolation')) { return null; }
  const content = node.namedChildren.find((c) => c.type === 'string_content');
  return content ? content.text : node.text.replace(/^[rbuRBU]*(['"]{1,3})([\s\S]*)\1$/, '$2');
}

// ── Project files ───────────────────────────────────────────────────────────

/**
 * Usage analysis of a project Python file. For each import it records the
 * names the file needs from the imported module: the imported names for
 * `from m import a`, or the attributes accessed on the binding for
 * `import m` (every name once the binding escapes as a value).
 */
export function analyzePyProjectFile(root: SyntaxNode): ProjectFileAnalysis {
  const uses = new Map<string, { bare: number; arities: number[]; members: Map<string, SymbolUse> }>();
  const use = (name: string) => {
    let u = uses.get(name);
    if (!u) { u = { bare: 0, arities: [], members: new Map() }; uses.set(name, u); }
    return u;
  };

  interface Found { imp: PyImport; node: SyntaxNode; typeChecking: boolean }
  const found: Found[] = [];
  const dynamic: string[] = [];
  const stack: Array<[SyntaxNode, boolean]> = [[root, false]];
  while (stack.length > 0) {
    const [n, typeChecking] = stack.pop()!;
    if (n.type === 'import_statement' || n.type === 'import_from_statement') {
      for (const imp of importsOf(n)) { found.push({ imp, node: n, typeChecking }); }
      continue;
    }
    if (n.type === 'future_import_statement' || n.type === 'comment' || n.type === 'string') { continue; }
    if (n.type === 'attribute') {
      const obj = n.childForFieldName('object');
      const attr = n.childForFieldName('attribute');
      if (obj?.type === 'identifier' && attr) {
        const members = use(obj.text).members;
        let m = members.get(attr.text);
        if (!m) { m = { references: 0, typeReferences: 0, callArities: [] }; members.set(attr.text, m); }
        m.references++;
        const parent = n.parent;
        if (parent?.type === 'call' && parent.childForFieldName('function')?.startIndex === n.startIndex) {
          m.callArities.push(parent.childForFieldName('arguments')?.namedChildCount ?? 0);
        }
        continue;
      }
    }
    if (n.type === 'identifier') {
      const u = use(n.text);
      u.bare++;
      const parent = n.parent;
      if (parent?.type === 'call' && parent.childForFieldName('function')?.startIndex === n.startIndex) {
        u.arities.push(parent.childForFieldName('arguments')?.namedChildCount ?? 0);
      }
      continue;
    }
    if (n.type === 'keyword_argument') {
      const value = n.childForFieldName('value');
      if (value) { stack.push([value, typeChecking]); }
      continue;
    }
    if (n.type === 'call') {
      const fnText = n.childForFieldName('function')?.text ?? '';
      if (fnText === 'importlib.import_module' || fnText === 'import_module' || fnText === '__import__') {
        const lit = pyStringValue(n.childForFieldName('arguments')?.namedChildren[0]);
        if (lit !== null && !lit.startsWith('.')) { dynamic.push(lit); }
      }
    }
    if (n.type === 'if_statement') {
      const cond = n.childForFieldName('condition')?.text ?? '';
      if (cond === 'TYPE_CHECKING' || cond === 'typing.TYPE_CHECKING') {
        const consequence = n.childForFieldName('consequence');
        for (const c of n.namedChildren) {
          stack.push([c, typeChecking || (!!consequence && c.startIndex === consequence.startIndex)]);
        }
        continue;
      }
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) { stack.push([c, typeChecking]); }
    }
  }

  const namesThrough = (local: string): NameSet => {
    const u = uses.get(local);
    if (!u) { return new Set(); }
    if (u.bare > 0) { return 'ALL'; }
    return new Set(u.members.keys());
  };

  const imports: ProjectImport[] = [];
  for (const { imp, node, typeChecking } of found) {
    if (imp.level > 0) { continue; } // relative: project-local code
    const symbols = new Map<string, SymbolUse>();
    const memberNames = new Map<string, NameSet>();
    let names: Set<string> | 'ALL' = new Set<string>();

    if (imp.wildcard) {
      names = 'ALL';
      symbols.set('*', { references: 1, typeReferences: 0, callArities: [] });
    }
    for (const b of imp.bindings) {
      const u = uses.get(b.local);
      if (b.isModule) {
        // `import a.b.c` binds `a` but runs a.b.c; attribute chains below `a` are not tracked.
        const through = !b.aliased && b.symbol.includes('.') ? 'ALL' : namesThrough(b.local);
        for (const [m, s] of u?.members ?? []) { symbols.set(m, s); }
        if (!u || u.bare > 0 || u.members.size === 0) {
          symbols.set(b.aliased ? b.symbol : b.local, { references: u?.bare ?? 0, typeReferences: 0, callArities: u?.arities ?? [] });
        }
        if (names !== 'ALL') {
          if (through === 'ALL') { names = 'ALL'; } else { for (const n of through) { names.add(n); } }
        }
      } else {
        const refs = (u?.bare ?? 0) + [...(u?.members.values() ?? [])].reduce((s, m) => s + m.references, 0);
        symbols.set(b.symbol, { references: refs, typeReferences: 0, callArities: u?.arities ?? [] });
        memberNames.set(b.symbol, namesThrough(b.local));
        if (names !== 'ALL') { names.add(b.symbol); }
      }
    }
    imports.push({
      specifier: imp.module,
      kind: 'import',
      line: node.startPosition.row,
      endLine: node.endPosition.row,
      runtime: !typeChecking,
      names: typeChecking ? new Set() : names,
      symbols,
      memberNames,
    });
  }
  for (const m of dynamic) {
    imports.push({ specifier: m, kind: 'dynamic', line: 0, endLine: 0, runtime: true, names: 'ALL', symbols: new Map() });
  }
  return { imports, hasJsx: false, parseErrors: root.hasError };
}

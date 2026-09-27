import * as path from 'path';
import {
  emptyModule,
  type ImportBinding,
  type ModuleInfo,
  type ModuleItem,
  type ModuleLoad,
  type NameSet,
  NO_NAMES,
} from '../model/ModuleModel';
import { hasToken, stringLiteralValue, type SyntaxNode } from '../stages/TreeSitterHelper';

/** Resolves a specifier from the module being analysed. */
export type JsResolve = (specifier: string, kind: 'import' | 'require') => string | null | 'builtin';

/**
 * Declaration-level analysis of a JavaScript/TypeScript module inside a package.
 *
 * Every top-level statement becomes an item. Declarations whose initialisers
 * have no side effects (functions, classes, literals, `/*#__PURE__*\/` calls…)
 * are live only when referenced; every other statement is a root that runs
 * when the module loads. ES module syntax and the CommonJS export forms emitted
 * by TypeScript, Babel and esbuild are recognised, so bundled and compiled
 * packages can be analysed below file level.
 */
/** Code files whose path starts with an absolute prefix (for `require('./locale/' + name)`). */
export type JsContext = (absolutePrefix: string) => string[];

export function analyzeJsModule(root: SyntaxNode, file: string, resolve: JsResolve, context?: JsContext): ModuleInfo {
  return new JsModuleBuilder(file, root.endIndex, resolve, context).build(root);
}

const TYPE_ONLY_STATEMENTS = new Set([
  'interface_declaration', 'type_alias_declaration', 'ambient_declaration',
  'abstract_class_declaration_signature', 'function_signature',
]);

const TYPE_CONTEXT_NODES = new Set([
  'type_annotation', 'type_arguments', 'type_parameters', 'type_alias_declaration',
  'interface_declaration', 'implements_clause', 'type_query', 'ambient_declaration',
  'opting_type_annotation', 'omitting_type_annotation', 'adding_type_annotation',
  'asserts_annotation', 'type_predicate_annotation',
]);

class JsModuleBuilder {
  private readonly info: ModuleInfo;
  private readonly requireBindings = new Map<string, string | null>();

  constructor(
    private readonly file: string,
    size: number,
    private readonly resolve: JsResolve,
    private readonly context?: JsContext,
  ) {
    this.info = emptyModule([file], size, 'items');
  }

  build(root: SyntaxNode): ModuleInfo {
    for (const node of root.namedChildren) {
      this.statement(node);
    }
    return this.info;
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  private target(specifier: string, kind: 'import' | 'require'): string | null | 'builtin' {
    const resolved = this.resolve(specifier, kind);
    if (resolved === null) { this.info.unresolved.push(specifier); }
    return resolved;
  }

  private load(specifier: string, kind: 'import' | 'require', names: NameSet): ModuleLoad | null {
    const t = this.target(specifier, kind);
    if (t === 'builtin') { return null; }
    return { target: t, names };
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  private addItem(node: SyntaxNode, declares: string[], root: boolean, body: SyntaxNode | null = node): number {
    const item: ModuleItem = { declares, size: node.endIndex - node.startIndex, refs: [], memberRefs: [], root, loads: [] };
    if (body) { this.collect(body, item); }
    this.info.items.push(item);
    return this.info.items.length - 1;
  }

  private exportItem(name: string, index: number): void {
    const list = this.info.exportItems.get(name);
    if (list) { list.push(index); } else { this.info.exportItems.set(name, [index]); }
  }

  /** Gather references, member accesses and loads below `node`. */
  private collect(node: SyntaxNode, item: ModuleItem): void {
    const refs = new Set<string>(item.refs);
    const members = new Map<string, Set<string>>(item.memberRefs.map(([k, v]) => [k, new Set(v)]));
    const stack: SyntaxNode[] = [node];

    while (stack.length > 0) {
      const n = stack.pop()!;
      switch (n.type) {
        case 'identifier':
        case 'shorthand_property_identifier':
          refs.add(n.text);
          continue;
        case 'member_expression': {
          const obj = n.childForFieldName('object');
          const prop = n.childForFieldName('property');
          if (obj?.type === 'identifier' && prop?.type === 'property_identifier') {
            const set = members.get(obj.text) ?? new Set<string>();
            set.add(prop.text);
            members.set(obj.text, set);
            continue;
          }
          break;
        }
        case 'call_expression': {
          const fn = n.childForFieldName('function');
          const args = n.childForFieldName('arguments');
          const isRequire = fn?.type === 'identifier' && fn.text === 'require';
          if (fn && (isRequire || fn.type === 'import')) {
            const spec = stringLiteralValue(args?.namedChild(0));
            if (spec !== null) {
              const l = this.load(spec, isRequire ? 'require' : 'import', isRequire ? requireNames(n) : 'ALL');
              if (l) { item.loads.push(l); }
            } else {
              // A computed name with a static relative prefix can only reach files under it,
              // like a bundler's context module; anything else is unknowable.
              const prefix = staticPrefix(args?.namedChild(0));
              if (prefix && /^\.\.?\//.test(prefix) && this.context) {
                const abs = path.resolve(path.dirname(this.file), prefix) + (prefix.endsWith('/') ? path.sep : '');
                for (const f of this.context(abs)) { item.loads.push({ target: f, names: 'ALL' }); }
              } else {
                this.info.dynamicLoads = true;
              }
              if (args) { stack.push(args); }
            }
            continue;
          }
          break;
        }
        case 'string':
        case 'number':
        case 'regex':
        case 'comment':
        case 'property_identifier':
        case 'statement_identifier':
        case 'type_identifier':
          continue;
        default:
          if (TYPE_CONTEXT_NODES.has(n.type)) { continue; }
      }
      for (let i = n.namedChildCount - 1; i >= 0; i--) {
        const c = n.namedChild(i);
        if (c) { stack.push(c); }
      }
    }

    item.refs = [...refs];
    item.memberRefs = [...members.entries()].map(([k, v]) => [k, [...v]]);
  }

  // ── Statements ────────────────────────────────────────────────────────────

  private statement(node: SyntaxNode): void {
    switch (node.type) {
      case 'import_statement':
        this.importStatement(node);
        return;
      case 'export_statement':
        this.exportStatement(node);
        return;
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text;
        this.addItem(node, name ? [name] : [], !isPureDeclaration(node));
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        this.variableDeclaration(node, false);
        return;
      case 'expression_statement':
        this.expressionStatement(node);
        return;
      case 'comment':
      case 'empty_statement':
      case 'hash_bang_line':
        return;
      default:
        if (TYPE_ONLY_STATEMENTS.has(node.type)) { return; }
        this.addItem(node, [], true);
    }
  }

  private importStatement(node: SyntaxNode): void {
    if (hasToken(node, 'type')) { return; }
    const requireClause = node.namedChildren.find((c) => c.type === 'import_require_clause');
    if (requireClause) {
      // import x = require('y')
      const local = requireClause.namedChildren.find((c) => c.type === 'identifier')?.text;
      const spec = stringLiteralValue(requireClause.childForFieldName('source'));
      if (local && spec !== null) {
        const t = this.target(spec, 'require');
        if (t !== 'builtin') { this.info.bindings.push({ local, target: t, imported: '*' }); }
      }
      return;
    }

    const spec = stringLiteralValue(node.childForFieldName('source'));
    if (spec === null) { return; }
    const t = this.target(spec, 'import');
    if (t === 'builtin') { return; }

    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) {
      this.info.loads.push({ target: t, names: NO_NAMES });
      return;
    }
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') {
        this.info.bindings.push({ local: c.text, target: t, imported: 'default' });
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) { this.info.bindings.push({ local: id.text, target: t, imported: '*' }); }
      } else if (c.type === 'named_imports') {
        for (const spec of c.namedChildren) {
          if (spec.type !== 'import_specifier' || hasToken(spec, 'type')) { continue; }
          const name = spec.childForFieldName('name');
          const alias = spec.childForFieldName('alias');
          if (!name) { continue; }
          const imported = name.type === 'string' ? name.text.slice(1, -1) : name.text;
          this.info.bindings.push({ local: alias?.text ?? imported, target: t, imported });
        }
      }
    }
  }

  private exportStatement(node: SyntaxNode): void {
    if (hasToken(node, 'type')) { return; }
    const isDefault = hasToken(node, 'default');
    const source = node.childForFieldName('source');

    if (source) {
      const spec = stringLiteralValue(source);
      if (spec === null) { return; }
      const t = this.target(spec, 'import');
      if (t === 'builtin') { return; }
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      const nsExport = node.namedChildren.find((c) => c.type === 'namespace_export');
      // The statement text is dead weight unless one of its re-exports is used.
      const item = this.addItem(node, [], false, null);
      if (clause) {
        for (const s of clause.namedChildren) {
          if (s.type !== 'export_specifier' || hasToken(s, 'type')) { continue; }
          const name = s.childForFieldName('name')?.text;
          if (!name) { continue; }
          const exported = s.childForFieldName('alias')?.text ?? name;
          this.info.reexports.push({ kind: 'named', target: t, exported, imported: name, item });
        }
      } else if (nsExport) {
        const exported = nsExport.namedChildren[0]?.text;
        if (exported) { this.info.reexports.push({ kind: 'named', target: t, exported, imported: '*', item }); }
      } else {
        this.info.reexports.push({ kind: 'star', target: t, item });
      }
      return;
    }

    const declaration = node.childForFieldName('declaration');
    if (declaration) {
      if (TYPE_ONLY_STATEMENTS.has(declaration.type)) { return; }
      if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
        this.variableDeclaration(declaration, true, node);
        return;
      }
      const name = declaration.childForFieldName('name')?.text;
      const idx = this.addItem(node, name ? [name] : [], !isPureDeclaration(declaration), declaration);
      if (isDefault) {
        if (name) { this.info.localExports.set('default', name); } else { this.exportItem('default', idx); }
      } else if (name) {
        this.info.localExports.set(name, name);
      }
      return;
    }

    const value = node.childForFieldName('value');
    if (value) {
      // export default <expression>
      if (value.type === 'identifier') {
        this.info.localExports.set('default', value.text);
      } else {
        this.exportItem('default', this.addItem(node, [], !isPure(value), value));
      }
      return;
    }

    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      for (const s of clause.namedChildren) {
        if (s.type !== 'export_specifier' || hasToken(s, 'type')) { continue; }
        const local = s.childForFieldName('name')?.text;
        if (!local) { continue; }
        this.info.localExports.set(s.childForFieldName('alias')?.text ?? local, local);
      }
      return;
    }

    // TypeScript `export = x`
    const assigned = node.namedChildren[0];
    if (assigned && hasToken(node, '=')) {
      this.info.openExports = true;
      if (assigned.type === 'identifier') {
        this.info.localExports.set('default', assigned.text);
      } else {
        this.exportItem('default', this.addItem(node, [], !isPure(assigned), assigned));
      }
    }
  }

  private variableDeclaration(node: SyntaxNode, exported: boolean, outer: SyntaxNode = node): void {
    const declarators = node.namedChildren.filter((c) => c.type === 'variable_declarator');
    for (const d of declarators) {
      const nameNode = d.childForFieldName('name');
      const value = d.childForFieldName('value');
      if (!nameNode) { continue; }

      // CommonJS require bindings behave like import declarations.
      const required = value ? requiredModule(value) : null;
      if (required !== null && !exported) {
        const t = this.target(required, 'require');
        if (t !== 'builtin') {
          for (const b of patternBindings(nameNode, t)) {
            this.info.bindings.push(b);
            if (b.imported === '*') { this.requireBindings.set(b.local, t); }
          }
        }
        continue;
      }

      const declares = patternNames(nameNode);
      const sizeNode = declarators.length === 1 ? outer : d;
      const item: ModuleItem = {
        declares,
        size: sizeNode.endIndex - sizeNode.startIndex,
        refs: [],
        memberRefs: [],
        root: value ? !isPure(value) : false,
        loads: [],
      };
      if (value) { this.collect(value, item); }
      // Default values inside destructuring patterns can reference names too.
      if (nameNode.type !== 'identifier') { this.collect(nameNode, item); }
      this.info.items.push(item);
      if (exported) {
        for (const n of declares) { this.info.localExports.set(n, n); }
      }
    }
  }

  private expressionStatement(node: SyntaxNode): void {
    const expr = node.namedChildren[0];
    if (!expr) { return; }
    if (expr.type === 'string') { return; } // 'use strict'

    if (expr.type === 'assignment_expression' && this.commonJsAssignment(node, expr)) { return; }
    if (expr.type === 'call_expression' && this.commonJsCall(node, expr)) { return; }
    this.addItem(node, [], true);
  }

  /** `module.exports = …`, `exports.x = …`, `module.exports.x = …`. */
  private commonJsAssignment(stmt: SyntaxNode, expr: SyntaxNode): boolean {
    // Unwrap chains such as `exports.a = exports.b = void 0`.
    const targets: string[] = [];
    let current: SyntaxNode | null = expr;
    let right: SyntaxNode | null = null;
    while (current && current.type === 'assignment_expression') {
      const name = exportTargetName(current.childForFieldName('left'));
      if (name === null) { return targets.length > 0 ? this.finishChain(stmt, targets, current) : false; }
      targets.push(name);
      right = current.childForFieldName('right');
      current = right;
    }
    if (!right) { return false; }
    return this.finishChain(stmt, targets, right);
  }

  private finishChain(stmt: SyntaxNode, targets: string[], right: SyntaxNode): boolean {
    this.info.openExports = true;
    const initialisation = right.type === 'unary_expression' && right.text.replace(/\s+/g, ' ') === 'void 0';

    for (const target of targets) {
      if (target === '<module>') {
        this.info.openExports = true;
        const required = requiredModule(right);
        if (required !== null) {
          const t = this.target(required, 'require');
          if (t !== 'builtin') { this.info.reexports.push({ kind: 'star', target: t }); }
          continue;
        }
        if (right.type === 'object') {
          this.objectExports(right);
          continue;
        }
        if (right.type === 'identifier') {
          this.info.localExports.set('default', right.text);
          continue;
        }
        this.exportItem('default', this.addItem(stmt, [], !isPure(right), right));
        continue;
      }
      if (initialisation) {
        this.exportItem(target, this.addItem(stmt, [], false, null));
        continue;
      }
      if (right.type === 'identifier') {
        this.info.localExports.set(target, right.text);
        continue;
      }
      this.exportItem(target, this.addItem(stmt, [], !isPure(right), right));
    }
    return true;
  }

  /** `module.exports = { a, b: c, d() {} }` */
  private objectExports(obj: SyntaxNode): void {
    for (const member of obj.namedChildren) {
      if (member.type === 'shorthand_property_identifier') {
        this.info.localExports.set(member.text, member.text);
      } else if (member.type === 'pair') {
        const key = propertyKey(member.childForFieldName('key'));
        const value = member.childForFieldName('value');
        if (key === null || !value) { this.addItem(member, [], true); continue; }
        if (value.type === 'identifier') {
          this.info.localExports.set(key, value.text);
        } else {
          this.exportItem(key, this.addItem(member, [], !isPure(value), value));
        }
      } else if (member.type === 'method_definition') {
        const key = propertyKey(member.childForFieldName('name'));
        const idx = this.addItem(member, [], false);
        if (key !== null) { this.exportItem(key, idx); }
      } else {
        this.addItem(member, [], true);
      }
    }
  }

  /** `Object.defineProperty(exports, 'x', …)`, `__exportStar(require('./y'), exports)`, esbuild `__export(target, {…})`. */
  private commonJsCall(stmt: SyntaxNode, call: SyntaxNode): boolean {
    const fn = call.childForFieldName('function');
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (!fn) { return false; }
    const fnText = fn.type === 'identifier' ? fn.text
      : fn.type === 'member_expression' ? (fn.childForFieldName('property')?.text ?? '') : '';

    if (fn.type === 'member_expression' && fn.text === 'Object.defineProperty' && args.length >= 3) {
      if (exportTargetName(args[0]) === '<module>' || args[0].text === 'exports') {
        const key = stringLiteralValue(args[1]);
        if (key !== null) {
          this.info.openExports = true;
          this.exportItem(key, this.addItem(stmt, [], false, args[2]));
          return true;
        }
      }
      return false;
    }

    if (/exportStar$|^_export_star$/.test(fnText) || (fnText === '__export' && args.length === 1)) {
      this.info.openExports = true;
      const first = args[0];
      const required = first ? requiredModule(first) : null;
      if (required !== null) {
        const t = this.target(required, 'require');
        if (t !== 'builtin') { this.info.reexports.push({ kind: 'star', target: t }); }
        return true;
      }
      if (first?.type === 'identifier' && this.requireBindings.has(first.text)) {
        this.info.reexports.push({ kind: 'star', target: this.requireBindings.get(first.text)! });
        return true;
      }
      return false;
    }

    if (fnText === '__export' && args.length === 2 && args[1].type === 'object') {
      // esbuild: __export(target, { name: () => local, … })
      this.info.openExports = true;
      for (const member of args[1].namedChildren) {
        if (member.type !== 'pair') { continue; }
        const key = propertyKey(member.childForFieldName('key'));
        const value = member.childForFieldName('value');
        if (key === null || !value) { continue; }
        this.exportItem(key, this.addItem(member, [], false, value));
      }
      return true;
    }
    return false;
  }
}

// ── Expression helpers ──────────────────────────────────────────────────────

/** Leading string literal of `'./x/' + name` or `` `./x/${name}` ``, or null. */
function staticPrefix(node: SyntaxNode | null | undefined): string | null {
  if (!node) { return null; }
  if (node.type === 'binary_expression' && hasToken(node, '+')) {
    return staticPrefix(node.childForFieldName('left'));
  }
  if (node.type === 'string') { return node.text.slice(1, -1); }
  if (node.type === 'template_string') {
    const text = node.text;
    const cut = text.indexOf('${');
    return cut > 1 ? text.slice(1, cut) : null;
  }
  if (node.type === 'parenthesized_expression') { return staticPrefix(node.namedChildren[0]); }
  return null;
}

/** Names requested from `require(x)` based on how its result is used. */
function requireNames(call: SyntaxNode): NameSet {
  const parent = call.parent;
  if (!parent) { return 'ALL'; }
  if (parent.type === 'member_expression' && parent.childForFieldName('object')?.startIndex === call.startIndex) {
    const prop = parent.childForFieldName('property');
    if (prop?.type === 'property_identifier') { return new Set([prop.text]); }
  }
  if (parent.type === 'expression_statement') { return NO_NAMES; }
  return 'ALL';
}

/** Specifier of `require('x')`, possibly wrapped in an interop helper, else null. */
export function requiredModule(node: SyntaxNode): string | null {
  if (node.type !== 'call_expression') { return null; }
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (fn?.type === 'identifier' && fn.text === 'require') {
    return stringLiteralValue(args?.namedChild(0));
  }
  // _interopRequireDefault(require('x')), __importStar(require('x')), tslib.__importDefault(…)
  const fnName = fn?.type === 'identifier' ? fn.text
    : fn?.type === 'member_expression' ? fn.childForFieldName('property')?.text : undefined;
  if (fnName && /interopRequire|importDefault|importStar|toESM/i.test(fnName)) {
    const inner = args?.namedChild(0);
    return inner ? requiredModule(inner) : null;
  }
  return null;
}

/** Export name targeted by an assignment's left side: `<module>` for `module.exports`. */
function exportTargetName(left: SyntaxNode | null): string | null {
  if (!left) { return null; }
  const text = left.text;
  if (text === 'module.exports') { return '<module>'; }
  if (left.type === 'member_expression') {
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property');
    if (obj && prop?.type === 'property_identifier' && (obj.text === 'exports' || obj.text === 'module.exports')) {
      return prop.text;
    }
  }
  if (left.type === 'subscript_expression') {
    const obj = left.childForFieldName('object');
    const key = stringLiteralValue(left.childForFieldName('index'));
    if (obj && key !== null && (obj.text === 'exports' || obj.text === 'module.exports')) { return key; }
  }
  return null;
}

function propertyKey(key: SyntaxNode | null): string | null {
  if (!key) { return null; }
  if (key.type === 'property_identifier' || key.type === 'identifier') { return key.text; }
  return stringLiteralValue(key);
}

/** Identifiers declared by a binding pattern. */
export function patternNames(node: SyntaxNode): string[] {
  const out: string[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
      out.push(n.text);
      continue;
    }
    if (n.type === 'pair_pattern') {
      const v = n.childForFieldName('value');
      if (v) { stack.push(v); }
      continue;
    }
    if (n.type === 'assignment_pattern') {
      const l = n.childForFieldName('left');
      if (l) { stack.push(l); }
      continue;
    }
    for (const c of n.namedChildren) { stack.push(c); }
  }
  return out;
}

/** Bindings created by `const <pattern> = require(...)`. */
function patternBindings(node: SyntaxNode, target: string | null): ImportBinding[] {
  if (node.type === 'identifier') { return [{ local: node.text, target, imported: '*' }]; }
  if (node.type !== 'object_pattern') {
    return patternNames(node).map((local) => ({ local, target, imported: '*' }));
  }
  const out: ImportBinding[] = [];
  for (const c of node.namedChildren) {
    if (c.type === 'shorthand_property_identifier_pattern') {
      out.push({ local: c.text, target, imported: c.text });
    } else if (c.type === 'pair_pattern') {
      const key = propertyKey(c.childForFieldName('key'));
      const value = c.childForFieldName('value');
      if (key !== null && value?.type === 'identifier') {
        out.push({ local: value.text, target, imported: key });
      } else if (value) {
        for (const local of patternNames(value)) { out.push({ local, target, imported: '*' }); }
      }
    } else {
      for (const local of patternNames(c)) { out.push({ local, target, imported: '*' }); }
    }
  }
  return out;
}

const PURE_CALLEES = new Set([
  'Symbol', 'Symbol.for', 'Object.freeze', 'Object.create', 'Object.assign', 'Object.keys',
  'Object.entries', 'Object.fromEntries', 'Array.isArray', 'Array.from', 'Array.of',
  'String', 'Number', 'Boolean', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise.resolve',
]);

function hasPureAnnotation(node: SyntaxNode): boolean {
  let prev = node.previousSibling;
  while (prev && prev.type === 'comment') {
    if (/[@#]__PURE__/.test(prev.text)) { return true; }
    prev = prev.previousSibling;
  }
  const first = node.child(0);
  return first?.type === 'comment' && /[@#]__PURE__/.test(first.text);
}

/**
 * True when evaluating the expression cannot have observable side effects, so
 * a declaration initialised with it can be dropped when unreferenced.
 * Unknown shapes are treated as impure.
 */
export function isPure(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'number': case 'string': case 'regex': case 'true': case 'false': case 'null':
    case 'undefined': case 'identifier': case 'this': case 'arrow_function':
    case 'function_expression': case 'function': case 'generator_function':
    case 'comment':
      return true;
    case 'template_string':
      return node.namedChildren.every((c) => c.type !== 'template_substitution' || c.namedChildren.every(isPure));
    case 'class':
      return isPureDeclaration(node);
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
    case 'non_null_expression':
    case 'spread_element':
    case 'sequence_expression':
    case 'binary_expression':
    case 'ternary_expression':
    case 'array':
      return node.namedChildren.every(isPure);
    case 'unary_expression':
      return !hasToken(node, 'delete') && node.namedChildren.every(isPure);
    case 'member_expression': {
      const obj = node.childForFieldName('object');
      return !obj || isPure(obj);
    }
    case 'subscript_expression':
      return node.namedChildren.every(isPure);
    case 'object':
      return node.namedChildren.every((m) => {
        if (m.type === 'pair') {
          const key = m.childForFieldName('key');
          const value = m.childForFieldName('value');
          return (!key || key.type !== 'computed_property_name' || isPure(key.namedChildren[0] ?? key))
            && (!value || isPure(value));
        }
        return m.type === 'shorthand_property_identifier' || m.type === 'method_definition'
          || m.type === 'comment' || (m.type === 'spread_element' && isPure(m));
      });
    case 'call_expression':
    case 'new_expression': {
      const args = node.childForFieldName('arguments');
      const argsPure = !args || args.namedChildren.every(isPure);
      if (hasPureAnnotation(node)) { return argsPure; }
      const callee = node.childForFieldName(node.type === 'call_expression' ? 'function' : 'constructor');
      return !!callee && PURE_CALLEES.has(callee.text) && argsPure;
    }
    default:
      return false;
  }
}

/** Function and class declarations are pure unless a class runs code while being defined. */
function isPureDeclaration(node: SyntaxNode): boolean {
  if (node.type !== 'class_declaration' && node.type !== 'class' && node.type !== 'abstract_class_declaration') {
    return true;
  }
  for (const c of node.namedChildren) {
    if (c.type === 'decorator') { return false; }
    if (c.type === 'class_heritage') {
      for (const h of c.namedChildren) {
        if (h.type === 'implements_clause') { continue; }
        const value = h.type === 'extends_clause' ? h.childForFieldName('value') : h;
        if (value && !isPure(value)) { return false; }
      }
    }
    if (c.type === 'class_body') {
      for (const m of c.namedChildren) {
        if (m.type === 'class_static_block' || m.type === 'decorator') { return false; }
        if ((m.type === 'public_field_definition' || m.type === 'field_definition') && hasToken(m, 'static')) {
          const value = m.childForFieldName('value');
          if (value && !isPure(value)) { return false; }
        }
      }
    }
  }
  return true;
}

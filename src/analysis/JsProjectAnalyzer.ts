import type { NameSet } from '../model/ModuleModel';
import { NO_NAMES } from '../model/ModuleModel';
import { hasToken, stringLiteralValue, type SyntaxNode } from '../stages/TreeSitterHelper';
import { requiredModule } from './JsModuleAnalyzer';
import type { ProjectFileAnalysis, ProjectImport, SymbolUse } from './ProjectModel';

/**
 * Usage analysis of one project source file (JavaScript or TypeScript).
 *
 * For every import it records which export names the file needs at runtime,
 * following the local binding: `import { v4 as uuidv4 }` counts references of
 * `uuidv4`; `import _ from 'lodash'` with `_.isEqual(...)` uses `isEqual`;
 * `import * as ns` needs every export as soon as `ns` escapes as a value.
 * In TypeScript files, a binding referenced only in type positions is erased
 * by the compiler and does not count as runtime use.
 */
export function analyzeJsProjectFile(root: SyntaxNode, isTypeScript: boolean): ProjectFileAnalysis {
  return new JsProjectScanner(isTypeScript).scan(root);
}

interface Binding {
  local: string;
  /** `default`, `*` (namespace / CommonJS module object) or an export name. */
  imported: string;
  typeOnlySyntax: boolean;
  entry: number;
}

interface NameUse {
  value: number;
  type: number;
  /** Value references not in `name.member` position (calls, reads, passing as argument). */
  bare: number;
  arities: number[];
  members: Map<string, SymbolUse>;
}

interface Entry {
  specifier: string;
  kind: ProjectImport['kind'];
  node: SyntaxNode;
  typeOnlySyntax: boolean;
  /** Names requested directly by the statement (re-exports, side-effect imports, dynamic imports). */
  directNames: NameSet | null;
}

const TYPE_CONTEXT = new Set([
  'type_annotation', 'type_arguments', 'type_parameters', 'type_alias_declaration',
  'interface_declaration', 'implements_clause', 'type_query', 'ambient_declaration',
  'opting_type_annotation', 'omitting_type_annotation', 'adding_type_annotation',
  'asserts_annotation', 'type_predicate_annotation', 'extends_type_clause',
]);

class JsProjectScanner {
  private readonly entries: Entry[] = [];
  private readonly bindings: Binding[] = [];
  private readonly uses = new Map<string, NameUse>();
  private hasJsx = false;

  constructor(private readonly isTypeScript: boolean) {}

  scan(root: SyntaxNode): ProjectFileAnalysis {
    this.walk(root);
    return { imports: this.buildImports(), hasJsx: this.hasJsx, parseErrors: root.hasError };
  }

  private use(name: string): NameUse {
    let u = this.uses.get(name);
    if (!u) {
      u = { value: 0, type: 0, bare: 0, arities: [], members: new Map() };
      this.uses.set(name, u);
    }
    return u;
  }

  private memberUse(obj: string, member: string): SymbolUse {
    const u = this.use(obj);
    let m = u.members.get(member);
    if (!m) {
      m = { references: 0, typeReferences: 0, callArities: [] };
      u.members.set(member, m);
    }
    return m;
  }

  // ── Tree walk ─────────────────────────────────────────────────────────────

  private walk(root: SyntaxNode): void {
    const stack: Array<[SyntaxNode, boolean]> = [[root, false]];
    while (stack.length > 0) {
      const [n, inType] = stack.pop()!;
      const pushChildren = (typeCtx: boolean, skip?: SyntaxNode | null) => {
        for (let i = n.namedChildCount - 1; i >= 0; i--) {
          const c = n.namedChild(i);
          if (c && (!skip || c.startIndex !== skip.startIndex || c.endIndex !== skip.endIndex)) {
            stack.push([c, typeCtx]);
          }
        }
      };

      switch (n.type) {
        case 'import_statement':
          this.importStatement(n);
          continue;
        case 'export_statement':
          if (n.childForFieldName('source')) {
            this.reexportStatement(n);
            continue;
          }
          break;
        case 'identifier': {
          const u = this.use(n.text);
          if (inType) { u.type++; } else { u.value++; u.bare++; }
          continue;
        }
        case 'shorthand_property_identifier':
          if (!inType) { const u = this.use(n.text); u.value++; u.bare++; }
          continue;
        case 'type_identifier':
          this.use(n.text).type++;
          continue;
        case 'nested_type_identifier': {
          const mod = n.childForFieldName('module');
          const name = n.childForFieldName('name');
          if (mod?.type === 'identifier' && name) {
            this.use(mod.text).type++;
            this.memberUse(mod.text, name.text).typeReferences++;
            continue;
          }
          break;
        }
        case 'member_expression': {
          const obj = n.childForFieldName('object');
          const prop = n.childForFieldName('property');
          if (obj?.type === 'identifier' && prop?.type === 'property_identifier') {
            const u = this.use(obj.text);
            const m = this.memberUse(obj.text, prop.text);
            if (inType) {
              u.type++;
              m.typeReferences++;
            } else {
              u.value++;
              m.references++;
              const parent = n.parent;
              if (parent?.type === 'call_expression' && sameNode(parent.childForFieldName('function'), n)) {
                m.callArities.push(parent.childForFieldName('arguments')?.namedChildCount ?? 0);
              }
            }
            continue;
          }
          break;
        }
        case 'call_expression': {
          const fn = n.childForFieldName('function');
          const args = n.childForFieldName('arguments');
          if (fn?.type === 'identifier' && fn.text === 'require') {
            const spec = stringLiteralValue(args?.namedChild(0));
            if (spec !== null) {
              this.requireCall(n, spec);
              continue;
            }
          }
          if (fn?.type === 'import') {
            const spec = stringLiteralValue(args?.namedChild(0));
            if (spec !== null) {
              this.entries.push({ specifier: spec, kind: 'dynamic', node: n, typeOnlySyntax: false, directNames: 'ALL' });
            }
            if (args) { stack.push([args, inType]); }
            continue;
          }
          if (fn?.type === 'identifier' && !inType) {
            this.use(fn.text).arities.push(args?.namedChildCount ?? 0);
          }
          break;
        }
        case 'variable_declarator': {
          const value = n.childForFieldName('value');
          const spec = value ? requiredModule(value) : null;
          if (spec !== null && value) {
            this.requireDeclarator(n, spec);
            continue;
          }
          break;
        }
        case 'jsx_element':
        case 'jsx_self_closing_element':
        case 'jsx_fragment':
          this.hasJsx = true;
          break;
        case 'string':
        case 'number':
        case 'comment':
        case 'regex':
        case 'property_identifier':
          continue;
      }
      pushChildren(inType || TYPE_CONTEXT.has(n.type));
    }
  }

  // ── Import forms ──────────────────────────────────────────────────────────

  private importStatement(node: SyntaxNode): void {
    const typeOnly = hasToken(node, 'type');
    const requireClause = node.namedChildren.find((c) => c.type === 'import_require_clause');
    if (requireClause) {
      const spec = stringLiteralValue(requireClause.childForFieldName('source'));
      const local = requireClause.namedChildren.find((c) => c.type === 'identifier')?.text;
      if (spec === null) { return; }
      const entry = this.addEntry(spec, 'require', node, typeOnly, null);
      if (local) { this.bindings.push({ local, imported: '*', typeOnlySyntax: typeOnly, entry }); }
      return;
    }

    const spec = stringLiteralValue(node.childForFieldName('source'));
    if (spec === null) { return; }
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    const entry = this.addEntry(spec, 'import', node, typeOnly, clause ? null : NO_NAMES);
    if (!clause) { return; }

    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') {
        this.bindings.push({ local: c.text, imported: 'default', typeOnlySyntax: typeOnly, entry });
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) { this.bindings.push({ local: id.text, imported: '*', typeOnlySyntax: typeOnly, entry }); }
      } else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s.type !== 'import_specifier') { continue; }
          const name = s.childForFieldName('name');
          if (!name) { continue; }
          const imported = name.type === 'string' ? name.text.slice(1, -1) : name.text;
          const local = s.childForFieldName('alias')?.text ?? imported;
          this.bindings.push({ local, imported, typeOnlySyntax: typeOnly || hasToken(s, 'type'), entry });
        }
      }
    }
  }

  private reexportStatement(node: SyntaxNode): void {
    const spec = stringLiteralValue(node.childForFieldName('source'));
    if (spec === null) { return; }
    const typeOnly = hasToken(node, 'type');
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    let names: NameSet = 'ALL';
    if (clause) {
      const set = new Set<string>();
      for (const s of clause.namedChildren) {
        if (s.type !== 'export_specifier' || hasToken(s, 'type')) { continue; }
        const name = s.childForFieldName('name')?.text;
        if (name) { set.add(name); }
      }
      names = set;
    }
    this.addEntry(spec, 'reexport', node, typeOnly || (names !== 'ALL' && names.size === 0), names);
  }

  private requireCall(call: SyntaxNode, spec: string): void {
    const parent = call.parent;
    let names: NameSet = 'ALL';
    if (parent?.type === 'expression_statement') {
      names = NO_NAMES;
    } else if (parent?.type === 'member_expression' && sameNode(parent.childForFieldName('object'), call)) {
      const prop = parent.childForFieldName('property');
      if (prop?.type === 'property_identifier') { names = new Set([prop.text]); }
    }
    this.addEntry(spec, 'require', statementOf(call), false, names);
  }

  private requireDeclarator(declarator: SyntaxNode, spec: string): void {
    const nameNode = declarator.childForFieldName('name');
    const entry = this.addEntry(spec, 'require', statementOf(declarator), false, null);
    if (!nameNode) { return; }
    if (nameNode.type === 'identifier') {
      this.bindings.push({ local: nameNode.text, imported: '*', typeOnlySyntax: false, entry });
      return;
    }
    if (nameNode.type === 'object_pattern') {
      for (const c of nameNode.namedChildren) {
        if (c.type === 'shorthand_property_identifier_pattern') {
          this.bindings.push({ local: c.text, imported: c.text, typeOnlySyntax: false, entry });
        } else if (c.type === 'pair_pattern') {
          const key = c.childForFieldName('key');
          const value = c.childForFieldName('value');
          const keyName = key?.type === 'property_identifier' ? key.text : stringLiteralValue(key);
          if (keyName !== null && value?.type === 'identifier') {
            this.bindings.push({ local: value.text, imported: keyName, typeOnlySyntax: false, entry });
          } else {
            this.entries[entry].directNames = 'ALL';
          }
        } else {
          this.entries[entry].directNames = 'ALL';
        }
      }
      return;
    }
    this.entries[entry].directNames = 'ALL';
  }

  private addEntry(specifier: string, kind: ProjectImport['kind'], node: SyntaxNode, typeOnly: boolean, names: NameSet | null): number {
    this.entries.push({ specifier, kind, node, typeOnlySyntax: typeOnly, directNames: names });
    return this.entries.length - 1;
  }

  // ── Result ────────────────────────────────────────────────────────────────

  private buildImports(): ProjectImport[] {
    const byEntry = new Map<number, Binding[]>();
    for (const b of this.bindings) {
      const list = byEntry.get(b.entry);
      if (list) { list.push(b); } else { byEntry.set(b.entry, [b]); }
    }

    return this.entries.map((e, index) => {
      const bindings = byEntry.get(index) ?? [];
      const symbols = new Map<string, SymbolUse>();
      let names: Set<string> | 'ALL' = new Set<string>();
      let runtime = false;

      const addNames = (n: NameSet) => {
        if (names === 'ALL') { return; }
        if (n === 'ALL') { names = 'ALL'; return; }
        for (const x of n) { names.add(x); }
      };

      if (e.directNames !== null) {
        runtime = !e.typeOnlySyntax;
        if (runtime) { addNames(e.directNames); }
        if (e.kind === 'reexport' && e.directNames !== 'ALL') {
          for (const n of e.directNames) { symbols.set(n, { references: 1, typeReferences: 0, callArities: [] }); }
        }
      }

      for (const b of bindings) {
        const u = this.uses.get(b.local) ?? { value: 0, type: 0, bare: 0, arities: [], members: new Map() };
        const jsxReact = this.hasJsx && b.local === 'React';
        // TypeScript erases imports that are never used as values; JavaScript always executes them.
        const bindingRuntime = !b.typeOnlySyntax && (!this.isTypeScript || u.value > 0 || jsxReact || e.kind === 'require');
        if (bindingRuntime) { runtime = true; }

        if (b.imported === '*' || b.imported === 'default') {
          for (const [member, m] of u.members) { mergeSymbol(symbols, member, m); }
          if (u.bare > 0 || u.members.size === 0) {
            mergeSymbol(symbols, b.imported === '*' ? '*' : 'default', {
              references: u.bare, typeReferences: u.type, callArities: u.arities,
            });
          }
          if (!bindingRuntime) { continue; }
          if (b.imported === 'default') {
            addNames(new Set(['default']));
          } else if (u.bare > 0 || jsxReact) {
            addNames('ALL');
          } else {
            const valueMembers = [...u.members.entries()].filter(([, m]) => m.references > 0).map(([k]) => k);
            addNames(new Set(valueMembers));
          }
        } else {
          mergeSymbol(symbols, b.imported, { references: u.value, typeReferences: u.type, callArities: u.arities });
          if (bindingRuntime) { addNames(new Set([b.imported])); }
        }
      }

      if (e.directNames === null && bindings.length === 0) {
        // A require whose result is discarded or an import with no usable bindings still executes.
        runtime = !e.typeOnlySyntax;
      }

      return {
        specifier: e.specifier,
        kind: e.kind,
        line: e.node.startPosition.row,
        endLine: e.node.endPosition.row,
        runtime,
        names: runtime ? names : NO_NAMES,
        symbols,
      };
    });
  }
}

function mergeSymbol(map: Map<string, SymbolUse>, name: string, use: SymbolUse): void {
  const existing = map.get(name);
  if (existing) {
    existing.references += use.references;
    existing.typeReferences += use.typeReferences;
    existing.callArities.push(...use.callArities);
  } else {
    map.set(name, { references: use.references, typeReferences: use.typeReferences, callArities: [...use.callArities] });
  }
}

function sameNode(a: SyntaxNode | null | undefined, b: SyntaxNode): boolean {
  return !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function statementOf(node: SyntaxNode): SyntaxNode {
  let n: SyntaxNode = node;
  while (n.parent && n.parent.type !== 'program' && n.parent.type !== 'statement_block') { n = n.parent; }
  return n;
}

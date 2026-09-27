import { emptyModule, type ModuleInfo, type ModuleItem, type OpenImport } from '../model/ModuleModel';

/**
 * Dart analysis built on a small lexer instead of a Tree-sitter grammar: the
 * available Dart grammar predates Dart 3 (`sealed`, `base`, `interface`,
 * `final` classes, extension types) and its error recovery corrupts the
 * top-level structure. Only the top level matters here, and bracket depth is
 * enough to find it reliably.
 */

export interface DartToken {
  kind: 'ident' | 'string' | 'punct' | 'number';
  text: string;
  start: number;
  end: number;
  /** Value of a string literal without interpolation. */
  value?: string;
}

const MULTI_PUNCT = ['...', '??=', '=>', '==', '!=', '<=', '>=', '?.', '??', '..', '+=', '-=', '*=', '/=', '~/', '&&', '||', '++', '--'];

export function lexDart(src: string): DartToken[] {
  const tokens: DartToken[] = [];
  const n = src.length;

  const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);

  /** Lex code from `i`; when `interpolation`, stop at the `}` closing `${`. Returns the index after the stop. */
  const lexCode = (start: number, interpolation: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') { i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        let nest = 1;
        i += 2;
        while (i < n && nest > 0) {
          if (src[i] === '/' && src[i + 1] === '*') { nest++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { nest--; i += 2; } else { i++; }
        }
        continue;
      }
      if (c === '"' || c === "'") { i = lexString(i, i, false); continue; }
      if (c === 'r' && (src[i + 1] === '"' || src[i + 1] === "'")) { i = lexString(i, i + 1, true); continue; }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isId(src[j])) { j++; }
        tokens.push({ kind: 'ident', text: src.slice(i, j), start: i, end: j });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
        const m = /^(0[xX][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 64));
        const len = m ? Math.max(1, m[0].length) : 1;
        tokens.push({ kind: 'number', text: src.slice(i, i + len), start: i, end: i + len });
        i += len;
        continue;
      }
      if (interpolation) {
        if (c === '{') { depth++; } else if (c === '}') {
          if (depth === 0) { return i + 1; }
          depth--;
        }
      }
      const multi = MULTI_PUNCT.find((p) => src.startsWith(p, i));
      const len = multi ? multi.length : 1;
      tokens.push({ kind: 'punct', text: src.slice(i, i + len), start: i, end: i + len });
      i += len;
    }
    return i;
  };

  /** Lex a string literal whose quote starts at `q`; `start` includes an `r` prefix. */
  const lexString = (start: number, q: number, raw: boolean): number => {
    const quote = src[q];
    const triple = src[q + 1] === quote && src[q + 2] === quote;
    const close = triple ? quote.repeat(3) : quote;
    let i = q + close.length;
    let interpolated = false;
    const placeholder: DartToken = { kind: 'string', text: '', start, end: start };
    tokens.push(placeholder);
    let value = '';
    while (i < n) {
      if (src.startsWith(close, i)) { i += close.length; break; }
      const c = src[i];
      if (!triple && c === '\n') { break; }
      if (!raw && c === '\\') { value += src[i + 1] ?? ''; i += 2; continue; }
      if (!raw && c === '$') {
        if (src[i + 1] === '{') {
          interpolated = true;
          i = lexCode(i + 2, true);
          continue;
        }
        if (isIdStart(src[i + 1] ?? '')) {
          interpolated = true;
          let j = i + 2;
          while (j < n && isId(src[j]) && src[j] !== '$') { j++; }
          tokens.push({ kind: 'ident', text: src.slice(i + 1, j), start: i + 1, end: j });
          i = j;
          continue;
        }
      }
      value += c;
      i++;
    }
    placeholder.end = i;
    placeholder.text = src.slice(start, i);
    if (!interpolated) { placeholder.value = value; }
    return i;
  };

  lexCode(0, false);
  return tokens;
}

export interface DartDirective {
  kind: 'import' | 'export' | 'part' | 'part-of' | 'library';
  /** Primary URI plus configuration-specific alternatives (`if (dart.library.io) '…'`). */
  uris: string[];
  prefix?: string;
  show?: Set<string>;
  hide?: Set<string>;
  start: number;
  end: number;
  /** Token index range [from, to). */
  tokenRange: [number, number];
}

export interface DartDeclaration {
  names: string[];
  /** Extensions apply implicitly (no name at the use site), so they are always live. */
  implicit: boolean;
  /** Member names declared by an extension (methods, getters, setters, operators). */
  members?: string[];
  start: number;
  end: number;
  tokenRange: [number, number];
}

export interface DartUnit {
  tokens: DartToken[];
  directives: DartDirective[];
  declarations: DartDeclaration[];
}

const DECLARATION_MODIFIERS = new Set([
  'abstract', 'sealed', 'base', 'interface', 'final', 'const', 'var', 'late', 'static',
  'external', 'augment', 'macro', 'covariant',
]);

/** Split a compilation unit into directives and top-level declarations. */
export function parseDartUnit(src: string): DartUnit {
  const tokens = lexDart(src);
  const directives: DartDirective[] = [];
  const declarations: DartDeclaration[] = [];
  let i = 0;

  while (i < tokens.length) {
    const startIdx = i;
    // Metadata annotations belong to the next declaration.
    while (tokens[i]?.text === '@') {
      i++;
      while (tokens[i]?.kind === 'ident' && tokens[i + 1]?.text === '.') { i += 2; }
      if (tokens[i]?.kind === 'ident') { i++; }
      if (tokens[i]?.text === '(') { i = skipBalanced(tokens, i); }
    }
    const t = tokens[i];
    if (!t) { break; }
    if (t.text === ';') { i++; continue; }

    const next = tokens[i + 1];
    if ((t.text === 'import' || t.text === 'export') && next?.kind === 'string') {
      const end = findStatementEnd(tokens, i);
      directives.push(parseDirective(t.text, tokens, i, end, src));
      i = end;
      continue;
    }
    if (t.text === 'part' || t.text === 'library') {
      const end = findStatementEnd(tokens, i);
      const d = parseDirective(t.text === 'part' && next?.text === 'of' ? 'part-of' : t.text as 'part' | 'library', tokens, i, end, src);
      directives.push(d);
      i = end;
      continue;
    }

    const end = findDeclarationEnd(tokens, i);
    const { names, implicit } = declarationNames(tokens, i, end);
    declarations.push({
      names,
      implicit,
      members: implicit ? bodyMembers(tokens, i, end) : undefined,
      start: tokens[startIdx].start,
      end: tokens[end - 1]?.end ?? tokens[startIdx].end,
      tokenRange: [startIdx, end],
    });
    i = Math.max(end, i + 1);
  }
  return { tokens, directives, declarations };
}

/** Names of members declared directly in a `{ … }` body (identifiers followed by `(`, `=>`, or after get/set). */
function bodyMembers(tokens: DartToken[], from: number, to: number): string[] {
  const out = new Set<string>();
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.text === '{' || t.text === '(' || t.text === '[') { depth++; continue; }
    if (t.text === '}' || t.text === ')' || t.text === ']') { depth--; continue; }
    if (depth !== 1 || t.kind !== 'ident') { continue; }
    const next = tokens[i + 1]?.text;
    const prev = tokens[i - 1]?.text;
    if (prev === '@' || prev === '.') { continue; } // annotation or qualified name
    if (prev === 'get' || prev === 'set' || next === '(' || (next === '<' && isGenericMethod(tokens, i + 1))) {
      out.add(t.text);
    }
  }
  for (const kw of ['get', 'set', 'static', 'operator', 'return', 'if', 'for', 'while', 'switch']) { out.delete(kw); }
  return [...out];
}

/** `name<T>(` — type parameters followed by a parameter list. */
function isGenericMethod(tokens: DartToken[], lt: number): boolean {
  let angle = 0;
  for (let i = lt; i < tokens.length && i < lt + 64; i++) {
    const x = tokens[i].text;
    if (x === '<') { angle++; } else if (x === '>') {
      angle--;
      if (angle === 0) { return tokens[i + 1]?.text === '('; }
    } else if (x === ';' || x === '{' || x === '=') {
      return false;
    }
  }
  return false;
}

function skipBalanced(tokens: DartToken[], i: number): number {
  let depth = 0;
  for (; i < tokens.length; i++) {
    const x = tokens[i].text;
    if (x === '(' || x === '[' || x === '{') { depth++; }
    if (x === ')' || x === ']' || x === '}') {
      depth--;
      if (depth === 0) { return i + 1; }
    }
  }
  return i;
}

function findStatementEnd(tokens: DartToken[], i: number): number {
  let depth = 0;
  for (; i < tokens.length; i++) {
    const x = tokens[i].text;
    if (x === '(' || x === '[' || x === '{') { depth++; } else if (x === ')' || x === ']' || x === '}') { depth--; } else if (x === ';' && depth <= 0) { return i + 1; }
  }
  return i;
}

/**
 * A declaration ends at `;` at depth 0, or at the `}` closing a body brace:
 * a `{` opened at depth 0 before any `=`/`=>` (class, function or accessor
 * body, as opposed to a map/set literal initialiser).
 */
function findDeclarationEnd(tokens: DartToken[], i: number): number {
  let depth = 0;
  let sawAssign = false;
  let bodyDepth = -1;
  for (; i < tokens.length; i++) {
    const x = tokens[i];
    if (x.kind !== 'punct') { continue; }
    if (depth === 0 && (x.text === '=' || x.text === '=>')) { sawAssign = true; }
    if (x.text === '(' || x.text === '[' || x.text === '{') {
      if (x.text === '{' && depth === 0 && !sawAssign) { bodyDepth = 0; }
      depth++;
    } else if (x.text === ')' || x.text === ']' || x.text === '}') {
      depth--;
      if (depth === 0 && x.text === '}' && bodyDepth === 0) { return i + 1; }
    } else if (x.text === ';' && depth <= 0) {
      return i + 1;
    }
  }
  return i;
}

function declarationNames(tokens: DartToken[], from: number, to: number): { names: string[]; implicit: boolean } {
  // Depth-0 tokens up to the body, the initializer or the parameter list.
  const head: DartToken[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const x = tokens[i];
    if (x.text === '(' || x.text === '[' || x.text === '{') {
      if (depth === 0) { head.push(x); }
      depth++;
      continue;
    }
    if (x.text === ')' || x.text === ']' || x.text === '}') { depth--; continue; }
    if (depth === 0) { head.push(x); }
  }
  const idx = (text: string) => head.findIndex((x) => x.kind === 'ident' && x.text === text);
  const identAfter = (k: number) => (head[k + 1]?.kind === 'ident' ? head[k + 1].text : null);

  const classIdx = idx('class');
  if (classIdx >= 0) { return { names: nonNull([identAfter(classIdx)]), implicit: false }; }
  const extIdx = idx('extension');
  if (extIdx >= 0) {
    if (head[extIdx + 1]?.text === 'type') { return { names: nonNull([identAfter(extIdx + 1)]), implicit: false }; }
    const name = identAfter(extIdx);
    return { names: name && name !== 'on' ? [name] : [], implicit: true };
  }
  for (const kw of ['mixin', 'enum']) {
    const k = idx(kw);
    if (k >= 0) { return { names: nonNull([identAfter(k)]), implicit: false }; }
  }
  const typedefIdx = idx('typedef');
  if (typedefIdx >= 0) {
    if (head.some((x) => x.text === '=')) { return { names: nonNull([identAfter(typedefIdx)]), implicit: false }; }
    const paren = head.findIndex((x) => x.text === '(');
    return { names: nonNull([nameBefore(head, paren)]), implicit: false };
  }
  for (const acc of ['get', 'set']) {
    const k = idx(acc);
    if (k >= 0 && head[k + 1]?.kind === 'ident' && head[k + 1].text !== '=') {
      return { names: [head[k + 1].text], implicit: false };
    }
  }

  const paren = head.findIndex((x) => x.text === '(');
  const assign = head.findIndex((x) => x.text === '=' || x.text === '=>');
  if (paren >= 0 && (assign < 0 || paren < assign)) {
    return { names: nonNull([nameBefore(head, paren)]), implicit: false };
  }

  // Top-level variables: `final a = 1, b = 2;`, `int x;`, `late final Map<String, int> m;`
  const names: string[] = [];
  let angle = 0;
  let inInit = false;
  for (let k = 0; k < head.length; k++) {
    const x = head[k];
    if (inInit) {
      if (x.text === ',') { inInit = false; }
      continue;
    }
    if (x.text === '<') { angle++; continue; }
    if (x.text === '>') { angle = Math.max(0, angle - 1); continue; }
    if (x.text === '=') { inInit = true; continue; }
    if (angle === 0 && x.kind === 'ident' && !DECLARATION_MODIFIERS.has(x.text)) {
      const after = head[k + 1]?.text;
      if (after === '=' || after === ',' || after === ';' || after === undefined) { names.push(x.text); }
    }
  }
  return { names, implicit: false };
}

/** Identifier naming a function whose parameter list starts at `paren`, skipping type parameters. */
function nameBefore(head: DartToken[], paren: number): string | null {
  let k = paren - 1;
  if (head[k]?.text === '>') {
    let angle = 0;
    for (; k >= 0; k--) {
      if (head[k].text === '>') { angle++; } else if (head[k].text === '<') {
        angle--;
        if (angle === 0) { k--; break; }
      }
    }
  }
  return head[k]?.kind === 'ident' ? head[k].text : null;
}

function nonNull(xs: Array<string | null>): string[] {
  return xs.filter((x): x is string => !!x);
}

function parseDirective(kind: DartDirective['kind'], tokens: DartToken[], from: number, to: number, _src: string): DartDirective {
  const d: DartDirective = { kind, uris: [], start: tokens[from].start, end: tokens[to - 1]?.end ?? tokens[from].end, tokenRange: [from, to] };
  let mode: 'none' | 'show' | 'hide' = 'none';
  for (let i = from + 1; i < to; i++) {
    const t = tokens[i];
    if (t.kind === 'string' && t.value !== undefined && mode === 'none') {
      d.uris.push(t.value);
      continue;
    }
    if (t.kind !== 'ident') { continue; }
    if (t.text === 'as' && tokens[i + 1]?.kind === 'ident') { d.prefix = tokens[++i].text; continue; }
    if (t.text === 'show') { mode = 'show'; d.show = d.show ?? new Set(); continue; }
    if (t.text === 'hide') { mode = 'hide'; d.hide = d.hide ?? new Set(); continue; }
    if (mode === 'show') { d.show!.add(t.text); } else if (mode === 'hide') { d.hide!.add(t.text); }
  }
  return d;
}

/** Identifier references and `prefix.member` accesses within a token range. */
export function tokenReferences(tokens: DartToken[], from: number, to: number): { refs: Set<string>; members: Map<string, Set<string>> } {
  const refs = new Set<string>();
  const members = new Map<string, Set<string>>();
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident') { continue; }
    const prev = tokens[i - 1];
    if (prev && (prev.text === '.' || prev.text === '?.') && tokens[i - 2]?.kind === 'ident') {
      const obj = tokens[i - 2].text;
      const set = members.get(obj) ?? new Set<string>();
      set.add(t.text);
      members.set(obj, set);
      continue;
    }
    refs.add(t.text);
  }
  return { refs, members };
}

export interface DartUnitFile {
  file: string;
  text: string;
  unit: DartUnit;
}

/** Resolve a Dart URI from `fromFile`; `null` when unresolvable, `skip` for `dart:` libraries. */
export type DartResolve = (uri: string, fromFile: string) => string | null | 'skip';

/**
 * Module description of a Dart library (a file plus its `part` files).
 * Dart top-level declarations are initialised lazily and have no load-time
 * side effects, so nothing is a root except extensions, which are applied
 * implicitly by the compiler.
 */
export function buildDartLibrary(units: DartUnitFile[], resolve: DartResolve): ModuleInfo {
  const main = units[0];
  const size = units.reduce((s, u) => s + u.text.length, 0);
  const info = emptyModule(units.map((u) => u.file), size, 'items');
  info.starSkipsDefault = false;
  const extensions = new Map<string, string[]>();
  extensionMembers.set(info, extensions);

  for (const u of units) {
    for (const decl of u.unit.declarations) {
      const { refs, members } = tokenReferences(u.unit.tokens, decl.tokenRange[0], decl.tokenRange[1]);
      const item: ModuleItem = {
        declares: decl.names,
        size: decl.end - decl.start,
        refs: [...refs],
        memberRefs: [...members.entries()].map(([k, v]) => [k, [...v]]),
        root: decl.implicit,
        loads: [],
      };
      info.items.push(item);
      for (const name of decl.names) {
        if (!name.startsWith('_')) { info.localExports.set(name, name); }
      }
      if (decl.members && decl.names.length > 0 && !decl.names[0].startsWith('_')) {
        extensions.set(decl.names[0], decl.members);
      }
    }
  }

  for (const d of main.unit.directives) {
    if (d.kind !== 'import' && d.kind !== 'export') { continue; }
    for (const uri of d.uris) {
      const target = resolve(uri, main.file);
      if (target === 'skip') { continue; }
      if (target === null) { info.unresolved.push(uri); }
      if (d.kind === 'import') {
        if (d.prefix) {
          info.bindings.push({ local: d.prefix, target, imported: '*', show: d.show });
        } else {
          const open: OpenImport = { target, show: d.show, hide: d.hide };
          info.openImports.push(open);
        }
      } else if (d.show) {
        for (const name of d.show) { info.reexports.push({ kind: 'named', target, exported: name, imported: name }); }
      } else {
        info.reexports.push({ kind: 'star', target, hide: d.hide });
      }
    }
  }
  return info;
}

/** Named extensions a library declares, with their member names. */
const extensionMembers = new WeakMap<ModuleInfo, Map<string, string[]>>();

export function localExtensions(info: ModuleInfo): Map<string, string[]> {
  return extensionMembers.get(info) ?? new Map();
}

/** Part files referenced by a library unit (`part 'x.dart';`). */
export function partUris(unit: DartUnit): string[] {
  return unit.directives.filter((d) => d.kind === 'part').flatMap((d) => d.uris.slice(0, 1));
}

/** Identifier occurrence counts outside directives, for project usage. */
export function identifierCounts(unit: DartUnit): { counts: Map<string, number>; members: Map<string, Map<string, number>> } {
  const inDirective = new Uint8Array(unit.tokens.length);
  for (const d of unit.directives) {
    for (let i = d.tokenRange[0]; i < d.tokenRange[1]; i++) { inDirective[i] = 1; }
  }
  const counts = new Map<string, number>();
  const members = new Map<string, Map<string, number>>();
  unit.tokens.forEach((t, i) => {
    if (inDirective[i] || t.kind !== 'ident') { return; }
    const prev = unit.tokens[i - 1];
    if (prev && (prev.text === '.' || prev.text === '?.') && unit.tokens[i - 2]?.kind === 'ident') {
      const obj = unit.tokens[i - 2].text;
      const m = members.get(obj) ?? new Map<string, number>();
      m.set(t.text, (m.get(t.text) ?? 0) + 1);
      members.set(obj, m);
    }
    counts.set(t.text, (counts.get(t.text) ?? 0) + 1);
  });
  return { counts, members };
}

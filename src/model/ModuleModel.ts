/**
 * Language-neutral description of one source module, produced by the
 * per-language analyzers and consumed by the liveness engine.
 *
 * A module is either analysed at declaration granularity (`items`) or treated
 * as indivisible (`whole`). Sizes are measured in source characters and scaled
 * to file bytes by the engine, because parsers report character offsets.
 */

/** A set of export names, or every export of the module. */
export type NameSet = ReadonlySet<string> | 'ALL';

export const NO_NAMES: NameSet = new Set<string>();

/** A load of another module. `target` is null when the specifier could not be resolved. */
export interface ModuleLoad {
  target: string | null;
  names: NameSet;
}

/** One top-level declaration or statement. */
export interface ModuleItem {
  /** Local names this item declares (a function, class, variable, …). */
  declares: string[];
  /** Size in source characters. */
  size: number;
  /** Identifiers referenced other than as the object of a member access. */
  refs: string[];
  /** `x.member` accesses: object identifier → member names. */
  memberRefs: Array<[string, string[]]>;
  /** Evaluated when the module is loaded (a side effect), so it is always live. */
  root: boolean;
  /** Loads performed inside this item (a `require` inside a function, …). */
  loads: ModuleLoad[];
}

/** A named binding created by an import statement. */
export interface ImportBinding {
  local: string;
  target: string | null;
  /** Remote export name, or `*` for a namespace binding. */
  imported: string;
  /** Only these names are visible through the binding (Dart `show`). */
  show?: ReadonlySet<string>;
}

/** Dart-style import without prefix: every export of the target is in scope. */
export interface OpenImport {
  target: string | null;
  show?: ReadonlySet<string>;
  hide?: ReadonlySet<string>;
}

/**
 * `export { x } from` / `export * from`. `item` is the statement's own source
 * text, live only when the re-export is followed.
 */
export type ReExport =
  | { kind: 'named'; target: string | null; exported: string; imported: string; item?: number }
  | { kind: 'star'; target: string | null; show?: ReadonlySet<string>; hide?: ReadonlySet<string>; item?: number };

export interface ModuleInfo {
  /** Files that make up the module (a Dart library plus its parts). */
  files: string[];
  /** Total size in source characters. */
  size: number;
  granularity: 'items' | 'whole';
  items: ModuleItem[];
  /** Exported name → local name, for `export { local as exported }` and exported declarations. */
  localExports: Map<string, string>;
  /** Exported name → items, for anonymous exports (`export default expr`, `exports.x = expr`). */
  exportItems: Map<string, number[]>;
  bindings: ImportBinding[];
  openImports: OpenImport[];
  reexports: ReExport[];
  /** Loads performed whenever the module is included (side-effect imports, Python imports, …). */
  loads: ModuleLoad[];
  /** CommonJS `module.exports = value`: any requested name is served by the default export. */
  openExports: boolean;
  /** JavaScript `export *` does not re-export `default`. */
  starSkipsDefault: boolean;
  /** Contains a load whose target is computed at runtime (`require(name)`). */
  dynamicLoads: boolean;
  /** Specifiers that could not be resolved to a file. */
  unresolved: string[];
}

export function emptyModule(files: string[], size: number, granularity: 'items' | 'whole'): ModuleInfo {
  return {
    files,
    size,
    granularity,
    items: [],
    localExports: new Map(),
    exportItems: new Map(),
    bindings: [],
    openImports: [],
    reexports: [],
    loads: [],
    openExports: false,
    starSkipsDefault: true,
    dynamicLoads: false,
    unresolved: [],
  };
}

/** Every module this module can load, regardless of which names are needed. */
export function allTargets(info: ModuleInfo): string[] {
  const out: string[] = [];
  const add = (t: string | null) => { if (t) { out.push(t); } };
  for (const l of info.loads) { add(l.target); }
  for (const b of info.bindings) { add(b.target); }
  for (const o of info.openImports) { add(o.target); }
  for (const r of info.reexports) { add(r.target); }
  for (const item of info.items) {
    for (const l of item.loads) { add(l.target); }
  }
  return out;
}

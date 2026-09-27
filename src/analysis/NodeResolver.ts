import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

export type ResolveKind = 'import' | 'require';

/** Conditions tried first for each kind; the other kind's set is the fallback. */
const CONDITIONS: Record<ResolveKind, ReadonlySet<string>> = {
  import: new Set(['import', 'module', 'node', 'default']),
  require: new Set(['require', 'node', 'default']),
};

const FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const BUILTINS = new Set(builtinModules);

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
  bin?: string | Record<string, string>;
  sideEffects?: boolean | string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  scripts?: Record<string, string>;
}

/** Split `@scope/name/sub/path` into package name and subpath. */
export function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const n = specifier.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), subpath: parts.slice(n).join('/') };
}

export function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

export function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./')
    || specifier.startsWith('../') || specifier.startsWith('/');
}

/** Code files as the module graph sees them: loadable JavaScript and JSON, not declarations or maps. */
export function isJsCodeFile(file: string): boolean {
  if (/\.d\.[cm]?ts$/.test(file)) { return false; }
  return FILE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/**
 * Node.js module resolution (`exports`/`imports` maps with conditions and
 * patterns, `main`/`module`, extension and index probing), with caches.
 */
export class NodeResolver {
  private readonly statCache = new Map<string, 'file' | 'dir' | null>();
  private readonly realCache = new Map<string, string>();
  private readonly pkgJsonCache = new Map<string, PackageJson | null>();
  private readonly pkgRootCache = new Map<string, string | null>();

  resolve(specifier: string, fromFile: string, kind: ResolveKind): string | null | 'builtin' {
    if (isBuiltin(specifier)) { return 'builtin'; }
    const fromDir = path.dirname(this.realpath(fromFile));
    if (isRelative(specifier)) {
      return this.resolveFileOrDir(path.resolve(fromDir, specifier));
    }
    if (specifier.startsWith('#')) {
      const root = this.packageRootOf(fromFile);
      const imports = root ? this.readPackageJson(root)?.imports : undefined;
      if (!root || !imports) { return null; }
      return this.resolveMap(root, imports, specifier, kind);
    }
    const { name, subpath } = splitSpecifier(specifier);
    const pkgDir = this.findPackage(name, fromDir);
    if (!pkgDir) { return null; }
    return this.resolveInPackage(pkgDir, subpath, kind);
  }

  /** Directory of an installed package as seen from `fromDir` (walking up `node_modules`). */
  findPackage(name: string, fromDir: string): string | null {
    let dir = fromDir;
    for (;;) {
      if (path.basename(dir) !== 'node_modules') {
        const candidate = path.join(dir, 'node_modules', name);
        if (this.stat(candidate) === 'dir') { return this.realpath(candidate); }
      }
      const parent = path.dirname(dir);
      if (parent === dir) { return null; }
      dir = parent;
    }
  }

  resolveInPackage(pkgDir: string, subpath: string, kind: ResolveKind): string | null {
    const pj = this.readPackageJson(pkgDir);
    if (pj && pj.exports !== undefined && pj.exports !== null) {
      return this.resolveMap(pkgDir, pj.exports, subpath ? `./${subpath}` : '.', kind);
    }
    if (subpath) { return this.resolveFileOrDir(path.join(pkgDir, subpath)); }
    return this.resolveMain(pkgDir, pj, kind);
  }

  /**
   * Public entry points of a package under the conditions used for `kind`:
   * every subpath of its `exports` map (patterns expanded), or its main entry.
   */
  entryFiles(pkgDir: string, kind: ResolveKind = 'import'): string[] {
    const pj = this.readPackageJson(pkgDir);
    const out = new Set<string>();
    if (pj && pj.exports !== undefined && pj.exports !== null) {
      const map = normalizeExports(pj.exports);
      for (const key of Object.keys(map)) {
        if (key.includes('*')) {
          for (const f of this.expandPattern(pkgDir, map[key], kind)) { out.add(f); }
        } else if (!key.endsWith('/')) {
          const r = this.resolveMap(pkgDir, pj.exports, key, kind);
          if (r) { out.add(r); }
        }
      }
    } else {
      const main = this.resolveMain(pkgDir, pj, kind);
      if (main) { out.add(main); }
    }
    return [...out].filter(isJsCodeFile);
  }

  readPackageJson(dir: string): PackageJson | null {
    if (this.pkgJsonCache.has(dir)) { return this.pkgJsonCache.get(dir)!; }
    let pj: PackageJson | null = null;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
    } catch {
      pj = null;
    }
    this.pkgJsonCache.set(dir, pj);
    return pj;
  }

  /** Nearest ancestor directory of `file` containing a package.json. */
  packageRootOf(file: string): string | null {
    let dir = path.dirname(this.realpath(file));
    const visited: string[] = [];
    for (;;) {
      if (this.pkgRootCache.has(dir)) {
        const r = this.pkgRootCache.get(dir)!;
        for (const v of visited) { this.pkgRootCache.set(v, r); }
        return r;
      }
      visited.push(dir);
      if (this.stat(path.join(dir, 'package.json')) === 'file') {
        for (const v of visited) { this.pkgRootCache.set(v, dir); }
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        for (const v of visited) { this.pkgRootCache.set(v, null); }
        return null;
      }
      dir = parent;
    }
  }

  realpath(p: string): string {
    const cached = this.realCache.get(p);
    if (cached) { return cached; }
    let r = p;
    try { r = fs.realpathSync(p); } catch { /* keep as is */ }
    this.realCache.set(p, r);
    return r;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private stat(p: string): 'file' | 'dir' | null {
    if (this.statCache.has(p)) { return this.statCache.get(p)!; }
    let r: 'file' | 'dir' | null = null;
    try {
      const s = fs.statSync(p);
      r = s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null;
    } catch {
      r = null;
    }
    this.statCache.set(p, r);
    return r;
  }

  private resolveMain(pkgDir: string, pj: PackageJson | null, kind: ResolveKind): string | null {
    const candidates = kind === 'import' ? [pj?.module, pj?.main] : [pj?.main];
    for (const c of candidates) {
      if (typeof c !== 'string' || !c) { continue; }
      const r = this.resolveFileOrDir(path.join(pkgDir, c));
      if (r) { return r; }
    }
    return this.resolveFileOrDir(path.join(pkgDir, 'index'));
  }

  private resolveFileOrDir(p: string): string | null {
    if (this.stat(p) === 'file') { return this.realpath(p); }
    for (const ext of FILE_EXTENSIONS) {
      if (this.stat(p + ext) === 'file') { return this.realpath(p + ext); }
    }
    if (this.stat(p) === 'dir') {
      const pj = this.readPackageJson(p);
      if (pj?.main) {
        const main = this.resolveFileOrDir(path.join(p, pj.main));
        if (main) { return main; }
      }
      for (const ext of FILE_EXTENSIONS) {
        const idx = path.join(p, 'index' + ext);
        if (this.stat(idx) === 'file') { return this.realpath(idx); }
      }
    }
    return null;
  }

  /** Resolve `subpath` through an `exports` or `imports` map. */
  private resolveMap(pkgDir: string, field: unknown, subpath: string, kind: ResolveKind): string | null {
    const map = subpath.startsWith('#') ? (field as Record<string, unknown>) : normalizeExports(field);
    const other: ResolveKind = kind === 'import' ? 'require' : 'import';
    for (const conditions of [CONDITIONS[kind], CONDITIONS[other]]) {
      const r = this.resolveMapWith(pkgDir, map, subpath, conditions);
      if (r) { return r; }
    }
    return null;
  }

  private resolveMapWith(pkgDir: string, map: Record<string, unknown>, subpath: string, conditions: ReadonlySet<string>): string | null {
    if (Object.prototype.hasOwnProperty.call(map, subpath) && !subpath.includes('*')) {
      return this.resolveTarget(pkgDir, map[subpath], null, conditions);
    }
    let bestKey: string | null = null;
    let bestMatch = '';
    for (const key of Object.keys(map)) {
      const star = key.indexOf('*');
      if (star >= 0) {
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
          if (!bestKey || prefix.length > bestKey.indexOf('*')) {
            bestKey = key;
            bestMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
          }
        }
      } else if (key.endsWith('/') && subpath.startsWith(key)) {
        if (!bestKey || key.length > bestKey.length) {
          bestKey = key;
          bestMatch = subpath.slice(key.length);
        }
      }
    }
    if (!bestKey) { return null; }
    if (bestKey.includes('*')) {
      return this.resolveTarget(pkgDir, map[bestKey], bestMatch, conditions);
    }
    const base = this.targetString(map[bestKey], conditions);
    return base ? this.resolveFileOrDir(path.join(pkgDir, base, bestMatch)) : null;
  }

  private resolveTarget(pkgDir: string, target: unknown, match: string | null, conditions: ReadonlySet<string>): string | null {
    const str = this.targetString(target, conditions);
    if (!str || !str.startsWith('./')) { return null; }
    const rel = match !== null ? str.split('*').join(match) : str;
    const full = path.join(pkgDir, rel);
    if (this.stat(full) === 'file') { return this.realpath(full); }
    return this.resolveFileOrDir(full);
  }

  /** Pick the target string for a conditions set (first matching key, in the map's order). */
  private targetString(target: unknown, conditions: ReadonlySet<string>): string | null {
    if (typeof target === 'string') { return target; }
    if (Array.isArray(target)) {
      for (const t of target) {
        const r = this.targetString(t, conditions);
        if (r) { return r; }
      }
      return null;
    }
    if (target && typeof target === 'object') {
      for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
        if (conditions.has(key)) {
          const r = this.targetString(value, conditions);
          if (r) { return r; }
        }
      }
    }
    return null;
  }

  /** Files matched by an exports pattern such as `"./*": "./dist/*.js"`. */
  private expandPattern(pkgDir: string, target: unknown, kind: ResolveKind): string[] {
    const other: ResolveKind = kind === 'import' ? 'require' : 'import';
    const str = this.targetString(target, CONDITIONS[kind]) ?? this.targetString(target, CONDITIONS[other]);
    if (!str || !str.startsWith('./') || !str.includes('*')) { return []; }
    const [before, after] = [str.slice(0, str.indexOf('*')), str.slice(str.indexOf('*') + 1)];
    const baseDir = path.join(pkgDir, path.dirname(before + 'x'));
    const prefix = path.join(pkgDir, before);
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') { walk(full); }
        } else if (full.startsWith(prefix) && full.endsWith(after)) {
          out.push(this.realpath(full));
        }
      }
    };
    walk(baseDir);
    return out;
  }
}

function normalizeExports(exportsField: unknown): Record<string, unknown> {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) { return { '.': exportsField }; }
  if (exportsField && typeof exportsField === 'object') {
    const obj = exportsField as Record<string, unknown>;
    return Object.keys(obj).some((k) => k.startsWith('.')) ? obj : { '.': obj };
  }
  return {};
}

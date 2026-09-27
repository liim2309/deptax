import {
  allTargets,
  type ImportBinding,
  type ModuleInfo,
  type NameSet,
  NO_NAMES,
} from './ModuleModel';

/**
 * Supplies analysed modules to the engine. Implementations cache analyses, so
 * `analyze` may be called repeatedly for the same file.
 */
export interface ModuleProvider {
  /** Analyse a module, or return null when it has no analysable structure (JSON, binaries). */
  analyze(file: string): Promise<ModuleInfo | null>;
  /**
   * True when including this module for no particular name has no observable
   * effect (package.json `"sideEffects": false`, Dart libraries). Such
   * modules are only included when one of their exports is needed.
   */
  sideEffectFree(file: string): boolean;
  /** Traversal is restricted to modules for which this returns true. */
  inScope(file: string): boolean;
}

type ExportTable = ReadonlySet<string> | 'OPEN';

interface FileState {
  info: ModuleInfo | null;
  whole: boolean;
  included: boolean;
  requested: Set<string> | 'ALL';
  live: Uint8Array;
  declIndex: Map<string, number[]>;
  bindingIndex: Map<string, ImportBinding>;
  openResolved: Set<string>;
}

/**
 * Tree-shaking style liveness analysis.
 *
 * Starting from requests "module M needs export names N", it marks the
 * top-level items that must be kept and propagates requests across modules:
 *
 *  - a live item makes the items and imported bindings it references live;
 *  - a requested export makes its declaring item live, or is forwarded along
 *    the matching re-export (`export { x } from`, `export * from`);
 *  - including a module makes its side-effecting items live and, unless the
 *    imported module is side-effect free, includes every module it imports.
 *
 * The result over-approximates the code the requests need at declaration
 * granularity: whatever is not marked live is not needed by static imports.
 * Requests only ever add names, so the analysis reaches a fixed point.
 */
export class LivenessAnalysis {
  private readonly states = new Map<string, FileState>();
  private readonly tables = new Map<string, ExportTable>();
  private readonly queue: Array<[string, NameSet]> = [];
  private head = 0;

  constructor(private readonly provider: ModuleProvider) {}

  request(target: string | null, names: NameSet): void {
    if (!target || !this.provider.inScope(target)) { return; }
    this.queue.push([target, names]);
  }

  async run(): Promise<void> {
    while (this.head < this.queue.length) {
      const [file, names] = this.queue[this.head++];
      await this.process(file, names);
    }
  }

  /** Modules included by the analysis. */
  includedFiles(): string[] {
    return [...this.states.entries()].filter(([, s]) => s.included).map(([f]) => f);
  }

  /** Fraction (0..1) of a module's source that is live; 0 when it was not included. */
  liveFraction(file: string): number {
    const st = this.states.get(file);
    if (!st || !st.included) { return 0; }
    if (st.whole || !st.info) { return 1; }
    const info = st.info;
    if (info.size <= 0) { return 1; }
    let itemTotal = 0;
    let liveTotal = 0;
    info.items.forEach((item, i) => {
      itemTotal += item.size;
      if (st.live[i]) { liveTotal += item.size; }
    });
    const overhead = Math.max(0, info.size - itemTotal);
    return Math.min(1, (overhead + liveTotal) / info.size);
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  private async state(file: string): Promise<FileState> {
    let st = this.states.get(file);
    if (st) { return st; }
    const info = await this.provider.analyze(file);
    const declIndex = new Map<string, number[]>();
    const bindingIndex = new Map<string, ImportBinding>();
    if (info) {
      info.items.forEach((item, i) => {
        for (const name of item.declares) {
          const list = declIndex.get(name);
          if (list) { list.push(i); } else { declIndex.set(name, [i]); }
        }
      });
      for (const b of info.bindings) { bindingIndex.set(b.local, b); }
    }
    st = {
      info,
      whole: !info || info.granularity === 'whole',
      included: false,
      requested: new Set(),
      live: new Uint8Array(info?.items.length ?? 0),
      declIndex,
      bindingIndex,
      openResolved: new Set(),
    };
    this.states.set(file, st);
    return st;
  }

  private async process(file: string, names: NameSet): Promise<void> {
    const st = await this.state(file);
    if (!st.included) {
      st.included = true;
      await this.include(st);
    }
    if (st.whole || st.requested === 'ALL') { return; }

    if (names === 'ALL') {
      st.requested = 'ALL';
      await this.requestAll(st);
      return;
    }
    const requested = st.requested;
    const delta = [...names].filter((n) => !requested.has(n));
    for (const n of delta) { requested.add(n); }
    for (const n of delta) { await this.requestName(st, n); }
  }

  private async include(st: FileState): Promise<void> {
    const info = st.info;
    if (!info) { return; }

    if (st.whole) {
      st.live.fill(1);
      for (const l of info.loads) { this.request(l.target, l.names); }
      for (const b of info.bindings) { this.followBinding(b); }
      for (const o of info.openImports) { this.request(o.target, 'ALL'); }
      for (const r of info.reexports) {
        this.request(r.target, r.kind === 'named' && r.imported !== '*' ? new Set([r.imported]) : 'ALL');
      }
      for (const item of info.items) {
        for (const l of item.loads) { this.request(l.target, l.names); }
      }
      return;
    }

    const roots: number[] = [];
    info.items.forEach((item, i) => { if (item.root) { roots.push(i); } });
    await this.markLive(st, roots);
    for (const l of info.loads) { this.request(l.target, l.names); }
    const seen = new Set<string>();
    for (const b of info.bindings) {
      if (!b.target || seen.has(b.target)) { continue; }
      seen.add(b.target);
      if (!this.provider.sideEffectFree(b.target)) { this.request(b.target, NO_NAMES); }
    }
  }

  private async requestAll(st: FileState): Promise<void> {
    const info = st.info!;
    const toMark: number[] = [];
    for (const local of info.localExports.values()) { this.resolveLocal(st, local, toMark); }
    for (const idxs of info.exportItems.values()) { toMark.push(...idxs); }
    for (const r of info.reexports) { if (r.item !== undefined) { toMark.push(r.item); } }
    await this.markLive(st, toMark);
    for (const r of info.reexports) {
      if (r.kind === 'named') {
        this.request(r.target, r.imported === '*' ? 'ALL' : new Set([r.imported]));
      } else {
        this.request(r.target, r.show ?? 'ALL');
      }
    }
  }

  private async requestName(st: FileState, name: string): Promise<void> {
    const info = st.info!;
    const toMark: number[] = [];
    let found = false;

    // CommonJS: the default import is the whole `module.exports` object.
    if (name === 'default' && info.openExports
      && !info.localExports.has('default') && !info.exportItems.has('default')) {
      st.requested = 'ALL';
      await this.requestAll(st);
      return;
    }

    const local = info.localExports.get(name);
    if (local !== undefined) {
      this.resolveLocal(st, local, toMark);
      found = true;
    }
    const items = info.exportItems.get(name);
    if (items) {
      toMark.push(...items);
      found = true;
    }
    for (const r of info.reexports) {
      if (r.kind === 'named' && r.exported === name) {
        this.request(r.target, r.imported === '*' ? 'ALL' : new Set([r.imported]));
        if (r.item !== undefined) { toMark.push(r.item); }
        found = true;
      }
    }
    if (!found && info.openExports) {
      // CommonJS `module.exports = value`: every property lives on that value.
      const defLocal = info.localExports.get('default');
      const defItems = info.exportItems.get('default') ?? [];
      if (defLocal !== undefined) { this.resolveLocal(st, defLocal, toMark); }
      toMark.push(...defItems);
      found = defLocal !== undefined || defItems.length > 0;
    }
    await this.markLive(st, toMark);
    if (found) { return; }

    for (const r of info.reexports) {
      if (r.kind !== 'star' || !r.target) { continue; }
      if (name === 'default' && info.starSkipsDefault) { continue; }
      if (r.show && !r.show.has(name)) { continue; }
      if (r.hide && r.hide.has(name)) { continue; }
      const table = await this.exportTable(r.target, new Set([st.info!.files[0]]));
      if (table === 'OPEN' || table.has(name)) {
        this.request(r.target, new Set([name]));
        if (r.item !== undefined) { await this.markLive(st, [r.item]); }
      }
    }
  }

  /** Mark a local name live: the items declaring it, or the import binding it refers to. */
  private resolveLocal(st: FileState, name: string, toMark: number[]): boolean {
    const idxs = st.declIndex.get(name);
    if (idxs) {
      toMark.push(...idxs);
      return true;
    }
    const binding = st.bindingIndex.get(name);
    if (binding) {
      this.followBinding(binding);
      return true;
    }
    return false;
  }

  private followBinding(b: ImportBinding): void {
    if (b.imported === '*') {
      this.request(b.target, b.show ?? 'ALL');
    } else {
      this.request(b.target, new Set([b.imported]));
    }
  }

  private async markLive(st: FileState, start: number[]): Promise<void> {
    const info = st.info!;
    const stack = [...start];
    const unresolved = new Set<string>();

    while (stack.length > 0) {
      const i = stack.pop()!;
      if (st.live[i]) { continue; }
      st.live[i] = 1;
      const item = info.items[i];

      for (const r of item.refs) {
        if (!this.resolveLocal(st, r, stack)) { unresolved.add(r); }
      }
      for (const [obj, members] of item.memberRefs) {
        const b = st.bindingIndex.get(obj);
        if (b && b.imported === '*') {
          const visible = b.show ? members.filter((m) => b.show!.has(m)) : members;
          this.request(b.target, new Set(visible));
        } else if (!this.resolveLocal(st, obj, stack)) {
          unresolved.add(obj);
        }
      }
      for (const l of item.loads) { this.request(l.target, l.names); }
    }

    // Identifiers not declared locally may come from an unprefixed (Dart) import.
    if (info.openImports.length === 0) { return; }
    for (const name of unresolved) {
      if (st.openResolved.has(name)) { continue; }
      st.openResolved.add(name);
      for (const o of info.openImports) {
        if (!o.target) { continue; }
        if (o.show && !o.show.has(name)) { continue; }
        if (o.hide && o.hide.has(name)) { continue; }
        const table = await this.exportTable(o.target, new Set());
        if (table === 'OPEN' || table.has(name)) {
          this.request(o.target, new Set([name]));
        }
      }
    }
  }

  /** Names a module exports, following re-exports. 'OPEN' when unknowable. */
  async exportTable(file: string, visiting: Set<string>): Promise<ExportTable> {
    const cached = this.tables.get(file);
    if (cached) { return cached; }
    const info = await this.provider.analyze(file);
    if (!info || info.granularity === 'whole' || info.openExports) {
      this.tables.set(file, 'OPEN');
      return 'OPEN';
    }
    const names = new Set<string>([...info.localExports.keys(), ...info.exportItems.keys()]);
    for (const r of info.reexports) {
      if (r.kind === 'named') { names.add(r.exported); }
    }
    const nextVisiting = new Set(visiting).add(file);
    for (const r of info.reexports) {
      if (r.kind !== 'star' || !r.target || nextVisiting.has(r.target)) { continue; }
      const sub = await this.exportTable(r.target, nextVisiting);
      if (sub === 'OPEN') {
        this.tables.set(file, 'OPEN');
        return 'OPEN';
      }
      for (const n of sub) {
        if (n === 'default' && info.starSkipsDefault) { continue; }
        if (r.show && !r.show.has(n)) { continue; }
        if (r.hide && r.hide.has(n)) { continue; }
        names.add(n);
      }
    }
    this.tables.set(file, names);
    return names;
  }
}

/**
 * File-level reachability: every module that can be loaded from `entries`,
 * following all imports and re-exports regardless of names.
 */
export async function reachableModules(
  provider: ModuleProvider,
  entries: Iterable<string>,
): Promise<Set<string>> {
  const visited = new Set<string>();
  const stack: string[] = [];
  for (const e of entries) {
    if (provider.inScope(e)) { stack.push(e); }
  }
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) { continue; }
    visited.add(file);
    const info = await provider.analyze(file);
    if (!info) { continue; }
    for (const t of allTargets(info)) {
      if (!visited.has(t) && provider.inScope(t)) { stack.push(t); }
    }
  }
  return visited;
}

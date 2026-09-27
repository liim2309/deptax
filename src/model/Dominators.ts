/**
 * Dominator analysis over a package dependency graph.
 *
 * A package d *dominates* a package v when every path from the project root to
 * v passes through d. Removing d from the manifest therefore removes exactly
 * the packages d dominates (d's dominator subtree): everything else is still
 * reachable through some other path. This is the same "retained size" idea
 * heap profilers use for objects.
 *
 * The implementation is the iterative algorithm from Cooper, Harvey & Kennedy,
 * "A Simple, Fast Dominance Algorithm" (2001). It handles cycles, which do
 * occur in npm dependency graphs.
 */

export interface Digraph {
  root: string;
  /** Successor lists. Nodes absent from the map have no outgoing edges. */
  successors: ReadonlyMap<string, readonly string[]>;
}

export interface DominatorTree {
  /** Immediate dominator of every node reachable from the root (root maps to itself). */
  idom: ReadonlyMap<string, string>;
  /** Children of each node in the dominator tree. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Nodes reachable from the root, in reverse postorder. */
  reachable: readonly string[];
}

export function computeDominators(graph: Digraph): DominatorTree {
  const { root, successors } = graph;

  // Iterative DFS for postorder numbering (dependency graphs can be deep).
  const postorder: string[] = [];
  const visited = new Set<string>([root]);
  const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const succ = successors.get(frame.node) ?? [];
    if (frame.next < succ.length) {
      const child = succ[frame.next++];
      if (!visited.has(child)) {
        visited.add(child);
        stack.push({ node: child, next: 0 });
      }
    } else {
      postorder.push(frame.node);
      stack.pop();
    }
  }

  const order = new Map<string, number>();
  postorder.forEach((n, i) => order.set(n, i));
  const rpo = [...postorder].reverse();

  const predecessors = new Map<string, string[]>();
  for (const n of rpo) {
    for (const s of successors.get(n) ?? []) {
      if (!order.has(s)) { continue; }
      const list = predecessors.get(s);
      if (list) { list.push(n); } else { predecessors.set(s, [n]); }
    }
  }

  const idom = new Map<string, string>([[root, root]]);
  const intersect = (a: string, b: string): string => {
    let f1 = a;
    let f2 = b;
    while (f1 !== f2) {
      while (order.get(f1)! < order.get(f2)!) { f1 = idom.get(f1)!; }
      while (order.get(f2)! < order.get(f1)!) { f2 = idom.get(f2)!; }
    }
    return f1;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const n of rpo) {
      if (n === root) { continue; }
      let newIdom: string | undefined;
      for (const p of predecessors.get(n) ?? []) {
        if (!idom.has(p)) { continue; }
        newIdom = newIdom === undefined ? p : intersect(p, newIdom);
      }
      if (newIdom !== undefined && idom.get(n) !== newIdom) {
        idom.set(n, newIdom);
        changed = true;
      }
    }
  }

  const children = new Map<string, string[]>();
  for (const n of rpo) {
    if (n === root) { continue; }
    const parent = idom.get(n)!;
    const list = children.get(parent);
    if (list) { list.push(n); } else { children.set(parent, [n]); }
  }

  return { idom, children, reachable: rpo };
}

/** All nodes dominated by `node`, including `node` itself. */
export function dominatedSet(tree: DominatorTree, node: string): Set<string> {
  const result = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (result.has(n)) { continue; }
    result.add(n);
    for (const c of tree.children.get(n) ?? []) { stack.push(c); }
  }
  return result;
}

/** Nodes reachable from `node` (including itself) along graph edges. */
export function reachableSet(graph: Digraph, node: string): Set<string> {
  const result = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (result.has(n)) { continue; }
    result.add(n);
    for (const s of graph.successors.get(n) ?? []) { stack.push(s); }
  }
  return result;
}

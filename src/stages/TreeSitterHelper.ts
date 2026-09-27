import * as path from 'path';
import Parser from 'web-tree-sitter';

/**
 * Shared Tree-sitter parsing helpers.
 *
 * `Parser.init()` must be called before any parsing; `ASTScanner.initialize()`
 * owns that call.  Each `parse*` function loads its grammar WASM lazily on the
 * first call and caches the resulting Language.
 */

let tsLanguage: Parser.Language | null = null;
let pyLanguage: Parser.Language | null = null;
let dartLanguage: Parser.Language | null = null;

/** Parse a TypeScript/JavaScript source file and return the syntax tree. */
export async function parseTypeScript(
  fileText: string,
  wasmDir: string,
): Promise<Parser.Tree> {
  if (!tsLanguage) {
    tsLanguage = await Parser.Language.load(
      path.join(wasmDir, 'tree-sitter-typescript.wasm'),
    );
  }
  const parser = new Parser();
  parser.setLanguage(tsLanguage);
  const tree = parser.parse(fileText);
  parser.delete();
  return tree;
}

/** Parse a Python source file and return the syntax tree. */
export async function parsePython(
  fileText: string,
  wasmDir: string,
): Promise<Parser.Tree> {
  if (!pyLanguage) {
    pyLanguage = await Parser.Language.load(
      path.join(wasmDir, 'tree-sitter-python.wasm'),
    );
  }
  const parser = new Parser();
  parser.setLanguage(pyLanguage);
  const tree = parser.parse(fileText);
  parser.delete();
  return tree;
}

/**
 * Parse a Dart source file and return the syntax tree.
 * Falls back to a stub (empty rootNode children) if the WASM is unavailable.
 */
export async function parseDart(
  fileText: string,
  wasmDir: string,
): Promise<Parser.Tree> {
  if (!dartLanguage) {
    dartLanguage = await Parser.Language.load(
      path.join(wasmDir, 'tree-sitter-dart.wasm'),
    );
  }
  const parser = new Parser();
  parser.setLanguage(dartLanguage);
  const tree = parser.parse(fileText);
  parser.delete();
  return tree;
}

/**
 * Walk all descendants of `node` and collect every node whose `type` is in
 * `targetTypes`.  Returns a flat list.
 */
export function collectNodes(
  node: Parser.SyntaxNode,
  targetTypes: ReadonlySet<string>,
): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (targetTypes.has(current.type)) {
      results.push(current);
    }
    for (let i = current.childCount - 1; i >= 0; i--) {
      const child = current.child(i);
      if (child) { stack.push(child); }
    }
  }
  return results;
}

import * as path from 'path';
import Parser from 'web-tree-sitter';

/**
 * Shared Tree-sitter setup. `loadGrammars()` must complete before `parse()` is
 * called; after that, parsing is synchronous.
 */

export type Grammar = 'typescript' | 'tsx' | 'python';
export type SyntaxNode = Parser.SyntaxNode;

const GRAMMAR_FILES: Record<Grammar, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
};

let initPromise: Promise<void> | null = null;
const languages = new Map<Grammar, Parser.Language>();
const parsers = new Map<Grammar, Parser>();

export function loadGrammars(wasmDir: string): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
      for (const [grammar, file] of Object.entries(GRAMMAR_FILES) as Array<[Grammar, string]>) {
        languages.set(grammar, await Parser.Language.load(path.join(wasmDir, file)));
      }
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

/** Parse source text. The caller must `delete()` the returned tree. */
export function parse(grammar: Grammar, text: string): Parser.Tree {
  let parser = parsers.get(grammar);
  if (!parser) {
    const language = languages.get(grammar);
    if (!language) { throw new Error(`Tree-sitter grammar "${grammar}" is not loaded`); }
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(grammar, parser);
  }
  return parser.parse(text);
}

/** Grammar for a JavaScript-family file. `.ts` uses the TypeScript grammar because `<T>x` casts are not valid TSX. */
export function jsGrammarFor(filePath: string): Grammar {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.ts' || ext === '.mts' || ext === '.cts' ? 'typescript' : 'tsx';
}

/** Unquoted value of a string literal node without interpolation, or null. */
export function stringLiteralValue(node: SyntaxNode | null | undefined): string | null {
  if (!node) { return null; }
  if (node.type === 'string') {
    return node.text.slice(1, -1);
  }
  if (node.type === 'template_string') {
    if (node.namedChildren.some((c) => c.type === 'template_substitution')) { return null; }
    return node.text.slice(1, -1);
  }
  return null;
}

/** True when an unnamed child token of `node` has the given text (e.g. `type`, `default`). */
export function hasToken(node: SyntaxNode, token: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === token) { return true; }
  }
  return false;
}

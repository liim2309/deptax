/**
 * Minimal YAML reader for pubspec.yaml and pubspec.lock: nested block
 * mappings with scalar values. Sequences and block scalars are skipped, flow
 * collections are kept as raw strings. Indentation is relative, so any
 * consistent indent width works.
 */

export type YamlValue = string | YamlMap;
export interface YamlMap { [key: string]: YamlValue }

export function parseYamlMap(text: string): YamlMap {
  const root: YamlMap = {};
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];
  let skipDeeperThan: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) { continue; }
    const indent = line.length - line.trimStart().length;
    if (skipDeeperThan !== null) {
      if (indent > skipDeeperThan) { continue; }
      skipDeeperThan = null;
    }
    const content = line.trim();
    if (content.startsWith('- ') || content === '-') {
      skipDeeperThan = indent;
      continue;
    }
    const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*)|\s*)$/.exec(content);
    if (!m) { continue; }
    const key = unquote(m[1]);
    const value = (m[2] ?? '').trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) { stack.pop(); }
    const parent = stack[stack.length - 1].map;

    if (value === '' ) {
      const child: YamlMap = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else if (/^[|>][-+]?\d*$/.test(value)) {
      parent[key] = '';
      skipDeeperThan = indent;
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

export function yamlMap(value: YamlValue | undefined): YamlMap {
  return value && typeof value === 'object' ? value : {};
}

export function yamlString(value: YamlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) { quote = null; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { return line.slice(0, i); }
  }
  return line;
}

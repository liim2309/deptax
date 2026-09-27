import * as fs from 'fs';
import * as path from 'path';

/** Directory names that never contain project source. */
const ALWAYS_SKIP = new Set(['node_modules', '__pycache__', 'site-packages', '.dart_tool']);

/**
 * List project source files. Skips hidden directories, dependency folders,
 * Python virtual environments (any directory holding `pyvenv.cfg`), Flutter's
 * `build/` output, nested projects with their own manifest, and directories
 * ignored by simple patterns in the workspace `.gitignore`. Scanning those
 * would count library code, or another project's code, as usage.
 */
export async function listProjectFiles(
  root: string,
  isSource: (file: string) => boolean,
  nestedProjectMarkers: readonly string[] = [],
): Promise<string[]> {
  const ignored = await gitignoredDirs(root);
  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root && entries.some((e) => e.name === 'pyvenv.cfg' || nestedProjectMarkers.includes(e.name))) {
      return; // a virtual environment, or a separate project with its own manifest
    }
    const isFlutterRoot = entries.some((e) => e.name === 'pubspec.yaml');
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || ALWAYS_SKIP.has(e.name)) { continue; }
        if (isFlutterRoot && e.name === 'build') { continue; }
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (ignored.names.has(e.name) || ignored.paths.has(rel)) { continue; }
        subdirs.push(full);
      } else if (e.isFile() && isSource(full)) {
        out.push(full);
      }
    }
    await Promise.all(subdirs.map(walk));
  };

  await walk(root);
  return out.sort();
}

/** Directory patterns from the root `.gitignore` that are plain names or paths (no wildcards, no negation). */
async function gitignoredDirs(root: string): Promise<{ names: Set<string>; paths: Set<string> }> {
  const names = new Set<string>();
  const paths = new Set<string>();
  let text = '';
  try { text = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8'); } catch { /* none */ }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line)) { continue; }
    const cleaned = line.replace(/\/$/, '');
    if (cleaned.startsWith('/')) {
      paths.add(cleaned.slice(1));
    } else if (cleaned.includes('/')) {
      paths.add(cleaned);
    } else {
      names.add(cleaned);
    }
  }
  return { names, paths };
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Stage 2 helper: list the files under a package directory with their sizes.
 * Directories named in `skipDirs` (such as nested `node_modules`, which hold
 * other packages) are not entered, and symbolic links are not followed.
 */
export async function listFiles(
  dir: string,
  skipDirs: ReadonlySet<string> = new Set(),
): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const batch = pending.splice(0, 32);
    await Promise.all(batch.map(async (d) => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      const sizes = await Promise.all(entries.map(async (e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!skipDirs.has(e.name)) { pending.push(full); }
          return null;
        }
        if (!e.isFile()) { return null; }
        try {
          return [full, (await fs.promises.stat(full)).size] as const;
        } catch {
          return null;
        }
      }));
      for (const s of sizes) { if (s) { files.set(s[0], s[1]); } }
    }));
  }
  return files;
}

export function sumSizes(files: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const size of files.values()) { total += size; }
  return total;
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively computes total size in KB and file count for a directory.
 * Returns zeros gracefully if the path does not exist (ENOENT).
 */
export async function computeDirSize(dirPath: string): Promise<{ sizeKb: number; fileCount: number }> {
  try {
    const entries = await fs.promises.readdir(dirPath, { recursive: true, withFileTypes: true });
    let totalBytes = 0;
    let fileCount = 0;
    for (const entry of entries) {
      if (!entry.isFile()) { continue; }
      const filePath = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path ?? dirPath, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat) {
        totalBytes += stat.size;
        fileCount++;
      }
    }
    return { sizeKb: totalBytes / 1024, fileCount };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sizeKb: 0, fileCount: 0 };
    }
    throw err;
  }
}

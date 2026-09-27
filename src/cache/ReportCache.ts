import * as fs from 'fs';
import * as path from 'path';
import type { DeptaxReport } from '../types/index';

const CACHE_FILE = 'deptax_report.json';
const CACHE_DIR = '.deptax';

export class ReportCache {
  async write(report: DeptaxReport, workspaceRoot: string): Promise<void> {
    const dir = path.join(workspaceRoot, CACHE_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, CACHE_FILE),
      JSON.stringify(report, null, 2),
      'utf8',
    );
  }

  async read(workspaceRoot: string): Promise<DeptaxReport | null> {
    try {
      const raw = await fs.promises.readFile(
        path.join(workspaceRoot, CACHE_DIR, CACHE_FILE),
        'utf8',
      );
      return JSON.parse(raw) as DeptaxReport;
    } catch {
      return null;
    }
  }
}

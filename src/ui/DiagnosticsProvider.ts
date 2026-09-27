import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DeptaxReport, Ecosystem, ScoredPackage } from '../types/index';
import { diagnosticMessage } from './format';

/** Manifests where an unused dependency is declared, per ecosystem. */
const MANIFESTS: Record<Ecosystem, string[]> = {
  npm: ['package.json'],
  pub: ['pubspec.yaml'],
  pip: ['requirements.txt', 'pyproject.toml', 'Pipfile'],
};

/**
 * Inline diagnostics: on the exact import statements of parasitic and bloated
 * packages (locations come from the scan, not from re-reading the files), and
 * on the manifest line of unused dependencies.
 */
export class DiagnosticsProvider {
  private readonly collection = vscode.languages.createDiagnosticCollection('deptax');

  async update(report: DeptaxReport, workspaceRoot: string): Promise<void> {
    this.collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, diag: vscode.Diagnostic) => {
      diag.source = 'DepTax';
      const list = byFile.get(file) ?? [];
      list.push(diag);
      byFile.set(file, list);
    };

    for (const pkg of report.packages) {
      if (pkg.status === 'parasitic' || pkg.status === 'bloated') {
        const severity = pkg.status === 'parasitic' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
        for (const site of pkg.importSites) {
          const range = new vscode.Range(site.line, 0, site.endLine, Number.MAX_SAFE_INTEGER);
          add(path.join(workspaceRoot, site.file), new vscode.Diagnostic(range, diagnosticMessage(pkg), severity));
        }
      } else if (pkg.status === 'unused') {
        const where = await findDeclaration(workspaceRoot, pkg);
        if (where) {
          const range = new vscode.Range(where.line, 0, where.line, Number.MAX_SAFE_INTEGER);
          add(where.file, new vscode.Diagnostic(range, diagnosticMessage(pkg), vscode.DiagnosticSeverity.Warning));
        }
      }
    }

    for (const [file, diags] of byFile) {
      this.collection.set(vscode.Uri.file(file), diags);
    }
  }

  dispose(): void {
    this.collection.clear();
    this.collection.dispose();
  }
}

/** Line of the manifest that declares the package. */
async function findDeclaration(root: string, pkg: ScoredPackage): Promise<{ file: string; line: number } | null> {
  const name = pkg.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: RegExp[] = pkg.ecosystem === 'npm'
    ? [new RegExp(`^\\s*"${name}"\\s*:`)]
    : pkg.ecosystem === 'pub'
      ? [new RegExp(`^\\s+${name}\\s*:`)]
      : [new RegExp(`^\\s*["']?${name}(?![A-Za-z0-9_.-])`, 'i')];
  for (const manifest of MANIFESTS[pkg.ecosystem]) {
    const file = path.join(root, manifest);
    let text: string;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const line = lines.findIndex((l) => patterns.some((p) => p.test(l)));
    if (line >= 0) { return { file, line }; }
  }
  return null;
}

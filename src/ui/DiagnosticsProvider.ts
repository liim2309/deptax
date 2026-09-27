import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DeptaxReport, ScoredPackage } from '../types/index';

const SOURCE_GLOB = '**/*.{ts,js,tsx,jsx,dart,py}';

export class DiagnosticsProvider {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('deptax');
  }

  async update(report: DeptaxReport, workspaceRoot: string): Promise<void> {
    this.collection.clear();

    const flagged = report.packages.filter(
      (p) => p.status === 'parasitic' || p.status === 'bloated',
    );
    if (flagged.length === 0) {
      return;
    }

    // Collect all source files once
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceRoot, SOURCE_GLOB),
      '**/node_modules/**',
    );

    // Map: file URI string → diagnostics[]
    const diagMap = new Map<string, vscode.Diagnostic[]>();

    for (const pkg of flagged) {
      for (const uri of uris) {
        let text: string;
        try {
          text = fs.readFileSync(uri.fsPath, 'utf8');
        } catch {
          continue;
        }

        const ext = path.extname(uri.fsPath);
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!matchesImport(line, pkg.packageName, ext)) {
            continue;
          }

          const range = new vscode.Range(i, 0, i, line.length);
          const diag = new vscode.Diagnostic(
            range,
            buildMessage(pkg),
            pkg.status === 'parasitic'
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Warning,
          );
          diag.source = 'DepTax';

          const key = uri.toString();
          const list = diagMap.get(key) ?? [];
          list.push(diag);
          diagMap.set(key, list);
        }
      }
    }

    for (const [uriStr, diags] of diagMap) {
      this.collection.set(vscode.Uri.parse(uriStr), diags);
    }
  }

  dispose(): void {
    this.collection.clear();
    this.collection.dispose();
  }
}

function matchesImport(line: string, packageName: string, ext: string): boolean {
  if (ext === '.dart') {
    return new RegExp(`import\\s+['"]package:${escapeRe(packageName)}\\/`).test(line);
  }
  if (ext === '.py') {
    return new RegExp(`(?:from|import)\\s+${escapeRe(packageName)}(?:\\s|$|\\.)`).test(line);
  }
  // TS / JS / TSX / JSX
  return new RegExp(`import\\s+.*from\\s+['"]${escapeRe(packageName)}['"]`).test(line);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMessage(pkg: ScoredPackage): string {
  if (pkg.status === 'parasitic') {
    return (
      `DepTax 🔴 "${pkg.packageName}" — Score: ${pkg.deptaxScore.toFixed(0)} (Parasitic). ` +
      `Using ${pkg.usedSymbols.length} of ${pkg.exportedSymbolCount} exported APIs. ` +
      `Run "DepTax: Open Report" for details.`
    );
  }
  return (
    `DepTax 🟡 "${pkg.packageName}" — Score: ${pkg.deptaxScore.toFixed(0)} (Bloated). ` +
    `Using ${pkg.usedSymbols.length} of ${pkg.exportedSymbolCount} APIs.`
  );
}

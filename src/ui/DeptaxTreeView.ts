import * as path from 'path';
import * as vscode from 'vscode';
import type { DeptaxReport, ImportSite, ScoredPackage, UsedSymbol } from '../types/index';
import { formatBytes, formatPercent, STATUS_EMOJI, STATUS_LABEL, usageSummary } from './format';

type DeptaxTreeItem = PackageTreeItem | SymbolTreeItem | FileTreeItem;

class PackageTreeItem extends vscode.TreeItem {
  readonly kind = 'package' as const;
  constructor(readonly pkg: ScoredPackage) {
    super(
      `${STATUS_EMOJI[pkg.status]} ${pkg.packageName}`,
      pkg.usedSymbols.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.description = usageSummary(pkg);
    this.tooltip = tooltipFor(pkg);
    this.iconPath = iconFor(pkg);
    this.contextValue = 'deptaxPackage';
  }
}

class SymbolTreeItem extends vscode.TreeItem {
  readonly kind = 'symbol' as const;
  constructor(readonly symbol: UsedSymbol, readonly sites: ImportSite[]) {
    super(
      symbol.name === 'default' || symbol.name === '*' ? `${symbol.module} (${symbol.name})` : symbol.name,
      symbol.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const refs = symbol.references + symbol.typeReferences;
    this.description = symbol.references === 0 && symbol.typeReferences > 0
      ? 'types only'
      : `${refs} reference${refs === 1 ? '' : 's'}`;
    this.contextValue = 'deptaxSymbol';
  }
}

class FileTreeItem extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(file: string, line: number, workspaceRoot: string) {
    super(`${file}:${line + 1}`, vscode.TreeItemCollapsibleState.None);
    const uri = vscode.Uri.file(path.join(workspaceRoot, file));
    this.resourceUri = uri;
    this.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }],
    };
    this.contextValue = 'deptaxFile';
  }
}

export class DeptaxTreeView implements vscode.TreeDataProvider<DeptaxTreeItem> {
  private readonly changed = new vscode.EventEmitter<DeptaxTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private report: DeptaxReport | undefined;

  constructor(private readonly workspaceRoot: string) {}

  refresh(report: DeptaxReport): void {
    this.report = report;
    this.changed.fire();
  }

  getTreeItem(element: DeptaxTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeptaxTreeItem): vscode.ProviderResult<DeptaxTreeItem[]> {
    if (!element) {
      return (this.report?.packages ?? []).map((pkg) => new PackageTreeItem(pkg));
    }
    if (element.kind === 'package') {
      return element.pkg.usedSymbols.map((s) => new SymbolTreeItem(
        s,
        element.pkg.importSites.filter((site) => s.files.includes(site.file)),
      ));
    }
    if (element.kind === 'symbol') {
      return element.symbol.files.map((f) => {
        const site = element.sites.find((s) => s.file === f);
        return new FileTreeItem(f, site?.line ?? 0, this.workspaceRoot);
      });
    }
    return [];
  }
}

function tooltipFor(pkg: ScoredPackage): vscode.MarkdownString {
  const m = pkg.metrics;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${pkg.packageName}** ${pkg.installedVersion ? `v${pkg.installedVersion}` : ''} — `
    + `${STATUS_LABEL[pkg.status]}: ${pkg.statusReason}\n\n`);
  if (m.codeBytes !== null && m.usedCodeBytes !== null && m.utilization !== null) {
    md.appendMarkdown(`- Code used: ${formatBytes(m.usedCodeBytes)} of ${formatBytes(m.codeBytes)} `
      + `(${formatPercent(m.utilization)})\n`);
  }
  md.appendMarkdown(`- Removing it frees: ${formatBytes(m.retainedDiskBytes)}`
    + (m.exclusiveDependencies.length > 0 ? ` (with ${m.exclusiveDependencies.length} dependencies)` : '') + '\n');
  if (m.exportCoverage) {
    md.appendMarkdown(`- Exports used: ${m.exportCoverage.used} of ${m.exportCoverage.total}\n`);
  }
  if (pkg.eviction.available) { md.appendMarkdown('- A native replacement is available\n'); }
  for (const note of pkg.notes) { md.appendMarkdown(`\n_${note}_\n`); }
  return md;
}

function iconFor(pkg: ScoredPackage): vscode.ThemeIcon {
  switch (pkg.status) {
    case 'parasitic': return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'bloated': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case 'unused': return new vscode.ThemeIcon('circle-slash');
    case 'tooling': return new vscode.ThemeIcon('tools');
    case 'unmeasured': return new vscode.ThemeIcon('question');
    default: return new vscode.ThemeIcon('pass');
  }
}

import * as vscode from 'vscode';
import type { DeptaxReport, ScoredPackage, UsedSymbol } from '../types/index';

// ── Tree item types ──────────────────────────────────────────────────────────

type DeptaxTreeItem = PackageTreeItem | SymbolTreeItem | FileTreeItem;

class PackageTreeItem extends vscode.TreeItem {
  readonly kind = 'package' as const;
  constructor(readonly pkg: ScoredPackage) {
    super(
      `${statusEmoji(pkg)} ${pkg.packageName} — ${pkg.deptaxScore.toFixed(0)} (${formatSize(pkg.diskSizeKb)})`,
      pkg.usedSymbols.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.iconPath = iconForStatus(pkg.status);
    this.tooltip = `${pkg.packageName} v${pkg.installedVersion} — ${pkg.status}`;
    this.contextValue = 'deptaxPackage';
  }
}

class SymbolTreeItem extends vscode.TreeItem {
  readonly kind = 'symbol' as const;
  constructor(readonly symbol: UsedSymbol) {
    super(
      `${symbol.symbolName}() — ${symbol.callCount} call${symbol.callCount !== 1 ? 's' : ''}`,
      symbol.files.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'deptaxSymbol';
  }
}

class FileTreeItem extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(readonly filePath: string) {
    super(filePath, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(filePath)],
    };
    this.contextValue = 'deptaxFile';
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class DeptaxTreeView implements vscode.TreeDataProvider<DeptaxTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DeptaxTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private report: DeptaxReport | undefined;

  refresh(report: DeptaxReport): void {
    this.report = report;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DeptaxTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeptaxTreeItem): vscode.ProviderResult<DeptaxTreeItem[]> {
    if (!element) {
      // Root: return packages sorted by score descending
      if (!this.report) {
        return [];
      }
      return [...this.report.packages]
        .sort((a, b) => b.deptaxScore - a.deptaxScore)
        .map((pkg) => new PackageTreeItem(pkg));
    }

    if (element.kind === 'package') {
      return element.pkg.usedSymbols.map((sym) => new SymbolTreeItem(sym));
    }

    if (element.kind === 'symbol') {
      return element.symbol.files.map((f) => new FileTreeItem(f));
    }

    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusEmoji(pkg: ScoredPackage): string {
  if (pkg.status === 'parasitic') return '🔴';
  if (pkg.status === 'bloated') return '🟡';
  return '🟢';
}

function formatSize(kb: number): string {
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`;
  }
  return `${kb.toFixed(0)} KB`;
}

function iconForStatus(status: ScoredPackage['status']): vscode.ThemeIcon {
  if (status === 'parasitic') return new vscode.ThemeIcon('error');
  if (status === 'bloated') return new vscode.ThemeIcon('warning');
  return new vscode.ThemeIcon('pass');
}

import * as vscode from 'vscode';
import type { DeptaxReport } from '../types/index';

export class DeptaxStatusBarItem {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'deptax.openReport';
    this.item.text = '$(sync~spin) DepTax';
    this.item.show();
  }

  update(report: DeptaxReport): void {
    const { parasitic, bloated, unused } = report.summary.byStatus;
    const parts: string[] = [];
    if (parasitic > 0) { parts.push(`${parasitic} parasitic`); }
    if (bloated > 0) { parts.push(`${bloated} bloated`); }
    if (unused > 0) { parts.push(`${unused} unused`); }

    if (parts.length > 0) {
      this.item.text = `$(${parasitic > 0 ? 'bug' : 'warning'}) ${parts.join(' · ')}`;
      this.item.backgroundColor = parasitic > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.item.tooltip = 'DepTax found dependencies that cost more than they are used — click to open the report';
    } else {
      this.item.text = '$(check) DepTax: Clean';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'DepTax: no parasitic, bloated or unused dependencies';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

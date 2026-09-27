import * as vscode from 'vscode';
import type { DeptaxReport } from '../types/index';

export class DeptaxStatusBarItem {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'deptax.openReport';
    this.item.show();
  }

  update(report: DeptaxReport): void {
    if (report.parasiticPackagesCount > 0) {
      this.item.text = `$(bug) ${report.parasiticPackagesCount} Parasitic`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = 'DepTax found parasitic dependencies — click to open report';
    } else {
      this.item.text = '$(check) DepTax: Clean';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'DepTax: No parasitic dependencies found';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

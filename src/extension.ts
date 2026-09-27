import * as path from 'path';
import * as vscode from 'vscode';
import { ScanOrchestrator } from './orchestrator/ScanOrchestrator';
import type { DeptaxReport } from './types/index';
import { DiagnosticsProvider } from './ui/DiagnosticsProvider';
import { DeptaxTreeView } from './ui/DeptaxTreeView';
import { ReportWebViewPanel } from './ui/ReportWebViewPanel';
import { DeptaxStatusBarItem } from './ui/StatusBarItem';

// Known manifest filenames that should trigger a re-scan when saved
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pubspec.yaml',
  'requirements.txt',
  'pyproject.toml',
  'pubspec.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pnpm-lock.yaml',
]);

// Source file extensions that should trigger a re-scan when saved
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.dart', '.py']);

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    console.warn('[DepTax] No workspace folder found — skipping scan.');
    return;
  }

  const wasmDir = path.join(context.extensionPath, 'resources');
  const orchestrator = new ScanOrchestrator(wasmDir);

  // UI providers
  const diagnosticsProvider = new DiagnosticsProvider();
  const treeView = new DeptaxTreeView();
  const statusBarItem = new DeptaxStatusBarItem();

  const treeViewRegistration = vscode.window.createTreeView('deptaxView', {
    treeDataProvider: treeView,
  });

  let lastReport: DeptaxReport | undefined;

  async function runScan(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'DepTax: Scanning...' },
      async () => {
        try {
          lastReport = await orchestrator.run(workspaceRoot!);
          console.log('[DepTax] Scan complete:', JSON.stringify(lastReport, null, 2));

          await diagnosticsProvider.update(lastReport, workspaceRoot!);
          treeView.refresh(lastReport);
          statusBarItem.update(lastReport);
        } catch (err) {
          console.error('[DepTax] Scan failed:', err);
        }
      },
    );
  }

  // Manual scan command
  const scanCmd = vscode.commands.registerCommand('deptax.scan', () => runScan());

  // Open report command
  const reportCmd = vscode.commands.registerCommand('deptax.openReport', () => {
    if (lastReport) {
      ReportWebViewPanel.createOrShow(context.extensionUri, lastReport);
    } else {
      vscode.window.showInformationMessage('DepTax: No report available yet — run a scan first.');
    }
  });

  // Re-scan on save of any manifest or source file
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    const basename = path.basename(doc.fileName);
    const ext = path.extname(doc.fileName);
    if (MANIFEST_BASENAMES.has(basename) || SOURCE_EXTENSIONS.has(ext)) {
      void runScan();
    }
  });

  context.subscriptions.push(
    scanCmd,
    reportCmd,
    saveListener,
    diagnosticsProvider,
    treeViewRegistration,
    statusBarItem,
  );

  // Initial scan on activation
  void runScan();
}

export function deactivate(): void {
  // nothing to clean up yet
}

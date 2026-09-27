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
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
]);

// Source file extensions that should trigger a re-scan when saved
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.dart', '.py']);

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
  const treeView = new DeptaxTreeView(workspaceRoot);
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

          await diagnosticsProvider.update(lastReport, workspaceRoot!);
          treeView.refresh(lastReport);
          statusBarItem.update(lastReport);
          ReportWebViewPanel.currentPanel?.update(lastReport);
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
      ReportWebViewPanel.createOrShow(lastReport);
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

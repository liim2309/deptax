import * as vscode from 'vscode';
import type { DeptaxReport, ScoredPackage } from '../types/index';

export class ReportWebViewPanel {
  static currentPanel: ReportWebViewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private report: DeptaxReport;

  private constructor(panel: vscode.WebviewPanel, report: DeptaxReport) {
    this.panel = panel;
    this.report = report;

    this.panel.webview.html = getHtmlContent(this.panel.webview, report);

    this.panel.onDidDispose(() => {
      ReportWebViewPanel.currentPanel = undefined;
    });
  }

  static createOrShow(extensionUri: vscode.Uri, report: DeptaxReport): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (ReportWebViewPanel.currentPanel) {
      ReportWebViewPanel.currentPanel.panel.reveal(column);
      ReportWebViewPanel.currentPanel.update(report);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'deptaxReport',
      'DepTax Report',
      column ?? vscode.ViewColumn.One,
      { enableScripts: true },
    );

    ReportWebViewPanel.currentPanel = new ReportWebViewPanel(panel, report);
  }

  update(report: DeptaxReport): void {
    this.report = report;
    this.panel.webview.html = getHtmlContent(this.panel.webview, report);
    void this.panel.webview.postMessage({ type: 'update', report });
  }

  dispose(): void {
    this.panel.dispose();
  }
}

// ── HTML generation ───────────────────────────────────────────────────────────

function getHtmlContent(webview: vscode.Webview, report: DeptaxReport): string {
  const sorted = [...report.packages].sort((a, b) => b.deptaxScore - a.deptaxScore);

  const rows = sorted.map((pkg) => packageRow(pkg)).join('\n');
  const parasiticCount = report.parasiticPackagesCount;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DepTax Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, "Segoe UI", system-ui, sans-serif);
      font-size: 13px;
      color: var(--vscode-editor-foreground, #1f2328);
      background: var(--vscode-editor-background, #fff);
      padding: 16px 20px 32px;
    }
    h1 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .summary-card {
      background: var(--vscode-sideBar-background, #f7f8fa);
      border: 1px solid var(--vscode-panel-border, #e5e7eb);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
    }
    .summary-card .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background, #3b82d4);
      color: var(--vscode-badge-foreground, #fff);
    }
    .summary-stat { font-size: 13px; color: var(--vscode-descriptionForeground, #57606a); }
    .summary-stat strong { color: var(--vscode-editor-foreground, #1f2328); }
    .actions { margin-bottom: 12px; }
    button {
      font-family: inherit;
      font-size: 12px;
      padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, #0000001a);
      border-radius: 4px;
      background: var(--vscode-button-background, #3b82d4);
      color: var(--vscode-button-foreground, #fff);
      cursor: pointer;
    }
    button:hover { opacity: 0.88; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
      text-align: left;
      padding: 6px 10px;
      background: var(--vscode-sideBar-background, #f7f8fa);
      border-bottom: 2px solid var(--vscode-panel-border, #e5e7eb);
      font-weight: 600;
      white-space: nowrap;
    }
    td { padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border, #e5e7eb); vertical-align: top; }
    tr.row-parasitic td { background: #fff0f0; }
    tr.row-bloated td { background: #fffbe6; }
    details summary { cursor: pointer; color: var(--vscode-textLink-foreground, #3b82d4); }
    details ul { list-style: none; padding-left: 8px; margin-top: 4px; color: var(--vscode-descriptionForeground, #57606a); }
    .score { font-weight: 600; }
    .status-parasitic { color: #c0392b; font-weight: 600; }
    .status-bloated    { color: #c07800; font-weight: 600; }
    .status-healthy    { color: #27ae60; font-weight: 600; }
  </style>
</head>
<body>
  <h1>DepTax Report</h1>
  <div class="summary-card">
    <span class="badge">${report.ecosystem.toUpperCase()}</span>
    <span class="summary-stat"><strong>${report.projectName}</strong></span>
    <span class="summary-stat">Total audited: <strong>${report.totalPackagesAudited}</strong></span>
    <span class="summary-stat">Parasitic: <strong style="color:#c0392b">${parasiticCount}</strong></span>
    <span class="summary-stat" style="margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground)">
      ${new Date(report.generatedAt).toLocaleString()}
    </span>
  </div>

  <div class="actions">
    <button id="refreshBtn">↻ Refresh</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Package</th>
        <th>Footprint</th>
        <th>Exports</th>
        <th>Used</th>
        <th>Score</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="tableBody">
${rows}
    </tbody>
  </table>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    // Handle update messages from the extension (re-render is handled server-side via postMessage + html reset)
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        // Full page refresh is handled by the extension setting panel.webview.html
        // This handler is a hook for future partial updates
      }
    });
  </script>
</body>
</html>`;
}

function packageRow(pkg: ScoredPackage): string {
  const rowClass =
    pkg.status === 'parasitic' ? 'row-parasitic' :
    pkg.status === 'bloated'   ? 'row-bloated'   : '';

  const statusClass = `status-${pkg.status}`;
  const statusLabel =
    pkg.status === 'parasitic' ? '🔴 Parasitic' :
    pkg.status === 'bloated'   ? '🟡 Bloated'   : '🟢 Healthy';

  const usedCell = buildUsedCell(pkg);

  return /* html */ `      <tr class="${rowClass}">
        <td>${escapeHtml(pkg.packageName)}<br><small style="color:var(--vscode-descriptionForeground)">v${escapeHtml(pkg.installedVersion)}</small></td>
        <td>${formatSize(pkg.diskSizeKb)}</td>
        <td>${pkg.exportedSymbolCount}</td>
        <td>${usedCell}</td>
        <td class="score">${pkg.deptaxScore.toFixed(0)}</td>
        <td class="${statusClass}">${statusLabel}</td>
      </tr>`;
}

function buildUsedCell(pkg: ScoredPackage): string {
  if (pkg.usedSymbols.length === 0) {
    return '0';
  }
  const items = pkg.usedSymbols
    .map((s) => `<li>${escapeHtml(s.symbolName)}() ×${s.callCount}</li>`)
    .join('');
  return `<details><summary>${pkg.usedSymbols.length}</summary><ul>${items}</ul></details>`;
}

function formatSize(kb: number): string {
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`;
  }
  return `${kb.toFixed(0)} KB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

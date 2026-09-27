import * as vscode from 'vscode';
import type { DeptaxReport, PackageStatus, ScoredPackage } from '../types/index';
import { STATUS_ORDER } from '../model/Classifier';
import { formatBytes, formatPercent, STATUS_EMOJI, STATUS_LABEL } from './format';

export class ReportWebViewPanel {
  static currentPanel: ReportWebViewPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel, report: DeptaxReport) {
    this.update(report);
    this.panel.onDidDispose(() => { ReportWebViewPanel.currentPanel = undefined; });
    this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === 'refresh') { void vscode.commands.executeCommand('deptax.scan'); }
    });
  }

  static createOrShow(report: DeptaxReport): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ReportWebViewPanel.currentPanel) {
      ReportWebViewPanel.currentPanel.panel.reveal(column);
      ReportWebViewPanel.currentPanel.update(report);
      return;
    }
    const panel = vscode.window.createWebviewPanel('deptaxReport', 'DepTax Report', column, { enableScripts: true });
    ReportWebViewPanel.currentPanel = new ReportWebViewPanel(panel, report);
  }

  update(report: DeptaxReport): void {
    this.panel.webview.html = renderHtml(this.panel.webview, report);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

// ── HTML ────────────────────────────────────────────────────────────────────

function renderHtml(webview: vscode.Webview, report: DeptaxReport): string {
  const s = report.summary;
  const chips = STATUS_ORDER
    .filter((status) => s.byStatus[status] > 0)
    .map((status) => `<span class="chip ${status}">${STATUS_EMOJI[status]} ${s.byStatus[status]} ${STATUS_LABEL[status].toLowerCase()}</span>`)
    .join('');
  const warnings = report.warnings.length > 0
    ? `<details class="warnings"><summary>${report.warnings.length} scan note${report.warnings.length === 1 ? '' : 's'}</summary><ul>${
      report.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`
    : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DepTax Report</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 16px 20px 32px; margin: 0; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 12px;
             color: var(--vscode-descriptionForeground); }
  .summary strong { color: var(--vscode-foreground); }
  .chip { padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground); font-size: 12px; }
  button { font: inherit; font-size: 12px; padding: 4px 12px; border: 0; border-radius: 3px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
       font-weight: 600; white-space: nowrap; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  tr.parasitic td:first-child { box-shadow: inset 3px 0 var(--vscode-errorForeground); }
  tr.bloated td:first-child { box-shadow: inset 3px 0 var(--vscode-editorWarning-foreground); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar { height: 6px; width: 120px; background: var(--vscode-input-background); border-radius: 3px;
         overflow: hidden; margin-top: 4px; }
  .bar > span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
  ul { margin: 4px 0 0; padding-left: 18px; }
  .warnings { margin-top: 16px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>DepTax Report — ${esc(report.projectName)}</h1>
  <div class="summary">
    ${chips}
    <span>Installed: <strong>${formatBytes(s.installedDiskBytes)}</strong></span>
    <span>Unused code in scored packages: <strong>${formatBytes(s.unusedCodeBytes)}</strong></span>
    <span>${esc(report.ecosystems.join(', ') || 'no ecosystem')} · ${report.scannedFiles} files ·
      ${esc(new Date(report.generatedAt).toLocaleString())}</span>
    <button id="refresh">Rescan</button>
  </div>
  <table>
    <thead><tr>
      <th>Package</th><th>Status</th><th>Code used</th><th>Removing frees</th><th>Used symbols</th>
    </tr></thead>
    <tbody>
${report.packages.map(packageRow).join('\n')}
    </tbody>
  </table>
  ${warnings}
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
</script>
</body>
</html>`;
}

function packageRow(pkg: ScoredPackage): string {
  const m = pkg.metrics;
  const version = pkg.installedVersion ? `v${esc(pkg.installedVersion)}` : esc(pkg.declaredVersion);
  const used = m.utilization !== null && m.codeBytes !== null && m.usedCodeBytes !== null
    ? `<span class="num">${formatBytes(m.usedCodeBytes)} of ${formatBytes(m.codeBytes)} (${formatPercent(m.utilization)})</span>
       <div class="bar"><span style="width:${Math.max(1, Math.round(m.utilization * 100))}%"></span></div>`
    : '<span class="muted">–</span>';
  const freed = `<span class="num">${formatBytes(m.retainedDiskBytes)}</span>`
    + (m.exclusiveDependencies.length > 0
      ? `<div class="muted">with ${m.exclusiveDependencies.length} dependenc${m.exclusiveDependencies.length === 1 ? 'y' : 'ies'}</div>`
      : '');
  const coverage = m.exportCoverage ? ` <span class="muted">(${m.exportCoverage.used} of ${m.exportCoverage.total} exports)</span>` : '';
  const symbols = pkg.usedSymbols.length > 0
    ? `<details><summary>${pkg.usedSymbols.length}</summary><ul>${pkg.usedSymbols.map((sym) =>
      `<li>${esc(sym.name === 'default' || sym.name === '*' ? `${sym.module} (${sym.name})` : sym.name)}
        <span class="muted">× ${sym.references}${sym.typeReferences ? ` · ${sym.typeReferences} type` : ''}</span></li>`).join('')}</ul></details>${coverage}`
    : '<span class="muted">none</span>';
  const notes = pkg.notes.length > 0 || pkg.eviction.available
    ? `<ul class="muted">${pkg.eviction.available ? '<li>A native replacement is available.</li>' : ''}${
      pkg.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';

  return `      <tr class="${pkg.status}">
        <td><strong>${esc(pkg.packageName)}</strong> <span class="muted">${version} · ${pkg.ecosystem}</span>${notes}</td>
        <td>${STATUS_EMOJI[pkg.status]} ${statusLabel(pkg.status)}<div class="muted">${esc(pkg.statusReason)}</div></td>
        <td>${used}</td>
        <td>${freed}</td>
        <td>${symbols}</td>
      </tr>`;
}

function statusLabel(status: PackageStatus): string {
  return STATUS_LABEL[status];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

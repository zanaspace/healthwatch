const fs = require('fs');
const path = require('path');

/**
 * Generates a self-contained interactive HTML Health Dashboard inside latestDir/index.html
 * and appends compact run metrics to reports/history.json.
 */
function buildHealthDashboard(runReport, reportsRoot, latestDir) {
  const historyPath = path.join(reportsRoot, 'history.json');
  let history = [];
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (_) {}
  }

  history.unshift({
    runId: runReport.runId,
    timestamp: runReport.timestamp,
    targets: runReport.targets.map(t => ({
      targetId: t.targetId,
      targetName: t.targetName,
      counts: t.summaryCounts
    }))
  });
  history = history.slice(0, 30);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  const payload = { runReport, history };
  const html = renderDashboardHtml(payload);
  const outPath = path.join(latestDir, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

function renderDashboardHtml(payload) {
  const jsonSafe = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Autonomous AI Product Health Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#F8FAFC; --surface:#FFFFFF; --border:#E2E8F0; --navy:#0B192C; --gold:#E8A230;
      --text:#0F172A; --muted:#64748B;
      --ok-bg:#ECFDF5; --ok-fg:#065F46; --ok-bd:#A7F3D0;
      --warn-bg:#FEFCE8; --warn-fg:#854D0E; --warn-bd:#FEF08A;
      --down-bg:#FEF2F2; --down-fg:#991B1B; --down-bd:#FECACA;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); padding-bottom:60px; }
    header { background:linear-gradient(135deg,var(--navy),#153052); color:#fff; padding:24px 32px; border-bottom:4px solid var(--gold); }
    .head-in { max-width:1400px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; }
    h1 { font-family:'Plus Jakarta Sans',sans-serif; font-size:22px; font-weight:800; }
    .sub { color:#CBD5E1; font-size:13px; margin-top:4px; }
    .pill { background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); padding:6px 12px; border-radius:8px; font-size:12px; }
    .wrap { max-width:1400px; margin:24px auto 0; padding:0 28px; }
    .target-tabs { display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap; }
    .t-tab { padding:10px 18px; border-radius:10px; border:1px solid var(--border); background:#fff; font-weight:700; cursor:pointer; font-size:13.5px; }
    .t-tab.active { background:var(--navy); color:#fff; border-color:var(--navy); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px; margin-bottom:20px; }
    .stat { background:#fff; border:1px solid var(--border); border-radius:12px; padding:16px 18px; }
    .stat-l { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--muted); }
    .stat-v { font-family:'Plus Jakarta Sans',sans-serif; font-size:28px; font-weight:800; margin-top:4px; }
    .stat.ok .stat-v { color:var(--ok-fg); } .stat.warn .stat-v { color:var(--warn-fg); } .stat.down .stat-v { color:var(--down-fg); }
    .ai-box { background:#fff; border:1px solid var(--border); border-left:5px solid var(--gold); border-radius:12px; padding:18px 22px; margin-bottom:20px; }
    .ai-box h3 { font-family:'Plus Jakarta Sans',sans-serif; font-size:15px; color:var(--navy); margin-bottom:8px; display:flex; justify-content:space-between; }
    .ai-box p { font-size:13.5px; color:#334155; margin-bottom:10px; }
    .ai-box ul { padding-left:20px; font-size:13px; color:#334155; display:flex; flex-direction:column; gap:4px; }
    .controls { display:flex; gap:10px; justify-content:space-between; flex-wrap:wrap; margin-bottom:16px; }
    .f-group { display:flex; gap:8px; flex-wrap:wrap; }
    .f-btn { padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:#fff; font-size:12.5px; font-weight:600; cursor:pointer; }
    .f-btn.active { background:var(--navy); color:#fff; border-color:var(--navy); }
    .search { padding:7px 12px; border:1px solid var(--border); border-radius:8px; min-width:260px; font-size:13px; }
    .mod-card { background:#fff; border:1px solid var(--border); border-radius:12px; margin-bottom:12px; overflow:hidden; }
    .mod-head { padding:14px 18px; display:flex; justify-content:space-between; align-items:center; gap:12px; cursor:pointer; }
    .mod-head:hover { background:#F8FAFC; }
    .mod-left { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .badge { padding:3px 10px; border-radius:999px; font-size:11px; font-weight:700; }
    .badge.HEALTHY { background:var(--ok-bg); color:var(--ok-fg); border:1px solid var(--ok-bd); }
    .badge.DEGRADED { background:var(--warn-bg); color:var(--warn-fg); border:1px solid var(--warn-bd); }
    .badge.DOWN { background:var(--down-bg); color:var(--down-fg); border:1px solid var(--down-bd); }
    .mod-body { display:none; padding:18px; border-top:1px solid var(--border); background:#FAFCFF; }
    .mod-card.open .mod-body { display:block; }
    .grid2 { display:grid; grid-template-columns:1.2fr 1fr; gap:16px; }
    @media(max-width:960px) { .grid2 { grid-template-columns:1fr; } }
    pre.log { background:#0F172A; color:#FCA5A5; padding:12px; border-radius:8px; font-family:'Fira Code',monospace; font-size:11.5px; overflow-x:auto; white-space:pre-wrap; margin-top:8px; }
    .shot img { width:100%; max-height:260px; object-fit:contain; border-radius:8px; border:1px solid #CBD5E1; cursor:zoom-in; background:#fff; }
    .lb { display:none; position:fixed; inset:0; background:rgba(11,25,44,0.92); z-index:9999; align-items:center; justify-content:center; flex-direction:column; gap:10px; padding:24px; }
    .lb.open { display:flex; }
    .lb img { max-width:95vw; max-height:85vh; border-radius:8px; border:2px solid #fff; }
  </style>
</head>
<body>
  <header>
    <div class="head-in">
      <div>
        <h1>Autonomous AI Product Health & Error Monitor</h1>
        <div class="sub" id="runMeta"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;" id="headPills"></div>
    </div>
  </header>
  <div class="wrap">
    <div class="target-tabs" id="targetTabs"></div>
    <div id="targetView"></div>
  </div>
  <div class="lb" id="lb" onclick="if(event.target===this)this.classList.remove('open')">
    <button style="background:#E8A230;border:none;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer;" onclick="document.getElementById('lb').classList.remove('open')">Close [ESC]</button>
    <img id="lbImg" alt="Module screenshot" />
  </div>
  <script>
    const DATA = ${jsonSafe};
    let activeTargetIdx = 0;
    let statusFilter = 'ALL';
    let q = '';

    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('lb').classList.remove('open'); });
    function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function zoom(src) { document.getElementById('lbImg').src = './screenshots/' + src; document.getElementById('lb').classList.add('open'); }

    function render() {
      const r = DATA.runReport;
      document.getElementById('runMeta').textContent = 'Run ID: ' + r.runId + ' · Executed: ' + new Date(r.timestamp).toLocaleString();
      document.getElementById('targetTabs').innerHTML = r.targets.map((t, i) =>
        '<button class="t-tab ' + (i===activeTargetIdx?'active':'') + '" onclick="activeTargetIdx=' + i + ';statusFilter=\\'ALL\\';render()">' +
        esc(t.targetName) + ' (' + t.summaryCounts.down + ' Down / ' + t.summaryCounts.degraded + ' Warn)</button>'
      ).join('');

      const t = r.targets[activeTargetIdx];
      const c = t.summaryCounts;
      const mods = t.modules.filter(m =>
        (statusFilter === 'ALL' || m.assessment.status === statusFilter) &&
        (!q || m.name.toLowerCase().includes(q) || m.expectedUrl.toLowerCase().includes(q) || JSON.stringify(m.assessment).toLowerCase().includes(q))
      );

      document.getElementById('targetView').innerHTML = \`
        <div class="stats">
          <div class="stat"><div class="stat-l">Modules Scanned</div><div class="stat-v">\${c.total}</div></div>
          <div class="stat ok"><div class="stat-l">Healthy</div><div class="stat-v">\${c.healthy}</div></div>
          <div class="stat warn"><div class="stat-l">Degraded</div><div class="stat-v">\${c.degraded}</div></div>
          <div class="stat down"><div class="stat-l">Down / Broken</div><div class="stat-v">\${c.down}</div></div>
        </div>
        <div class="ai-box">
          <h3><span>AI & Telemetry Root-Cause Diagnosis</span><span class="badge \${c.down?'DOWN':c.degraded?'DEGRADED':'HEALTHY'}">\${t.aiAnalysis.usedAI ? 'AI: ' + esc(t.aiAnalysis.model) : 'Deterministic Telemetry'}</span></h3>
          <p>\${esc(t.aiAnalysis.executiveSummary)}</p>
          \${t.aiAnalysis.systemicRootCauses.length ? '<ul>' + t.aiAnalysis.systemicRootCauses.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : ''}
        </div>
        <div class="controls">
          <div class="f-group">
            <button class="f-btn \${statusFilter==='ALL'?'active':''}" onclick="statusFilter='ALL';render()">All (\${c.total})</button>
            <button class="f-btn \${statusFilter==='DOWN'?'active':''}" onclick="statusFilter='DOWN';render()">Down (\${c.down})</button>
            <button class="f-btn \${statusFilter==='DEGRADED'?'active':''}" onclick="statusFilter='DEGRADED';render()">Degraded (\${c.degraded})</button>
            <button class="f-btn \${statusFilter==='HEALTHY'?'active':''}" onclick="statusFilter='HEALTHY';render()">Healthy (\${c.healthy})</button>
          </div>
          <input class="search" placeholder="Filter modules or errors..." value="\${esc(q)}" oninput="q=this.value.toLowerCase();render()" />
        </div>
        \${mods.map((m, i) => {
          const allErrs = [
            ...m.assessment.blockers.map(x => '[BLOCKER] ' + x),
            ...m.assessment.warnings.map(x => '[WARNING] ' + x)
          ];
          const aiNote = t.aiAnalysis.perModuleNotes[m.moduleId] || '';
          return \`
            <div class="mod-card \${m.assessment.status!=='HEALTHY' && i<3 ? 'open':''}">
              <div class="mod-head" onclick="this.parentElement.classList.toggle('open')">
                <div class="mod-left">
                  <span class="badge \${m.assessment.status}">\${m.assessment.status}</span>
                  <b>\${esc(m.name)}</b>
                  <span style="font-size:12px;color:#64748B;font-family:'Fira Code',monospace;">\${esc(m.category)} · HTTP \${m.httpStatus||'ERR'} · \${m.latencyMs}ms</span>
                </div>
                <span style="font-size:12px;color:#64748B;">\${m.assessment.blockers.length} blockers, \${m.assessment.warnings.length} warnings</span>
              </div>
              <div class="mod-body">
                <div class="grid2">
                  <div>
                    <div style="font-size:12.5px;margin-bottom:8px;"><b>URL:</b> <code>\${esc(m.finalUrl)}</code></div>
                    \${aiNote ? '<div style="background:#FFFBEB;border:1px solid #FDE68A;padding:10px;border-radius:8px;font-size:13px;margin-bottom:8px;"><b>AI Note:</b> ' + esc(aiNote) + '</div>' : ''}
                    \${m.probeResult ? '<div style="font-size:12.5px;margin-bottom:8px;"><b>Interactive Probe:</b> ' + esc(m.probeResult.note) + '</div>' : ''}
                    <pre class="log">\${allErrs.length ? esc(allErrs.join('\\n')) : 'No network, console, or DOM errors detected.'}</pre>
                  </div>
                  <div class="shot">
                    <img src="./screenshots/\${esc(m.screenshot)}" onclick="zoom('\${esc(m.screenshot)}')" alt="\${esc(m.name)}" />
                  </div>
                </div>
              </div>
            </div>\`;
        }).join('')}
      \`;
    }
    render();
  </script>
</body>
</html>`;
}

module.exports = { buildHealthDashboard };


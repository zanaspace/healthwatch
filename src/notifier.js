const fs = require('fs');
const path = require('path');

/**
 * Formats a concise human-readable feedback message across all tested targets and modules,
 * saves HEALTH_FEEDBACK.md, and optionally dispatches Slack/Teams webhooks or Resend emails.
 */
async function dispatchFeedback(runReport, latestDir, options = {}) {
  const md = formatMarkdownMessage(runReport);
  fs.writeFileSync(path.join(latestDir, 'HEALTH_FEEDBACK.md'), md, 'utf8');

  console.log('\n==================== HEALTH MONITOR DIGEST ====================');
  for (const t of runReport.targets) {
    const c = t.summaryCounts;
    console.log(`\n[${t.targetName}] HEALTHY: ${c.healthy} | DEGRADED: ${c.degraded} | DOWN: ${c.down}`);
    console.log(`Summary: ${t.aiAnalysis.executiveSummary}`);
    for (const m of t.modules) {
      const icon = m.assessment.status === 'HEALTHY' ? 'OK  ' : m.assessment.status === 'DEGRADED' ? 'WARN' : 'DOWN';
      console.log(`  [${icon}] ${m.name} (${m.latencyMs}ms) -> ${m.assessment.blockers[0] || m.assessment.warnings[0] || 'Clean'}`);
    }
  }
  console.log('===============================================================\n');

  const alertOn = (process.env.ALERT_ON_STATUS || 'DEGRADED,DOWN')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  const overallStatus = computeOverallStatus(runReport.targets);
  const shouldNotify = options.forceNotify || alertOn.includes(overallStatus);

  if (!shouldNotify) {
    console.log(`[Notifier] Overall status is ${overallStatus}; no external alert required.`);
    return;
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    await sendWebhookAlert(webhookUrl, runReport, overallStatus);
  }

  const resendKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.ALERT_EMAIL_TO || process.env.EMAIL_TO;
  const emailFrom =
    process.env.ALERT_EMAIL_FROM ||
    process.env.EMAIL_FROM ||
    'Health Monitor <onboarding@resend.dev>';
  if (resendKey && emailTo) {
    await sendResendEmail(resendKey, emailFrom, emailTo, runReport, overallStatus, md);
  }
}

function computeOverallStatus(targets) {
  if (targets.some(t => t.summaryCounts.down > 0)) return 'DOWN';
  if (targets.some(t => t.summaryCounts.degraded > 0)) return 'DEGRADED';
  return 'HEALTHY';
}

function formatMarkdownMessage(runReport) {
  const lines = [
    `# Automated Platform Health & Module Feedback`,
    `**Run Timestamp:** ${runReport.timestamp}`,
    `**Overall Status:** ${computeOverallStatus(runReport.targets)}`,
    ``
  ];

  for (const t of runReport.targets) {
    const c = t.summaryCounts;
    lines.push(`## ${t.targetName} (\`${t.targetId}\`)`);
    lines.push(`- **Scorecard:** ${c.healthy} Healthy | ${c.degraded} Degraded | ${c.down} Down (Total: ${c.total})`);
    lines.push(`- **Executive Summary:** ${t.aiAnalysis.executiveSummary}`);
    if (t.aiAnalysis.systemicRootCauses.length > 0) {
      lines.push(`- **Systemic Root Causes:**`);
      t.aiAnalysis.systemicRootCauses.forEach(rc => lines.push(`  - ${rc}`));
    }
    lines.push(``);
    lines.push(`| Module | Status | Latency | Errors & Feedback |`);
    lines.push(`| :--- | :---: | :---: | :--- |`);
    for (const m of t.modules) {
      const topIssues = [...m.assessment.blockers, ...m.assessment.warnings].slice(0, 2).join(' ; ') || 'All checks passed';
      const aiNote = t.aiAnalysis.perModuleNotes[m.moduleId];
      const msg = aiNote ? `${aiNote} *(Telemetry: ${topIssues})*` : topIssues;
      lines.push(`| **${m.name}** | \`${m.assessment.status}\` | ${m.latencyMs}ms | ${msg.replace(/\|/g, '/')} |`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

async function sendWebhookAlert(webhookUrl, runReport, overallStatus) {
  try {
    const lines = runReport.targets.map(t => {
      const c = t.summaryCounts;
      const downList = t.modules.filter(m => m.assessment.status === 'DOWN').map(m => m.name).join(', ');
      return `*${t.targetName}*: ${c.healthy} OK, ${c.degraded} WARN, ${c.down} DOWN\n>${t.aiAnalysis.executiveSummary}${downList ? `\nDown: ${downList}` : ''}`;
    });

    const payload = {
      text: `[${overallStatus}] CICOD / 1Gov Automated Health Check (${runReport.timestamp})\n\n${lines.join('\n\n')}`
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[Notifier] Webhook dispatched -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[Notifier] Webhook failed: ${err.message}`);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendResendEmail(apiKey, from, to, runReport, overallStatus, markdownBody) {
  try {
    const htmlRows = runReport.targets.map(t => {
      const c = t.summaryCounts;
      const causes = (t.aiAnalysis.systemicRootCauses || [])
        .map(rc => `<li>${escapeHtml(rc)}</li>`)
        .join('');
      const modRows = t.modules.map(m => {
        const bg = m.assessment.status === 'HEALTHY' ? '#ECFDF5' : m.assessment.status === 'DEGRADED' ? '#FEFCE8' : '#FEF2F2';
        const fg = m.assessment.status === 'HEALTHY' ? '#065F46' : m.assessment.status === 'DEGRADED' ? '#854D0E' : '#991B1B';
        const aiNote = t.aiAnalysis.perModuleNotes && t.aiAnalysis.perModuleNotes[m.moduleId];
        const issues = [...m.assessment.blockers, ...m.assessment.warnings].slice(0, 2).map(escapeHtml).join('<br>') || 'Clean';
        const detailHtml = aiNote
          ? `<b>${escapeHtml(aiNote)}</b><br><span style="color:#64748B;">${issues}</span>`
          : issues;
        return `<tr>
          <td style="padding:8px;border:1px solid #e2e8f0;"><b>${escapeHtml(m.name)}</b></td>
          <td style="padding:8px;border:1px solid #e2e8f0;background:${bg};color:${fg};font-weight:bold;">${m.assessment.status}</td>
          <td style="padding:8px;border:1px solid #e2e8f0;">${m.latencyMs}ms</td>
          <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px;">${detailHtml}</td>
        </tr>`;
      }).join('');
      return `<h3>${escapeHtml(t.targetName)} — ${c.healthy} Healthy | ${c.degraded} Degraded | ${c.down} Down</h3>
        <p>${escapeHtml(t.aiAnalysis.executiveSummary)}</p>
        ${causes ? `<ul>${causes}</ul>` : ''}
        <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">
          <thead><tr style="background:#0B192C;color:#fff;">
            <th style="padding:8px;text-align:left;">Module</th><th>Status</th><th>Latency</th><th style="text-align:left;">Details</th>
          </tr></thead>
          <tbody>${modRows}</tbody>
        </table>`;
    }).join('<br>');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: to.split(',').map(s => s.trim()).filter(Boolean),
        subject: `[${overallStatus}] Automated Product Health Report — ${new Date(runReport.timestamp).toLocaleString()}`,
        html: `<div style="font-family:Arial,sans-serif;"><h2>Platform Health Check (${escapeHtml(overallStatus)})</h2>${htmlRows}</div>`,
        text: markdownBody
      })
    });
    const resText = await res.text();
    if (!res.ok) {
      console.warn(`[Notifier] Resend email error HTTP ${res.status}: ${resText}`);
    } else {
      console.log(`[Notifier] Resend email sent -> HTTP ${res.status} (${resText})`);
    }
  } catch (err) {
    console.warn(`[Notifier] Resend email failed: ${err.message}`);
  }
}

module.exports = { dispatchFeedback, computeOverallStatus };


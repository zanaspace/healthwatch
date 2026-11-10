const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

/**
 * Applies deterministic telemetry rules to classify each module as HEALTHY, DEGRADED, or DOWN.
 */
function gradeModuleDeterministic(m) {
  const blockers = [];
  const warnings = [];

  if (m.navError) blockers.push(`Navigation error: ${m.navError}`);
  if (m.bouncedToLogin) blockers.push(`Session lost — bounced back to login (${m.finalUrl})`);
  if (m.httpStatus && m.httpStatus >= 400) blockers.push(`Document HTTP ${m.httpStatus} at ${m.finalUrl}`);

  if (m.domCheck.bodyLength < (m.minBodyLength || 15)) {
    blockers.push(`Blank screen rendered (body text length: ${m.domCheck.bodyLength} chars)`);
  } else if (m.minMainTextLength && m.domCheck.mainLength < m.minMainTextLength) {
    blockers.push(`Empty content panel (main text length: ${m.domCheck.mainLength} < ${m.minMainTextLength})`);
  }

  if (m.domCheck.missingExpectedTexts.length > 0) {
    blockers.push(`Missing expected UI elements: ${m.domCheck.missingExpectedTexts.join(', ')}`);
  }

  // Classify network errors into core API failures vs secondary prefetch/asset warnings
  for (const ne of m.networkErrors) {
    const label = `HTTP ${ne.status} ${ne.method} ${ne.url}${ne.count > 1 ? ` (x${ne.count})` : ''}`;
    if (ne.url.includes('favicon.ico') || ne.url.includes('_rsc=')) {
      warnings.push(label);
    } else if (ne.url.includes('/cde/document/') || ne.url.includes('/undefined/') || ne.status >= 500) {
      blockers.push(label);
    } else {
      warnings.push(label);
    }
  }

  for (const fr of m.failedRequests) {
    warnings.push(`Request failed: ${fr.url} (${fr.reason})`);
  }

  if (m.domCheck.brokenImages.length > 0) {
    warnings.push(
      `${m.domCheck.brokenImages.length} broken image(s): ${m.domCheck.brokenImages
        .map(i => i.alt || i.src || 'unnamed')
        .join(', ')}`
    );
  }

  if (m.consoleErrors.length > 0) {
    for (const ce of m.consoleErrors) {
      warnings.push(`${ce.type}: ${ce.text.slice(0, 140)}${ce.count > 1 ? ` (x${ce.count})` : ''}`);
    }
  }

  if (m.probeResult && !m.probeResult.ok) {
    warnings.push(`Interactive check failed: ${m.probeResult.note}`);
  }

  let status = 'HEALTHY';
  if (blockers.length > 0) status = 'DOWN';
  else if (warnings.length > 0) status = 'DEGRADED';

  return { status, blockers, warnings };
}

/**
 * Optionally enriches deterministic telemetry with Gemini Vision + Root-Cause Analysis.
 */
async function analyzeTargetHealth(target, moduleResults, options = {}) {
  const graded = moduleResults.map(m => ({
    ...m,
    assessment: gradeModuleDeterministic(m)
  }));

  const summaryCounts = {
    total: graded.length,
    healthy: graded.filter(g => g.assessment.status === 'HEALTHY').length,
    degraded: graded.filter(g => g.assessment.status === 'DEGRADED').length,
    down: graded.filter(g => g.assessment.status === 'DOWN').length
  };

  let aiAnalysis = {
    usedAI: false,
    model: null,
    executiveSummary: buildFallbackSummary(target.name, graded, summaryCounts),
    systemicRootCauses: detectDeterministicRootCauses(graded),
    perModuleNotes: {}
  };

  const apiKey = process.env.GEMINI_API_KEY;
  const shouldRunAI = options.useAI !== false && apiKey && apiKey.length > 15 && !apiKey.includes('dummy');

  if (!shouldRunAI) {
    if (options.useAI !== false) {
      console.log('[Analyzer] GEMINI_API_KEY not set — completed using deterministic telemetry rules.');
    }
    return { targetId: target.id, targetName: target.name, summaryCounts, modules: graded, aiAnalysis };
  }

  const configuredModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const modelCandidates = [...new Set([
    configuredModel,
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-flash-latest',
    'gemini-2.5-pro'
  ])];
  try {
    console.log(`[Analyzer:${target.id}] Sending ${graded.length} module findings to ${modelCandidates[0]}...`);
    const ai = new GoogleGenAI({ apiKey });

    // Attach compact telemetry + up to 5 screenshots of non-healthy modules for Gemini Vision
    const issueModules = graded.filter(g => g.assessment.status !== 'HEALTHY');
    const telemetryDigest = graded.map(g => ({
      moduleId: g.moduleId,
      name: g.name,
      status: g.assessment.status,
      finalUrl: g.finalUrl,
      httpStatus: g.httpStatus,
      latencyMs: g.latencyMs,
      blockers: g.assessment.blockers,
      warnings: g.assessment.warnings.slice(0, 6),
      probe: g.probeResult,
      domSnippet: g.domCheck.bodySnippet.slice(0, 260)
    }));

    const parts = [
      {
        text: `You are an expert Site Reliability & QA Engineer analyzing automated health monitor telemetry for "${target.name}".
Review the module telemetry below and the attached screenshots of failing/degraded pages.

Telemetry JSON:
${JSON.stringify(telemetryDigest, null, 2)}

Return ONLY valid JSON matching this schema:
{
  "executiveSummary": "2-3 sentence summary of overall environment health, urgent blockers, and impact.",
  "systemicRootCauses": ["bullet 1 explaining root cause across multiple modules", "..."],
  "perModuleNotes": {
    "<moduleId>": "1 concise sentence diagnosing what broke visually or functionally on this module"
  }
}`
      }
    ];

    for (const m of issueModules.slice(0, 5)) {
      if (m.screenshotPath && fs.existsSync(m.screenshotPath)) {
        const b64 = fs.readFileSync(m.screenshotPath).toString('base64');
        parts.push({ text: `Screenshot for moduleId="${m.moduleId}" (${m.name}):` });
        parts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
      }
    }

    let resp = null;
    let activeModel = modelCandidates[0];
    let lastErr = null;
    for (const candidate of modelCandidates) {
      try {
        activeModel = candidate;
        const callPromise = ai.models.generateContent({
          model: candidate,
          contents: [{ role: 'user', parts }],
          config: {
            responseMimeType: 'application/json',
            abortSignal: AbortSignal.timeout(25000)
          }
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('Request timed out after 25s'), { status: 'TIMEOUT' })), 26000)
        );
        resp = await Promise.race([callPromise, timeoutPromise]);
        break;
      } catch (candidateErr) {
        lastErr = candidateErr;
        console.warn(`[Analyzer:${target.id}] Model ${candidate} unavailable (${candidateErr.status || candidateErr.message || 'ERR'}), trying next...`);
      }
    }
    if (!resp) throw lastErr || new Error('All Gemini candidate models failed');

    const parsed = JSON.parse(resp.text);
    aiAnalysis = {
      usedAI: true,
      model: activeModel,
      executiveSummary: parsed.executiveSummary || aiAnalysis.executiveSummary,
      systemicRootCauses: Array.isArray(parsed.systemicRootCauses) && parsed.systemicRootCauses.length
        ? parsed.systemicRootCauses
        : aiAnalysis.systemicRootCauses,
      perModuleNotes: parsed.perModuleNotes || {}
    };
    console.log(`[Analyzer:${target.id}] AI root-cause diagnosis completed (${activeModel}).`);
  } catch (err) {
    console.warn(`[Analyzer:${target.id}] AI step fell back to deterministic analysis (${err.message})`);
  }

  return {
    targetId: target.id,
    targetName: target.name,
    summaryCounts,
    modules: graded,
    aiAnalysis
  };
}

function buildFallbackSummary(targetName, graded, counts) {
  if (counts.down === 0 && counts.degraded === 0) {
    return `${targetName}: All ${counts.total} monitored modules passed health checks with zero console or API errors.`;
  }
  const downNames = graded.filter(g => g.assessment.status === 'DOWN').map(g => g.name).slice(0, 4);
  return `${targetName}: ${counts.down} DOWN, ${counts.degraded} DEGRADED, ${counts.healthy} HEALTHY out of ${counts.total} modules.${downNames.length ? ` Failing modules include: ${downNames.join(', ')}.` : ''}`;
}

function detectDeterministicRootCauses(graded) {
  const causes = [];
  const allNet = graded.flatMap(g => g.networkErrors.map(n => `${n.status} ${n.url}`));
  if (allNet.some(u => u.includes('/undefined/'))) {
    causes.push('Frontend build missing API base URL env var (requests resolve to "/undefined/...", causing HTTP 404 across modules).');
  }
  if (allNet.some(u => u.includes('503 ') && u.includes('calendar'))) {
    causes.push('Calendar microservice returning HTTP 503 Service Unavailable.');
  }
  if (allNet.some(u => u.includes('404 ') && u.includes('/admin?_rsc='))) {
    causes.push('Admin navigation link points to "/admin" (404) instead of "/admin/merchant" or "/admin/tenant".');
  }
  const brokenImgTotal = graded.reduce((sum, g) => sum + g.domCheck.brokenImages.length, 0);
  if (brokenImgTotal > 0) {
    causes.push(`App rail/switcher contains ${brokenImgTotal} broken image reference(s) (naturalWidth === 0).`);
  }
  return causes;
}

module.exports = { analyzeTargetHealth };


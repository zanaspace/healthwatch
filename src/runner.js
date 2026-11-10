const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { chromium } = require('playwright-core');
const { createAuthenticatedContext } = require('./auth');
const { walkTargetModules } = require('./walker');
const { analyzeTargetHealth } = require('./analyzer');
const { buildHealthDashboard } = require('./dashboard');
const { dispatchFeedback, computeOverallStatus } = require('./notifier');

const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Parse active key=value lines and track password associations per email in order,
 * allowing clean fallback lookup when workspace root .env reuses `target3_*` keys.
 */
function parseRootWorkspaceEnv(filePath) {
  const active = {};
  const passwordByEmail = {};
  if (!fs.existsSync(filePath)) return { active, passwordByEmail };

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let currentEmail = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let val = match[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    active[key] = val;
    if (key.endsWith('_email')) {
      currentEmail = val.toLowerCase();
    } else if (key.endsWith('_password') && currentEmail && !passwordByEmail[currentEmail]) {
      passwordByEmail[currentEmail] = val;
    }
  }
  return { active, passwordByEmail };
}

function setIfEmpty(key, value) {
  if (!process.env[key] || !String(process.env[key]).trim()) {
    if (value && String(value).trim()) {
      process.env[key] = String(value).trim();
    }
  }
}

/**
 * Load HealthMonitor/.env and gracefully backfill any omitted API key or
 * staging credentials from sibling workspace .env files so the agent works
 * out of the box without duplicating secrets manually.
 */
function loadEnvironment() {
  const localEnvPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath });
  }

  const qaAppEnvPath = path.resolve(ROOT_DIR, '..', 'QATestingApp', '.env');
  if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_API_KEY.trim()) {
    const { active } = parseRootWorkspaceEnv(qaAppEnvPath);
    setIfEmpty('GEMINI_API_KEY', active.GEMINI_API_KEY);
  }

  const workspaceRootEnvPath = path.resolve(ROOT_DIR, '..', '.env');
  if (fs.existsSync(workspaceRootEnvPath)) {
    const { active, passwordByEmail } = parseRootWorkspaceEnv(workspaceRootEnvPath);
    setIfEmpty('GOV_EMAIL', active.target3_email);
    const cicodEmail = (process.env.CICOD_EMAIL || '').toLowerCase();
    const govEmail = (process.env.GOV_EMAIL || '').toLowerCase();
    setIfEmpty('CICOD_PASSWORD', passwordByEmail[cicodEmail]);
    setIfEmpty('GOV_PASSWORD', passwordByEmail[govEmail] || active.target3_password);
  }
}

function parseCliArgs(argv) {
  const opts = {
    target: 'all',
    useAI: true,
    forceNotify: false,
    strict: false,
    headed: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--target=')) {
      opts.target = arg.slice('--target='.length).trim();
    } else if (arg === '--target' && argv[i + 1]) {
      opts.target = argv[++i].trim();
    } else if (arg === '--no-ai') {
      opts.useAI = false;
    } else if (arg === '--notify') {
      opts.forceNotify = true;
    } else if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '--headed') {
      opts.headed = true;
    }
  }
  return opts;
}

function loadTargets(targetFilter) {
  const configPath = path.join(ROOT_DIR, 'config', 'targets.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const allTargets = Array.isArray(raw) ? raw : raw.targets || [];

  if (!targetFilter || targetFilter.toLowerCase() === 'all') {
    return allTargets.filter((t) => t.enabled !== false);
  }

  const wanted = targetFilter
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const selected = allTargets.filter((t) =>
    wanted.includes(String(t.id).toLowerCase())
  );
  if (selected.length === 0) {
    const available = allTargets.map((t) => t.id).join(', ');
    throw new Error(
      `Unknown --target "${targetFilter}". Available targets: ${available}`
    );
  }
  return selected;
}

function copyDirFiles(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
}

function prepareLatestDir(latestDir) {
  const latestShotsDir = path.join(latestDir, 'screenshots');
  fs.mkdirSync(latestShotsDir, { recursive: true });
  for (const entry of fs.readdirSync(latestShotsDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.unlinkSync(path.join(latestShotsDir, entry.name));
    }
  }
  return latestShotsDir;
}

function buildAuthFailureResult(target, err) {
  const loginUrl = target.auth
    ? process.env[target.auth.loginUrlEnv] || target.baseUrl
    : target.baseUrl;
  return {
    targetId: target.id,
    moduleId: 'authentication',
    name: 'Authentication & Login',
    category: 'Auth',
    expectedUrl: loginUrl,
    finalUrl: loginUrl,
    httpStatus: null,
    latencyMs: 0,
    navError: err.message,
    bouncedToLogin: true,
    domCheck: {
      title: 'Authentication Failed',
      bodyLength: 0,
      mainLength: 0,
      bodySnippet: err.stack || err.message,
      brokenImages: [],
      missingExpectedTexts: [],
    },
    minMainTextLength: 0,
    minBodyLength: 15,
    probeResult: null,
    networkErrors: [],
    failedRequests: [],
    consoleErrors: [{ type: 'auth.error', text: err.message, count: 1 }],
    screenshot: null,
    screenshotPath: null,
  };
}

async function runMonitor() {
  const startedAt = Date.now();
  loadEnvironment();
  const opts = parseCliArgs(process.argv.slice(2));
  const targets = loadTargets(opts.target);

  const runId = 'run_' + new Date().toISOString().replace(/[:.]/g, '-');
  const reportsRoot = path.join(ROOT_DIR, 'reports');
  const runDir = path.join(reportsRoot, runId);
  const runShotsDir = path.join(runDir, 'screenshots');
  const latestDir = path.join(reportsRoot, 'latest');

  fs.mkdirSync(runShotsDir, { recursive: true });

  console.log(`\n=== HealthMonitor Run ${runId} ===`);
  console.log(
    `Targets: ${targets.map((t) => t.id).join(', ')} | AI Triage: ${
      opts.useAI && process.env.GEMINI_API_KEY ? 'ENABLED' : 'DETERMINISTIC-ONLY'
    }`
  );

  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'msedge',
    headless: opts.headed ? false : process.env.HEADLESS !== 'false',
    args: ['--ignore-certificate-errors'],
  });

  const targetAnalyses = [];

  try {
    for (const target of targets) {
      console.log(`\n----------------------------------------`);
      console.log(`Target: ${target.name} (${target.id})`);
      let context = null;
      let moduleResults = [];

      try {
        context = await createAuthenticatedContext(browser, target, ROOT_DIR);
        moduleResults = await walkTargetModules(context, target, runShotsDir);
      } catch (err) {
        console.error(`[${target.id}] Fatal error during auth/walk:`, err.message);
        moduleResults = [buildAuthFailureResult(target, err)];
      } finally {
        if (context) {
          await context.close().catch(() => {});
        }
      }

      const analysis = await analyzeTargetHealth(target, moduleResults, {
        useAI: opts.useAI,
      });
      targetAnalyses.push(analysis);

      const c = analysis.summaryCounts;
      console.log(
        `[${target.id}] Summary -> Total: ${c.total} | Healthy: ${c.healthy} | Degraded: ${c.degraded} | Down: ${c.down}`
      );
      console.log(
        `[${target.id}] AI Analysis: ${
          analysis.aiAnalysis && analysis.aiAnalysis.usedAI
            ? `used ${analysis.aiAnalysis.model}`
            : 'skipped/fallback'
        }`
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const runReport = {
    runId,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    targets: targetAnalyses,
  };

  fs.writeFileSync(
    path.join(runDir, 'report.json'),
    JSON.stringify(runReport, null, 2),
    'utf8'
  );

  const latestShotsDir = prepareLatestDir(latestDir);
  copyDirFiles(runShotsDir, latestShotsDir);
  fs.writeFileSync(
    path.join(latestDir, 'report.json'),
    JSON.stringify(runReport, null, 2),
    'utf8'
  );

  buildHealthDashboard(runReport, reportsRoot, latestDir);
  await dispatchFeedback(runReport, latestDir, { forceNotify: opts.forceNotify });

  for (const artifact of ['index.html', 'HEALTH_FEEDBACK.md']) {
    const latestFile = path.join(latestDir, artifact);
    if (fs.existsSync(latestFile)) {
      fs.copyFileSync(latestFile, path.join(runDir, artifact));
    }
  }

  const overall = computeOverallStatus(targetAnalyses);
  console.log(`\n=== Run Complete (${overall}) in ${(runReport.durationMs / 1000).toFixed(1)}s ===`);
  console.log(`Dashboard: ${path.join(latestDir, 'index.html')}`);
  console.log(`Feedback:  ${path.join(latestDir, 'HEALTH_FEEDBACK.md')}`);

  if (opts.strict) {
    if (overall === 'DOWN') process.exit(2);
    if (overall === 'DEGRADED') process.exit(1);
  }
}

runMonitor().catch((err) => {
  console.error('Fatal HealthMonitor runner error:', err);
  process.exit(1);
});


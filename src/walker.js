const path = require('path');

/**
 * Walks all configured modules for a target environment and collects rich telemetry:
 * - Page HTTP response status & latency
 * - Console errors & uncaught runtime exceptions
 * - Failed network/API responses (status >= 400 or net::ERR_*)
 * - Broken images (naturalWidth === 0) & blank/empty screens
 * - Expected DOM text assertions & optional safe interactive probes
 * - Visual screenshot evidence
 */
async function walkTargetModules(context, target, runShotsDir) {
  const page = await context.newPage();
  const ignorePatterns = target.ignoreUrls || [];
  const shouldIgnore = (url, text = '') =>
    ignorePatterns.some(p => url.includes(p) || text.includes(p)) ||
    text.includes('Sign In Refresh Required');

  let activeModuleId = null;
  let activeNetErrors = [];
  let activeFailedReqs = [];
  let activeConsoleErrors = [];

  page.on('response', (res) => {
    if (!activeModuleId) return;
    const status = res.status();
    const url = res.url();
    if (status >= 400 && !shouldIgnore(url)) {
      activeNetErrors.push({
        status,
        method: res.request().method(),
        resourceType: res.request().resourceType(),
        url
      });
    }
  });

  page.on('requestfailed', (req) => {
    if (!activeModuleId) return;
    const url = req.url();
    if (!shouldIgnore(url)) {
      activeFailedReqs.push({
        method: req.method(),
        url,
        reason: req.failure()?.errorText || 'Request failed'
      });
    }
  });

  page.on('console', (msg) => {
    if (!activeModuleId || msg.type() !== 'error') return;
    const text = msg.text();
    if (!shouldIgnore('', text)) {
      activeConsoleErrors.push({ type: 'console.error', text: text.slice(0, 400) });
    }
  });

  page.on('pageerror', (err) => {
    if (!activeModuleId) return;
    activeConsoleErrors.push({ type: 'uncaught.pageerror', text: String(err.message || err).slice(0, 400) });
  });

  const moduleResults = [];

  for (const mod of target.modules) {
    activeModuleId = mod.id;
    activeNetErrors = [];
    activeFailedReqs = [];
    activeConsoleErrors = [];

    console.log(`[Walk:${target.id}] Checking ${mod.name} -> ${mod.url}`);
    const t0 = Date.now();
    let httpStatus = null;
    let navError = null;

    try {
      const resp = await page.goto(mod.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      httpStatus = resp ? resp.status() : null;
      await page.waitForTimeout(mod.waitMs || 3500);
    } catch (err) {
      navError = err.message;
    }

    const latencyMs = Date.now() - t0;
    const finalUrl = page.url();
    const bouncedToLogin = target.auth.authFailurePatterns.some(p => finalUrl.includes(p));

    // DOM Inspection
    let domCheck = {
      title: '',
      bodyLength: 0,
      mainLength: 0,
      bodySnippet: '',
      brokenImages: [],
      missingExpectedTexts: [],
      selfLoopLinks: []
    };

    try {
      domCheck = await page.evaluate((expectedList) => {
        const title = document.title || '';
        const bodyText = (document.body?.innerText || '').trim();
        const mainEl = document.querySelector('main') || document.body;
        const mainText = (mainEl?.innerText || '').trim();

        const brokenImages = Array.from(document.querySelectorAll('img'))
          .filter(img => !img.complete || img.naturalWidth === 0)
          .map(img => ({ alt: img.getAttribute('alt') || '', src: img.getAttribute('src') || null }));

        const bodyLower = bodyText.toLowerCase();
        const missingExpectedTexts = (expectedList || []).filter(
          t => !bodyLower.includes(String(t).toLowerCase())
        );

        return {
          title,
          bodyLength: bodyText.length,
          mainLength: mainText.length,
          bodySnippet: bodyText.slice(0, 900),
          brokenImages,
          missingExpectedTexts
        };
      }, mod.expectedTexts || []);
    } catch (e) {
      navError = navError || `DOM evaluation failed: ${e.message}`;
    }

    // Optional safe interactive probe
    let probeResult = null;
    if (mod.probe && !bouncedToLogin && !navError) {
      try {
        probeResult = await runSafeProbe(page, mod.probe);
      } catch (e) {
        probeResult = { ok: false, note: `Probe error: ${e.message}` };
      }
    }

    // Capture screenshot
    const shotName = `${target.id}__${mod.id}.png`;
    const shotPath = path.join(runShotsDir, shotName);
    try {
      await page.screenshot({ path: shotPath, fullPage: false });
    } catch (_) {}

    // Deduplicate identical 404/5xx URLs per module while preserving count
    const dedupNet = deduplicateErrors(activeNetErrors, e => `${e.status}|${e.url}`);
    const dedupConsole = deduplicateErrors(activeConsoleErrors, e => `${e.type}|${e.text.slice(0, 120)}`);

    moduleResults.push({
      targetId: target.id,
      moduleId: mod.id,
      name: mod.name,
      category: mod.category,
      expectedUrl: mod.url,
      finalUrl,
      httpStatus,
      latencyMs,
      navError,
      bouncedToLogin,
      domCheck,
      minMainTextLength: mod.minMainTextLength || 0,
      minBodyLength: mod.minBodyLength || 15,
      probeResult,
      networkErrors: dedupNet,
      failedRequests: activeFailedReqs,
      consoleErrors: dedupConsole,
      screenshot: shotName,
      screenshotPath: shotPath
    });
  }

  activeModuleId = null;
  await page.close();
  return moduleResults;
}

async function runSafeProbe(page, probe) {
  const el = page.locator(probe.selector).first();
  const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
  if (!visible) return { ok: false, note: `Control '${probe.selector}' not visible` };

  await el.click({ timeout: 3000 });
  await page.waitForTimeout(1000);

  const items = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="listbox"] *'))
      .map(e => (e.innerText || '').trim())
      .filter(Boolean);
  });
  const uniqueItems = [...new Set(items)];
  await page.keyboard.press('Escape').catch(() => {});

  return {
    ok: uniqueItems.length > 0,
    optionsCount: uniqueItems.length,
    sampleOptions: uniqueItems.slice(0, 10),
    note: uniqueItems.length > 0
      ? `Interactive dropdown opened with ${uniqueItems.length} item(s)`
      : `Control clicked but dropdown/menu rendered 0 items`
  };
}

function deduplicateErrors(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (map.has(k)) {
      map.get(k).count += 1;
    } else {
      map.set(k, { ...item, count: 1 });
    }
  }
  return Array.from(map.values());
}

module.exports = { walkTargetModules };


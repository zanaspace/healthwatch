const fs = require('fs');
const path = require('path');

/**
 * Authenticates against a CICOD or 1Gov tenant portal and returns a Playwright BrowserContext
 * with valid session cookies/storage persisted.
 */
async function createAuthenticatedContext(browser, target, rootDir) {
  const auth = target.auth;
  const sessionPath = path.join(rootDir, auth.sessionFile);
  const loginUrl = process.env[auth.loginUrlEnv];
  const tenant = process.env[auth.tenantEnv];
  const email = process.env[auth.emailEnv];
  const password = process.env[auth.passwordEnv];

  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

  // Try saved session first if available
  if (fs.existsSync(sessionPath)) {
    try {
      const ctx = await browser.newContext({
        storageState: sessionPath,
        viewport: { width: 1600, height: 1100 },
        ignoreHTTPSErrors: true
      });
      const testPage = await ctx.newPage();
      await testPage.goto(target.baseUrl + auth.verifyUrlPath, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await testPage.waitForTimeout(3500);
      const landedUrl = testPage.url();
      await testPage.close();

      const bouncedToLogin = auth.authFailurePatterns.some(p => landedUrl.includes(p));
      if (!bouncedToLogin) {
        console.log(`[Auth] Reused valid session for ${target.id} -> ${landedUrl}`);
        return ctx;
      }
      console.log(`[Auth] Saved session expired for ${target.id}, re-authenticating...`);
      await ctx.close();
    } catch (err) {
      console.log(`[Auth] Could not reuse session (${err.message}), performing fresh login...`);
    }
  }

  if (!loginUrl || !email || !password) {
    throw new Error(
      `Missing credentials for target '${target.id}'. Check ${auth.loginUrlEnv}, ${auth.emailEnv}, and ${auth.passwordEnv} in .env`
    );
  }

  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    ignoreHTTPSErrors: true
  });
  const page = await ctx.newPage();

  console.log(`[Auth] Logging into ${loginUrl} (tenant: ${tenant || 'default'})...`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Dismiss cookie consent banner if present
  try {
    const acceptBtn = page.locator('button:has-text("Accept")').first();
    if (await acceptBtn.isVisible({ timeout: 1000 })) {
      await acceptBtn.click();
    }
  } catch (_) {}

  if (tenant) {
    const tenantInput = page.locator(auth.selectors.tenant).first();
    await tenantInput.waitFor({ state: 'visible', timeout: 10000 });
    const isReadOnly = (await tenantInput.getAttribute('readonly')) !== null;
    const isEditable = await tenantInput.isEditable().catch(() => !isReadOnly);
    if (!isReadOnly && isEditable) {
      await tenantInput.fill(tenant);
    }
  }

  const emailInput = page.locator(auth.selectors.email).first();
  await emailInput.waitFor({ state: 'visible', timeout: 10000 });
  await emailInput.fill(email);

  const passInput = page.locator(auth.selectors.password).first();
  await passInput.fill(password);

  const submitBtn = page.locator(auth.selectors.submit).first();
  await submitBtn.click();

  // Wait up to 15s for redirect away from login page
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await page.waitForTimeout(1000);
    const urlNow = page.url();
    if (!auth.authFailurePatterns.some(p => urlNow.includes(p))) {
      break;
    }
  }

  // Wait briefly for SSO tokens/cookies to settle
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  if (auth.authFailurePatterns.some(p => finalUrl.includes(p))) {
    await page.close();
    await ctx.close();
    throw new Error(`Authentication failed for ${target.id} — still at ${finalUrl}`);
  }

  await ctx.storageState({ path: sessionPath });
  console.log(`[Auth] Authenticated cleanly -> ${finalUrl} (session saved)`);
  await page.close();
  return ctx;
}

module.exports = { createAuthenticatedContext };


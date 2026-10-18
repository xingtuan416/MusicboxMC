const { _electron } = require('playwright-core');
const { mkdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * Verify the About version against a real launch.
 *
 * The screen showed 33.4.11 because `app.getVersion()` reports Electron's own version when
 * the application is not packaged. That claim is checked here from both sides: what Electron
 * says, and what the interface then shows.
 *
 * `ELECTRON_RUN_AS_NODE` has to be cleared. When it is set, the Electron binary runs as
 * plain Node, `require('electron')` yields the npm package's path string instead of the API,
 * and `app` is undefined - which is exactly how an earlier probe failed.
 */
(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const problems = [];
  // The screenshots below assume this exists; a fresh clone has no out/ at all.
  mkdirSync(resolve('out/ui-shots'), { recursive: true });
  const electronApp = await _electron.launch({
    args: [resolve('dist/src/main/index.js')],
    env,
  });

  try {
    const raw = await electronApp.evaluate(({ app }) => ({
      getVersion: app.getVersion(),
      getAppPath: app.getAppPath(),
      packaged: app.isPackaged,
    }));
    console.log('main process reports:', JSON.stringify(raw));

    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600);

    // An <img> with a broken src still exists and still reports a box, so ask the image
    // whether it actually loaded. Then screenshot the title bar and look at it.
    const icon = await page.evaluate(() => {
      const image = document.querySelector('.brand-icon');
      return image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    });
    if (!icon || icon.width === 0) {
      problems.push('the title bar icon did not load: ' + JSON.stringify(icon));
    } else {
      console.log('title bar icon loaded:', icon.width + 'x' + icon.height);
    }
    await page.screenshot({ path: resolve('out/ui-shots/10-titlebar.png') });

    await page.locator('#btnOpenSettings').click();
    await page.waitForFunction(() => document.getElementById('aboutVersion').textContent !== '—', {
      timeout: 10000,
    });

    const shown = await page.evaluate(() => ({
      version: document.getElementById('aboutVersion').textContent,
      license: document.getElementById('aboutLicense').textContent,
      author: document.getElementById('aboutAuthor').textContent,
    }));
    console.log('About section shows:', JSON.stringify(shown));
    await page.screenshot({ path: resolve('out/ui-shots/9-about.png') });

    // Read from the manifest rather than hardcoding it: the last release bumped the
    // version and this check failed for a reason that had nothing to do with the app.
    const expectedVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
    if (shown.version !== expectedVersion) {
      problems.push('About shows version ' + shown.version + ', expected ' + expectedVersion);
    }
    if (shown.version === raw.getVersion) {
      problems.push('About still shows the value app.getVersion() returns, not the manifest');
    }
    if (shown.license !== 'GPL-3.0') {
      problems.push('About shows licence ' + shown.license + ', expected GPL-3.0');
    }

    console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'About section is correct');
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
